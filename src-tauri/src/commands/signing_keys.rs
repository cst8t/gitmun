use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

const UNAVAILABLE: &str = "GITMUN_ERROR_GPG_UNAVAILABLE";
const FAILED: &str = "GITMUN_ERROR_GPG_LIST_FAILED";
const TIMEOUT: &str = "GITMUN_ERROR_GPG_LIST_TIMEOUT";
const CANCELLED: &str = "GITMUN_ERROR_GPG_LIST_CANCELLED";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpgSigningKeysRequest {
    repo_path: String,
    request_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GpgSigningKey {
    fingerprint: String,
    user_ids: Vec<String>,
    expires_at: Option<u64>,
    hardware_backed: bool,
}

struct Listing {
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct GpgKeyListingManager {
    listings: Mutex<HashMap<String, Listing>>,
}

impl GpgKeyListingManager {
    fn start(&self, window: &str, request_id: &str) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut listings = self.listings.lock().unwrap();
        if let Some(previous) = listings.insert(
            window.to_string(),
            Listing {
                request_id: request_id.to_string(),
                cancelled: cancelled.clone(),
            },
        ) {
            previous.cancelled.store(true, Ordering::SeqCst);
        }
        cancelled
    }

    fn cancel(&self, window: &str, request_id: &str) {
        let listings = self.listings.lock().unwrap();
        if let Some(listing) = listings
            .get(window)
            .filter(|listing| listing.request_id == request_id)
        {
            listing.cancelled.store(true, Ordering::SeqCst);
        }
    }

    fn finish(&self, window: &str, request_id: &str) {
        let mut listings = self.listings.lock().unwrap();
        if listings
            .get(window)
            .is_some_and(|listing| listing.request_id == request_id)
        {
            listings.remove(window);
        }
    }

    pub fn cancel_window(&self, window: &str) {
        if let Some(listing) = self.listings.lock().unwrap().remove(window) {
            listing.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub async fn list_gpg_signing_keys(
    request: GpgSigningKeysRequest,
    window: tauri::Window,
    manager: State<'_, Arc<GpgKeyListingManager>>,
) -> Result<Vec<GpgSigningKey>, String> {
    let label = window.label().to_string();
    let cancelled = manager.start(&label, &request.request_id);
    let request_id = request.request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let program = super::gpg_program::configured_gpg_program(&request.repo_path);
        run_listing(&program, &cancelled, Duration::from_secs(15))
    })
    .await
    .map_err(|_| FAILED.to_string());
    manager.finish(&label, &request_id);
    result?
}

#[tauri::command]
pub fn cancel_gpg_signing_keys(
    request_id: String,
    window: tauri::Window,
    manager: State<'_, Arc<GpgKeyListingManager>>,
) -> Result<(), String> {
    manager.cancel(window.label(), &request_id);
    Ok(())
}

fn run_listing(
    program: &str,
    cancelled: &AtomicBool,
    deadline: Duration,
) -> Result<Vec<GpgSigningKey>, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(CANCELLED.to_string());
    }
    let mut command = Command::new(program);
    crate::configure_command(&mut command);
    let mut child = command
        .args([
            "--batch",
            "--no-tty",
            "--with-colons",
            "--with-fingerprint",
            "--with-subkey-fingerprint",
            "--list-secret-keys",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                UNAVAILABLE
            } else {
                FAILED
            }
            .to_string()
        })?;
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut contents = Vec::new();
        drop(sender.send(stdout.read_to_end(&mut contents).map(|_| contents)));
    });
    let start = Instant::now();
    let mut exited = false;
    loop {
        let error = if cancelled.load(Ordering::SeqCst) {
            Some(CANCELLED)
        } else if start.elapsed() >= deadline {
            Some(TIMEOUT)
        } else {
            None
        };
        if let Some(error) = error {
            drop(child.kill());
            drop(child.wait());
            return Err(error.to_string());
        }
        if exited {
            match receiver.try_recv() {
                Ok(Ok(output)) => {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    return Ok(parse_keys(&output, now));
                }
                Ok(Err(_)) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err(FAILED.to_string());
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
            }
            continue;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(FAILED.to_string());
                }
                exited = true;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                drop(child.kill());
                drop(child.wait());
                return Err(FAILED.to_string());
            }
        }
    }
}

