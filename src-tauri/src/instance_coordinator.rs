use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

const HEARTBEAT_SECS: u64 = 20;

const STALE_SECS: u64 = 90;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_instance_id() -> String {
    format!("{}-{}", std::process::id(), now_millis())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceInfo {
    pub instance_id: String,
    pub pid: u32,
    pub port: u16,
    pub last_focused: u64,
    pub started_at: u64,
    pub sub_windows: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstanceRegistry {
    instances: HashMap<String, InstanceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum CoordinatorCommand {
    OpenRepo { path: String },
    OpenCloneWindow { destination: Option<String> },
    FocusWindow { label: String },
    SettingsUpdated,
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CoordinatorReply {
    ok: bool,
    message: String,
}

#[derive(Debug, Clone)]
struct CoordinatorHandle {
    instance_id: String,
    registry_path: std::path::PathBuf,
    port: u16,
}

static COORDINATOR: std::sync::OnceLock<Mutex<CoordinatorHandle>> = std::sync::OnceLock::new();

fn with_handle<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&CoordinatorHandle) -> Result<R, String>,
{
    let guard = COORDINATOR
        .get()
        .ok_or_else(|| "Coordinator not initialised".to_string())?;
    let handle = guard
        .lock()
        .map_err(|_| "Coordinator lock poisoned".to_string())?;
    f(&handle)
}

fn read_registry(path: &std::path::Path) -> InstanceRegistry {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<InstanceRegistry>(&t).ok())
        .unwrap_or(InstanceRegistry {
            instances: HashMap::new(),
        })
}

fn write_registry(path: &std::path::Path, reg: &InstanceRegistry) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let json = serde_json::to_string(reg).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn with_registry_lock<F, R>(path: &std::path::Path, f: F) -> Result<R, String>
where
    F: FnOnce() -> Result<R, String>,
{
    let lock_path = path.with_extension("lock");
    let start = std::time::Instant::now();
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if start.elapsed() > Duration::from_secs(3) {
                    let _ = std::fs::remove_file(&lock_path);
                    continue;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    let result = f();
    let _ = std::fs::remove_file(lock_path);
    result
}

fn mutate_registry<F>(f: F)
where
    F: FnOnce(&mut InstanceRegistry),
{
    let path = match with_handle(|h| Ok(h.registry_path.clone())) {
        Ok(p) => p,
        Err(_) => return,
    };
    let _ = with_registry_lock(&path, || {
        let mut reg = read_registry(&path);
        f(&mut reg);
        write_registry(&path, &reg)
    });
}

pub fn init(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("create config dir: {e}"))?;

    let registry_path = config_dir.join("instance-registry.json");
    let instance_id = new_instance_id();

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("nonblocking: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local addr: {e}"))?
        .port();

    let handle = CoordinatorHandle {
        instance_id: instance_id.clone(),
        registry_path,
        port,
    };

    COORDINATOR
        .set(Mutex::new(handle.clone()))
        .map_err(|_| "Already initialised".to_string())?;

    register_self(&handle)?;

    let app = app_handle.clone();
    thread::spawn(move || accept_loop(listener, app));

    let hb_handle = handle;
    thread::spawn(move || heartbeat_loop(hb_handle));

    prune_stale();

    Ok(())
}

pub fn deregister() {
    mutate_registry(|reg| {
        if let Ok(handle) = with_handle(|h| Ok(h.instance_id.clone())) {
            reg.instances.remove(&handle);
            let our_pid = std::process::id();
            reg.instances.retain(|_, info| info.pid != our_pid);
        }
    });
}

fn heartbeat_loop(handle: CoordinatorHandle) {
    loop {
        thread::sleep(Duration::from_secs(HEARTBEAT_SECS));
        let _ = register_self(&handle);
    }
}

fn register_self(handle: &CoordinatorHandle) -> Result<(), String> {
    let now = now_millis();
    let sub_windows = {
        let reg = read_registry(&handle.registry_path);
        reg.instances
            .get(&handle.instance_id)
            .map(|info| info.sub_windows.clone())
            .unwrap_or_default()
    };

    mutate_registry(|reg| {
        let is_new = !reg.instances.contains_key(&handle.instance_id);
        let last_focused = reg
            .instances
            .get(&handle.instance_id)
            .map(|info| info.last_focused)
            .unwrap_or(now);

        reg.instances.insert(
            handle.instance_id.clone(),
            InstanceInfo {
                instance_id: handle.instance_id.clone(),
                pid: std::process::id(),
                port: handle.port,
                last_focused: if is_new { now } else { last_focused },
                started_at: if is_new {
                    now
                } else {
                    reg.instances
                        .get(&handle.instance_id)
                        .map(|i| i.started_at)
                        .unwrap_or(now)
                },
                sub_windows,
            },
        );
    });
    Ok(())
}

fn prune_stale() {
    let cutoff = now_millis().saturating_sub(STALE_SECS * 1000);
    mutate_registry(|reg| {
        reg.instances
            .retain(|_, info| info.last_focused >= cutoff || info.started_at >= cutoff);
    });
}

fn accept_loop(listener: TcpListener, app_handle: tauri::AppHandle) {
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                let app = app_handle.clone();
                thread::spawn(move || handle_connection(stream, app));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(150));
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

fn handle_connection(mut stream: TcpStream, app: tauri::AppHandle) {
    let mut buf = [0u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let raw = String::from_utf8_lossy(&buf[..n]);
    let body = raw
        .find("\r\n\r\n")
        .map(|idx| raw[idx + 4..].trim().to_string())
        .unwrap_or_default();

    let cmd: CoordinatorCommand = match serde_json::from_str(&body) {
        Ok(c) => c,
        Err(e) => {
            respond(&mut stream, 400, &format!("Bad JSON: {e}"));
            return;
        }
    };

    let (ok, msg) = process_command(cmd, &app);
    respond(&mut stream, if ok { 200 } else { 500 }, &msg);
}

fn process_command(cmd: CoordinatorCommand, app: &tauri::AppHandle) -> (bool, String) {
    match cmd {
        CoordinatorCommand::OpenRepo { path } => {
            let _ = app.emit("instance-open-repo", path.clone());
            (true, path)
        }
        CoordinatorCommand::OpenCloneWindow { destination } => {
            if let Some(path) = destination.clone() {
                if let Some(state) = app.try_state::<crate::PendingCloneDestination>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(path.clone());
                    }
                }
                let _ = app.emit("clone-destination-updated", path);
            }
            if let Some(w) = app.get_webview_window("clone-repository") {
                let _ = w.show();
                let _ = w.set_focus();
                (true, "focused".into())
            } else {
                (false, "clone window not found".into())
            }
        }
        CoordinatorCommand::FocusWindow { label } => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.show();
                let _ = w.set_focus();
                (true, "focused".into())
            } else {
                (false, "window not found".into())
            }
        }
        CoordinatorCommand::SettingsUpdated => {
            let _ = app.emit("instance-settings-updated", ());
            (true, "ok".into())
        }
        CoordinatorCommand::Ping => (true, "pong".into()),
    }
}

fn respond(stream: &mut TcpStream, status: u16, msg: &str) {
    let reason = if status == 200 {
        "OK"
    } else if status == 400 {
        "Bad Request"
    } else {
        "Internal Server Error"
    };
    let body = serde_json::to_string(&CoordinatorReply {
        ok: status == 200,
        message: msg.to_string(),
    })
    .unwrap_or_else(|_| "{\"ok\":false,\"message\":\"response serialisation failed\"}".to_string());
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

pub fn notify_focused() {
    mutate_registry(|reg| {
        let own_id = with_handle(|h| Ok(h.instance_id.clone())).unwrap_or_default();
        if let Some(info) = reg.instances.get_mut(&own_id) {
            info.last_focused = now_millis();
        }
    });
}

pub fn register_sub_window(label: &str) {
    mutate_registry(|reg| {
        let own_id = with_handle(|h| Ok(h.instance_id.clone())).unwrap_or_default();
        if let Some(info) = reg.instances.get_mut(&own_id) {
            if !info.sub_windows.contains(&label.to_string()) {
                info.sub_windows.push(label.to_string());
            }
        }
    });
}

pub fn unregister_sub_window(label: &str) {
    mutate_registry(|reg| {
        let own_id = with_handle(|h| Ok(h.instance_id.clone())).unwrap_or_default();
        if let Some(info) = reg.instances.get_mut(&own_id) {
            info.sub_windows.retain(|w| w != label);
        }
    });
}

pub fn find_sub_window_owner(label: &str) -> Option<InstanceInfo> {
    let path = with_handle(|h| Ok(h.registry_path.clone())).ok()?;
    let reg = read_registry(&path);
    let cutoff = now_millis().saturating_sub(STALE_SECS * 1000);

    for info in reg.instances.values() {
        if info.sub_windows.contains(&label.to_string()) && info.last_focused >= cutoff {
            return Some(info.clone());
        }
    }
    None
}

pub fn send_command(target_port: u16, cmd: &CoordinatorCommand) -> Result<(), String> {
    let json = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
    let req = format!(
        "POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        target_port,
        json.len(),
        json,
    );

    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{target_port}")
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())?,
        Duration::from_secs(2),
    )
    .map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&buf[..n]);
    let status_ok = raw.starts_with("HTTP/1.1 200");
    let body = raw
        .find("\r\n\r\n")
        .map(|idx| raw[idx + 4..].trim())
        .unwrap_or_default();
    let reply = serde_json::from_str::<CoordinatorReply>(body).ok();
    if status_ok && reply.as_ref().is_none_or(|r| r.ok) {
        Ok(())
    } else {
        Err(reply
            .map(|r| r.message)
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "Coordinator command failed".to_string()))
    }
}

pub fn broadcast_settings_updated() {
    let path = match with_handle(|h| Ok(h.registry_path.clone())) {
        Ok(p) => p,
        Err(_) => return,
    };
    let own_id = match with_handle(|h| Ok(h.instance_id.clone())) {
        Ok(id) => id,
        Err(_) => return,
    };
    let cutoff = now_millis().saturating_sub(STALE_SECS * 1000);
    let reg = read_registry(&path);

    for (id, info) in &reg.instances {
        if *id == own_id || info.last_focused < cutoff {
            continue;
        }
        let _ = send_command(info.port, &CoordinatorCommand::SettingsUpdated);
    }
}

pub fn spawn_new_instance_open_repo(path: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("exe path: {e}"))?;
    std::process::Command::new(exe)
        .arg("--open")
        .arg(path)
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    Ok(())
}