#[derive(Default)]
struct PendingKey {
    fingerprint: String,
    user_ids: Vec<String>,
    expires_at: Option<u64>,
    valid: bool,
    signing: bool,
    hardware_backed: bool,
    awaiting_primary_fingerprint: bool,
}

fn usable(fields: &[&str], now: u64) -> bool {
    let validity = fields.get(1).copied().unwrap_or("");
    let expiry = fields.get(6).and_then(|value| value.parse::<u64>().ok());
    !validity
        .chars()
        .any(|value| matches!(value, 'r' | 'e' | 'd' | 'i'))
        && expiry.is_none_or(|value| value == 0 || value > now)
}

fn signing_material(fields: &[&str], now: u64) -> (bool, bool) {
    let capabilities = fields.get(11).copied().unwrap_or("");
    let token = fields.get(14).copied().unwrap_or("");
    let available = token != "#" && !capabilities.contains('D');
    let signing = usable(fields, now) && available && capabilities.contains('s');
    (signing, signing && !token.is_empty() && token != "+")
}

fn parse_keys(contents: &[u8], now: u64) -> Vec<GpgSigningKey> {
    let text = String::from_utf8_lossy(contents);
    let mut keys = Vec::new();
    let mut current: Option<PendingKey> = None;
    let finish = |current: Option<PendingKey>, keys: &mut Vec<GpgSigningKey>| {
        if let Some(key) =
            current.filter(|key| key.valid && key.signing && !key.fingerprint.is_empty())
        {
            keys.push(GpgSigningKey {
                fingerprint: key.fingerprint,
                user_ids: key.user_ids,
                expires_at: key.expires_at,
                hardware_backed: key.hardware_backed,
            });
        }
    };
    for line in text.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        match fields.first().copied().unwrap_or("") {
            "sec" => {
                finish(current.take(), &mut keys);
                let (signing, hardware_backed) = signing_material(&fields, now);
                current = Some(PendingKey {
                    valid: usable(&fields, now)
                        && !fields.get(11).copied().unwrap_or("").contains('D'),
                    expires_at: fields
                        .get(6)
                        .and_then(|value| value.parse::<u64>().ok())
                        .filter(|value| *value != 0),
                    signing,
                    hardware_backed,
                    awaiting_primary_fingerprint: true,
                    ..Default::default()
                });
            }
            "ssb" => {
                if let Some(key) = &mut current {
                    let (signing, hardware) = signing_material(&fields, now);
                    key.signing |= signing;
                    key.hardware_backed |= hardware;
                    key.awaiting_primary_fingerprint = false;
                }
            }
            "fpr" => {
                if let Some(key) = &mut current {
                    if key.awaiting_primary_fingerprint {
                        key.fingerprint = fields.get(9).copied().unwrap_or("").to_string();
                        key.awaiting_primary_fingerprint = false;
                    }
                }
            }
            "uid" => {
                if let Some(key) = &mut current {
                    if usable(&fields, now) {
                        if let Some(value) = fields.get(9) {
                            key.user_ids.push(decode_identity(value));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    finish(current, &mut keys);
    keys
}

fn decode_identity(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 1 < bytes.len() {
            let escaped = match bytes[index + 1] {
                b'\\' => Some(b'\\'),
                b'n' => Some(b'\n'),
                b'r' => Some(b'\r'),
                b't' => Some(b'\t'),
                b'b' => Some(8),
                b'f' => Some(12),
                b'v' => Some(11),
                _ => None,
            };
            if let Some(byte) = escaped {
                decoded.push(byte);
                index += 2;
                continue;
            }
        }
        if bytes[index] == b'\\' && bytes.get(index + 1) == Some(&b'x') && index + 3 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 2..index + 4]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 4;
                    continue;
                }
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        kind: &str,
        validity: &str,
        expiry: &str,
        value: &str,
        capabilities: &str,
        token: &str,
    ) -> String {
        let mut fields = vec![""; 16];
        fields[0] = kind;
        fields[1] = validity;
        fields[6] = expiry;
        fields[9] = value;
        fields[11] = capabilities;
        fields[14] = token;
        fields.join(":") + "\n"
    }

    #[test]
    fn parses_usable_primary_and_hardware_subkey_with_escaped_identity() {
        let records = [
            record("sec", "u", "", "", "cSC", "#"),
            record("fpr", "", "", "PRIMARY", "", ""),
            record(
                "uid",
                "u",
                "",
                r"Jos\xc3\xa9\x3a Example <a@example.com>",
                "",
                "",
            ),
            record("ssb", "u", "200", "", "s", "D27600012401"),
            record("fpr", "", "", "SUBKEY", "", ""),
        ]
        .concat();
        assert_eq!(
            parse_keys(records.as_bytes(), 100),
            vec![GpgSigningKey {
                fingerprint: "PRIMARY".into(),
                user_ids: vec!["José: Example <a@example.com>".into()],
                expires_at: None,
                hardware_backed: true,
            }]
        );
    }

    #[test]
    fn excludes_invalid_and_unavailable_signers() {
        let mut records = String::new();
        for (validity, expiry, capabilities, token) in [
            ("r", "", "s", "+"),
            ("e", "", "s", "+"),
            ("d", "", "s", "+"),
            ("u", "99", "s", "+"),
            ("u", "", "e", "+"),
            ("u", "", "s", "#"),
            ("u", "", "sD", "+"),
        ] {
            records.push_str(&record("sec", validity, expiry, "", capabilities, token));
            records.push_str(&record("fpr", "", "", "FINGERPRINT", "", ""));
        }
        assert!(parse_keys(records.as_bytes(), 100).is_empty());
    }

    #[test]
    fn excludes_invalid_subkeys_but_keeps_a_usable_primary() {
        let records = [
            record("sec", "u", "200", "", "s", "+"),
            record("fpr", "", "", "PRIMARY", "", ""),
            record("ssb", "r", "", "", "s", "HARDWARE"),
        ]
        .concat();
        let keys = parse_keys(records.as_bytes(), 100);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].expires_at, Some(200));
        assert!(!keys[0].hardware_backed);
    }

    #[test]
    fn unavailable_and_failed_programs_return_stable_errors() {
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            run_listing(
                "/nonexistent/gitmun-gpg",
                &cancelled,
                Duration::from_secs(1)
            ),
            Err(UNAVAILABLE.into())
        );
        #[cfg(unix)]
        assert_eq!(
            run_listing("/bin/false", &cancelled, Duration::from_secs(1)),
            Err(FAILED.into())
        );
    }

    #[test]
    fn cancellation_is_scoped_to_the_matching_request() {
        let manager = GpgKeyListingManager::default();
        let first = manager.start("main", "first");
        let second = manager.start("main", "second");
        assert!(first.load(Ordering::SeqCst));
        manager.cancel("main", "first");
        assert!(!second.load(Ordering::SeqCst));
        manager.finish("main", "first");
        manager.cancel_window("main");
        assert!(second.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_and_cancellation_stop_the_child() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("slow-gpg");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let program = script.to_str().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        assert_eq!(
            run_listing(program, &cancelled, Duration::from_millis(50)),
            Err(TIMEOUT.into())
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        let trigger = cancelled.clone();
        let cancellation = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            trigger.store(true, Ordering::SeqCst);
        });
        assert_eq!(
            run_listing(program, &cancelled, Duration::from_secs(3)),
            Err(CANCELLED.into())
        );
        cancellation.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn lists_a_real_disposable_gpg_keyring_when_available() {
        use std::os::unix::fs::PermissionsExt;
        if Command::new("gpg")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("gnupg");
        std::fs::create_dir(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let output = Command::new("gpg")
            .args([
                "--homedir",
                home.to_str().unwrap(),
                "--batch",
                "--pinentry-mode",
                "loopback",
                "--passphrase",
                "",
                "--quick-generate-key",
                "Gitmun Test <gitmun-test@example.invalid>",
                "ed25519",
                "sign",
                "0",
            ])
            .stdout(Stdio::null())
            .output()
            .unwrap();
        if !output.status.success()
            && String::from_utf8_lossy(&output.stderr).contains("No agent running")
        {
            eprintln!("Skipping disposable GPG keyring test: gpg-agent is unavailable");
            return;
        }
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let script = directory.path().join("gpg-test");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nGNUPGHOME='{}' exec gpg \"$@\"\n",
                home.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = run_listing(
            script.to_str().unwrap(),
            &AtomicBool::new(false),
            Duration::from_secs(10),
        );
        drop(
            Command::new("gpgconf")
                .args(["--homedir", home.to_str().unwrap(), "--kill", "gpg-agent"])
                .status(),
        );
        let keys = result.unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].fingerprint.len(), 40);
        assert_eq!(
            keys[0].user_ids,
            vec!["Gitmun Test <gitmun-test@example.invalid>"]
        );
    }
}
