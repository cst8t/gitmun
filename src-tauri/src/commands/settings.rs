use crate::git::types::{
    AvatarProviderMode, BackendMode, CommitDateMode, CommitPrimaryAction, ExternalDiffTool,
    LinuxGraphicsMode, LinuxTerminalEmulator, OperationResult, RepoOpenBehaviour, RowStriping,
    Settings, ThemeMode,
};
use crate::{AppState, configure_command, git_command};
use reqwest::header::{ACCEPT, HeaderValue, RANGE};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use tauri::{Manager, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};
#[cfg(windows)]
use tauri_utils::{config::BundleType, platform};
use url::Url;

const GITHUB_UPDATE_ENDPOINT: &str =
    "https://github.com/cst8t/gitmun/releases/latest/download/latest.json";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    current_version: String,
    version: String,
    date: Option<i64>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
pub enum AppUpdateChannel {
    SelfManaged,
    MicrosoftStore,
    SystemManaged,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateDownloadEvent {
    #[serde(rename = "Started", rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename = "Progress", rename_all = "camelCase")]
    Progress { chunk_length: usize },
    #[serde(rename = "Finished")]
    Finished,
}

fn parse_update_endpoint(update_endpoint: &str) -> Result<Url, String> {
    let update_endpoint = update_endpoint.trim();
    if update_endpoint.is_empty() {
        return Err(format!(
            "Update feed URL cannot be empty. The default is {GITHUB_UPDATE_ENDPOINT}."
        ));
    }

    let url = Url::parse(update_endpoint).map_err(|error| error.to_string())?;
    match url.scheme() {
        "https" | "http" => Ok(url),
        scheme => Err(format!(
            "Update feed URL must use http or https, got {scheme}."
        )),
    }
}

fn current_update_endpoint(state: &tauri::State<'_, AppState>) -> String {
    let update_endpoint = state.git_service.get_settings().update_endpoint;
    if update_endpoint.trim().is_empty() {
        GITHUB_UPDATE_ENDPOINT.to_string()
    } else {
        update_endpoint
    }
}

fn current_updater_target() -> Option<String> {
    let default_target = tauri_plugin_updater::target()?;

    #[cfg(windows)]
    {
        return Some(match platform::bundle_type() {
            Some(BundleType::Nsis) => format!("{default_target}-nsis"),
            Some(BundleType::Msi) => format!("{default_target}-msi"),
            _ => default_target,
        });
    }

    #[cfg(not(windows))]
    {
        Some(default_target)
    }
}

async fn check_update_from_endpoint(
    app: &tauri::AppHandle,
    update_endpoint: &str,
) -> Result<Option<Update>, String> {
    let endpoint = parse_update_endpoint(update_endpoint)?;
    let mut updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(UPDATE_TIMEOUT);
    if let Some(target) = current_updater_target() {
        updater = updater.target(target);
    }
    let updater = updater.build().map_err(|error| error.to_string())?;

    updater.check().await.map_err(|error| error.to_string())
}

async fn ensure_download_url_reachable(update: &Update) -> Result<(), String> {
    let mut headers = update.headers.clone();
    if !headers.contains_key(ACCEPT) {
        headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
    }
    headers.insert(RANGE, HeaderValue::from_static("bytes=0-0"));

    let mut request = reqwest::Client::builder()
        .user_agent("gitmun-updater-connectivity-check")
        .timeout(update.timeout.unwrap_or(UPDATE_TIMEOUT));
    if update.no_proxy {
        request = request.no_proxy();
    } else if let Some(proxy) = &update.proxy {
        let proxy = reqwest::Proxy::all(proxy.as_str()).map_err(|error| error.to_string())?;
        request = request.proxy(proxy);
    }

    let response = request
        .build()
        .map_err(|error| error.to_string())?
        .get(update.download_url.clone())
        .headers(headers)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "download URL responded with status {}",
            response.status()
        ))
    }
}

fn available_update_from(update: &Update) -> AvailableUpdate {
    AvailableUpdate {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.date.map(|date| date.unix_timestamp()),
        body: update.body.clone(),
    }
}

fn check_expected_version(update: &Update, expected_version: Option<&str>) -> Result<(), String> {
    if let Some(expected_version) = expected_version {
        if update.version != expected_version {
            return Err(format!(
                "Update version changed from {expected_version} to {}. Please check again.",
                update.version
            ));
        }
    }
    Ok(())
}

async fn get_installable_update(
    app: &tauri::AppHandle,
    update_endpoint: &str,
    expected_version: Option<&str>,
) -> Result<Update, String> {
    let mut update = check_update_from_endpoint(app, update_endpoint)
        .await?
        .ok_or_else(|| "No update is currently available.".to_string())?;
    check_expected_version(&update, expected_version)?;
    ensure_download_url_reachable(&update).await?;
    update.timeout = Some(UPDATE_TIMEOUT);
    Ok(update)
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.get_settings()
}

#[tauri::command]
pub fn set_backend_mode(mode: BackendMode, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_backend_mode(mode)
}

#[tauri::command]
pub fn set_show_result_log(show_result_log: bool, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_show_result_log(show_result_log)
}

#[tauri::command]
pub fn set_theme_mode(
    theme_mode: ThemeMode,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Settings {
    let settings = state.git_service.set_theme_mode(theme_mode);
    let background_colour =
        crate::window_manager::background_colour_for_theme_mode(&app, &settings.theme_mode);
    for (_, window) in app.webview_windows() {
        let _ = window.set_background_color(Some(background_colour));
    }
    crate::instance_coordinator::broadcast_settings_updated();
    settings
}

#[tauri::command]
pub fn get_theme_bundle(app: tauri::AppHandle) -> crate::theme::ThemeBundle {
    crate::theme::load_or_create_theme_bundle(&app)
}

#[tauri::command]
pub fn set_ui_text_scale(ui_text_scale: f64, state: tauri::State<'_, AppState>) -> Settings {
    let settings = state.git_service.set_ui_text_scale(ui_text_scale);
    crate::instance_coordinator::broadcast_settings_updated();
    settings
}

#[tauri::command]
pub fn set_wrap_diff_lines(wrap_diff_lines: bool, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_wrap_diff_lines(wrap_diff_lines)
}

#[tauri::command]
pub fn set_row_striping(row_striping: RowStriping, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_row_striping(row_striping)
}

#[tauri::command]
pub fn set_persistent_error_toasts(
    persistent_error_toasts: bool,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_persistent_error_toasts(persistent_error_toasts)
}

#[tauri::command]
pub fn set_error_toast_clear_delay_ms(
    error_toast_clear_delay_ms: u32,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_error_toast_clear_delay_ms(error_toast_clear_delay_ms)
}

#[tauri::command]
pub fn set_panel_layout(
    left_pane_width: u32,
    right_pane_width: u32,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_panel_layout(left_pane_width, right_pane_width)
}

#[tauri::command]
pub fn set_confirm_revert(confirm_revert: bool, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_confirm_revert(confirm_revert)
}

#[tauri::command]
pub fn get_config_file_path(state: tauri::State<'_, AppState>) -> Option<String> {
    state.git_service.get_config_file_path()
}

#[tauri::command]
pub fn get_config_folder_path(state: tauri::State<'_, AppState>) -> Option<String> {
    state.git_service.get_config_folder_path()
}

#[tauri::command]
pub fn get_build_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn get_app_update_channel(state: tauri::State<'_, AppState>) -> AppUpdateChannel {
    #[cfg(not(target_os = "windows"))]
    let _ = &state;

    if crate::commands::store_update::is_local_test_enabled() {
        return AppUpdateChannel::MicrosoftStore;
    }
    if std::env::var_os("GITMUN_NO_UPDATER").is_some() {
        return AppUpdateChannel::SystemManaged;
    }
    // Flatpak bundles are updated by the Flatpak runtime, not in-app.
    if std::env::var_os("FLATPAK_ID").is_some() {
        return AppUpdateChannel::SystemManaged;
    }
    // Distro package maintainers (e.g. Debian) install this file to signal
    // that the system package manager owns updates, not the in-app updater.
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/usr/share/gitmun/system-managed").exists() {
        return AppUpdateChannel::SystemManaged;
    }
    #[cfg(target_os = "windows")]
    if crate::is_msix_build() {
        if state
            .git_service
            .get_settings()
            .enable_update_with_ms_store_flow
        {
            return AppUpdateChannel::MicrosoftStore;
        }
        return AppUpdateChannel::SystemManaged;
    }
    AppUpdateChannel::SelfManaged
}

#[tauri::command]
pub fn is_updater_enabled(state: tauri::State<'_, AppState>) -> bool {
    matches!(get_app_update_channel(state), AppUpdateChannel::SelfManaged)
}

#[tauri::command]
pub async fn check_for_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<AvailableUpdate>, String> {
    let update_endpoint = current_update_endpoint(&state);
    let update = check_update_from_endpoint(&app, &update_endpoint).await?;
    let Some(update) = update else {
        return Ok(None);
    };
    ensure_download_url_reachable(&update).await?;
    Ok(Some(available_update_from(&update)))
}

#[tauri::command]
pub async fn download_and_install_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    expected_version: Option<String>,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<(), String> {
    let update_endpoint = current_update_endpoint(&state);
    let expected_version = expected_version.as_deref();
    let update = get_installable_update(&app, &update_endpoint, expected_version).await?;
    let mut started = false;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(UpdateDownloadEvent::Started { content_length });
                    started = true;
                }
                let _ = on_event.send(UpdateDownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(UpdateDownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_commit_hash() -> &'static str {
    env!("GITMUN_COMMIT_HASH")
}

#[tauri::command]
pub fn get_global_diff_tool() -> Result<ExternalDiffTool, String> {
    let Some(value) = git_config_global_get("diff.tool")? else {
        return Ok(ExternalDiffTool::Other);
    };

    let value = value.to_lowercase();
    let tool = match value.as_str() {
        "meld" => ExternalDiffTool::Meld,
        "kompare" => ExternalDiffTool::Kompare,
        "winmerge" => ExternalDiffTool::WinMerge,
        "vscode" => ExternalDiffTool::VsCode,
        "vscodium" => ExternalDiffTool::VsCodium,
        _ => ExternalDiffTool::Other,
    };

    Ok(tool)
}

#[tauri::command]
pub fn get_global_default_branch() -> Result<Option<String>, String> {
    git_config_global_get("init.defaultBranch")
}

#[tauri::command]
pub fn get_global_file_mode() -> Result<Option<bool>, String> {
    match git_config_global_get("core.fileMode")? {
        Some(v) => Ok(Some(v.to_lowercase() == "true")),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn get_global_pull_rebase() -> Result<Option<String>, String> {
    git_config_global_get("pull.rebase")
}

#[tauri::command]
pub fn get_global_pull_ff() -> Result<Option<String>, String> {
    git_config_global_get("pull.ff")
}

#[tauri::command]
pub fn get_global_pull_autostash() -> Result<Option<String>, String> {
    git_config_global_get("pull.autostash")
}

#[tauri::command]
pub fn get_global_fetch_prune() -> Result<Option<String>, String> {
    git_config_global_get("fetch.prune")
}

#[tauri::command]
pub fn get_global_push_default() -> Result<Option<String>, String> {
    git_config_global_get("push.default")
}

#[tauri::command]
pub fn get_global_push_auto_setup_remote() -> Result<Option<String>, String> {
    git_config_global_get("push.autoSetupRemote")
}

#[tauri::command]
pub fn get_global_core_editor() -> Result<Option<String>, String> {
    git_config_global_get("core.editor")
}

#[tauri::command]
pub fn get_global_core_autocrlf() -> Result<Option<String>, String> {
    git_config_global_get("core.autocrlf")
}

#[tauri::command]
pub fn get_global_credential_helper() -> Result<Option<String>, String> {
    git_config_global_get("credential.helper")
}

#[tauri::command]
pub fn get_active_git_executable_path() -> String {
    crate::resolve_active_git_executable_path()
}

#[tauri::command]
pub fn get_active_git_version() -> Result<String, String> {
    crate::git_version_string()
}

#[tauri::command]
pub fn get_global_gpg_program() -> Result<Option<String>, String> {
    git_config_global_get("gpg.program")
}

#[tauri::command]
pub fn get_global_gpg_program_path() -> Result<Option<String>, String> {
    let configured = git_config_global_get("gpg.program")?;
    if let Some(program) = configured.as_ref() {
        if gpg_program_value_available(program) {
            return Ok(configured);
        }
    }

    #[cfg(windows)]
    {
        Ok(crate::resolve_known_gpg_program_path().map(|path| path.to_string_lossy().into()))
    }

    #[cfg(not(windows))]
    {
        Ok(configured)
    }
}

#[cfg(windows)]
fn diff_tool_key(tool: &ExternalDiffTool) -> Option<&'static str> {
    match tool {
        ExternalDiffTool::Meld => Some("meld"),
        ExternalDiffTool::Kompare => Some("kompare"),
        ExternalDiffTool::WinMerge => Some("winmerge"),
        ExternalDiffTool::VsCode => Some("vscode"),
        ExternalDiffTool::VsCodium => Some("vscodium"),
        ExternalDiffTool::Other => None,
    }
}

fn is_path_like(value: &str) -> bool {
    Path::new(value).is_absolute() || value.contains('/') || value.contains('\\')
}

fn gpg_program_value_available(value: &str) -> bool {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return false;
    }

    if is_path_like(trimmed) {
        return Path::new(trimmed).exists();
    }

    true
}

fn validate_gpg_program(program: &str) -> Result<String, String> {
    let trimmed = program.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    if is_path_like(trimmed) && !Path::new(trimmed).exists() {
        return Err(format!("GPG executable was not found: {trimmed}"));
    }

    Ok(trimmed.to_string())
}

fn git_config_global_set(key: &str, value: &str) -> Result<(), String> {
    let mut command = git_command();
    configure_command(&mut command);
    let output = command
        .args(["config", "--global", key, value])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Failed to set git config {key}")
        } else {
            stderr
        });
    }
    Ok(())
}

fn git_config_global_get(key: &str) -> Result<Option<String>, String> {
    let mut command = git_command();
    configure_command(&mut command);
    let output = command
        .args(["config", "--global", "--get", key])
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            return Ok(None);
        }
        return Ok(Some(value));
    }

    if output.status.code() == Some(1) {
        return Ok(None);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Failed to get git config {key}")
    } else {
        stderr
    })
}

#[cfg(windows)]
fn configured_global_tool_path(tool_key: &str) -> Result<Option<String>, String> {
    let Some(path) = git_config_global_get(&format!("difftool.{tool_key}.path"))? else {
        return Ok(None);
    };
    if Path::new(&path).exists() {
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

#[cfg(windows)]
fn resolve_windows_diff_tool_path(tool_key: &str) -> Result<Option<String>, String> {
    if let Some(path) = configured_global_tool_path(tool_key)? {
        return Ok(Some(path));
    }
    Ok(crate::resolve_known_diff_tool_path(tool_key).map(|path| path.to_string_lossy().into()))
}

#[cfg(windows)]
fn validate_windows_tool_path(tool_path: &str) -> Result<String, String> {
    let trimmed = tool_path.trim();
    if trimmed.is_empty() {
        return Err("Select a diff tool executable or leave the field blank.".to_string());
    }
    if !Path::new(trimmed).exists() {
        return Err(format!("Diff tool executable was not found: {trimmed}"));
    }
    Ok(trimmed.to_string())
}

#[cfg(windows)]
fn windows_tool_path_message(tool_label: &str) -> String {
    format!(
        "Could not find {tool_label} on PATH or in common install locations. Select its executable in Settings."
    )
}

#[cfg(not(windows))]
fn windows_tool_path_message(tool_label: &str) -> String {
    format!("Could not find {tool_label}.")
}

fn maybe_set_tool_paths(tool_key: &str, tool_path: Option<&str>) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let path = if let Some(path) = tool_path {
            validate_windows_tool_path(path)?
        } else {
            match resolve_windows_diff_tool_path(tool_key)? {
                Some(path) => path,
                None => return Ok(false),
            }
        };

        git_config_global_set(&format!("difftool.{tool_key}.path"), &path)?;
        git_config_global_set(&format!("mergetool.{tool_key}.path"), &path)?;
        return Ok(true);
    }

    #[cfg(not(windows))]
    {
        let _ = tool_key;
        let _ = tool_path;
        Ok(false)
    }
}

#[tauri::command]
pub fn get_global_diff_tool_path(tool: ExternalDiffTool) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let Some(tool_key) = diff_tool_key(&tool) else {
            return Ok(None);
        };
        match tool_key {
            "meld" | "winmerge" => resolve_windows_diff_tool_path(tool_key),
            _ => Ok(None),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = tool;
        Ok(None)
    }
}

fn validate_branch_name(name: &str) -> Result<(), String> {
    let mut command = git_command();
    configure_command(&mut command);
    let output = command
        .args(["check-ref-format", "--branch", name])
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Invalid branch name: {name}")
    } else {
        stderr
    })
}

fn git_config_global_unset(key: &str) -> Result<(), String> {
    let mut command = git_command();
    configure_command(&mut command);
    // --unset exits 5 when the key doesn't exist - treat that as success
    let output = command
        .args(["config", "--global", "--unset", key])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() && output.status.code() != Some(5) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Failed to unset git config {key}")
        } else {
            stderr
        });
    }
    Ok(())
}

#[tauri::command]
pub fn set_global_diff_tool(
    tool: ExternalDiffTool,
    tool_path: Option<String>,
) -> Result<OperationResult, String> {
    // Always clean up tool-specific cmd keys Gitmun may have written previously,
    // so switching away from VS Code/Codium leaves no stale entries behind.
    for key in &[
        "difftool.vscode.cmd",
        "mergetool.vscode.cmd",
        "difftool.vscodium.cmd",
        "mergetool.vscodium.cmd",
        "difftool.meld.path",
        "mergetool.meld.path",
        "difftool.winmerge.path",
        "mergetool.winmerge.path",
    ] {
        let _ = git_config_global_unset(key);
    }

    let message = match tool {
        ExternalDiffTool::Other => {
            let _ = git_config_global_unset("diff.tool");
            let _ = git_config_global_unset("merge.tool");
            "Cleared diff.tool and merge.tool from global git config".to_string()
        }
        ExternalDiffTool::Meld => {
            #[cfg(windows)]
            {
                if maybe_set_tool_paths("meld", tool_path.as_deref())? {
                    git_config_global_set("diff.tool", "meld")?;
                    git_config_global_set("merge.tool", "meld")?;
                    "Set git global diff.tool=meld and merge.tool=meld (with detected tool path)"
                        .to_string()
                } else {
                    return Err(windows_tool_path_message("Meld"));
                }
            }
            #[cfg(not(windows))]
            {
                let _ = tool_path;
                git_config_global_set("diff.tool", "meld")?;
                git_config_global_set("merge.tool", "meld")?;
                "Set git global diff.tool=meld and merge.tool=meld".to_string()
            }
        }
        ExternalDiffTool::Kompare => {
            git_config_global_set("diff.tool", "kompare")?;
            git_config_global_set("merge.tool", "kompare")?;
            "Set git global diff.tool=kompare and merge.tool=kompare".to_string()
        }
        ExternalDiffTool::WinMerge => {
            if maybe_set_tool_paths("winmerge", tool_path.as_deref())? {
                git_config_global_set("diff.tool", "winmerge")?;
                git_config_global_set("merge.tool", "winmerge")?;
                "Set git global diff.tool=winmerge and merge.tool=winmerge (with detected tool path)"
                    .to_string()
            } else {
                return Err(windows_tool_path_message("WinMerge"));
            }
        }
        ExternalDiffTool::VsCode => {
            git_config_global_set("diff.tool", "vscode")?;
            git_config_global_set("merge.tool", "vscode")?;
            git_config_global_set("difftool.vscode.cmd", "code --wait --diff $LOCAL $REMOTE")?;
            git_config_global_set(
                "mergetool.vscode.cmd",
                "code --wait --merge $REMOTE $LOCAL $BASE $MERGED",
            )?;
            "Set git global diff.tool=vscode and merge.tool=vscode (with difftool/mergetool cmd)"
                .to_string()
        }
        ExternalDiffTool::VsCodium => {
            git_config_global_set("diff.tool", "vscodium")?;
            git_config_global_set("merge.tool", "vscodium")?;
            git_config_global_set(
                "difftool.vscodium.cmd",
                "codium --wait --diff $LOCAL $REMOTE",
            )?;
            git_config_global_set(
                "mergetool.vscodium.cmd",
                "codium --wait --merge $REMOTE $LOCAL $BASE $MERGED",
            )?;
            "Set git global diff.tool=vscodium and merge.tool=vscodium (with difftool/mergetool cmd)"
                .to_string()
        }
    };

    Ok(OperationResult {
        message,
        output: None,
        repo_path: None,
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

#[tauri::command]
pub fn set_global_default_branch(default_branch: String) -> Result<OperationResult, String> {
    let branch = default_branch.trim();

    let message = if branch.is_empty() {
        git_config_global_unset("init.defaultBranch")?;
        "Cleared init.defaultBranch from global git config".to_string()
    } else {
        validate_branch_name(branch)?;
        git_config_global_set("init.defaultBranch", branch)?;
        format!("Set git global init.defaultBranch={branch}")
    };

    Ok(OperationResult {
        message,
        output: None,
        repo_path: None,
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

fn validate_config_choice(value: &str, allowed: &[&str], label: &str) -> Result<String, String> {
    let value = value.trim();
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Invalid {label}: {value}"))
    }
}

fn set_optional_global_config(
    key: &str,
    value: &str,
    empty_message: &str,
) -> Result<OperationResult, String> {
    let value = value.trim();
    let message = if value.is_empty() {
        git_config_global_unset(key)?;
        empty_message.to_string()
    } else {
        git_config_global_set(key, value)?;
        format!("Set git global {key}={value}")
    };

    Ok(OperationResult {
        message,
        output: None,
        repo_path: None,
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

#[tauri::command]
pub fn set_global_pull_rebase(pull_rebase: String) -> Result<OperationResult, String> {
    let value = validate_config_choice(
        &pull_rebase,
        &["", "false", "true", "merges", "interactive"],
        "pull.rebase",
    )?;
    set_optional_global_config(
        "pull.rebase",
        &value,
        "Cleared pull.rebase from global git config",
    )
}

#[tauri::command]
pub fn set_global_pull_ff(pull_ff: String) -> Result<OperationResult, String> {
    let value = validate_config_choice(&pull_ff, &["", "true", "false", "only"], "pull.ff")?;
    set_optional_global_config("pull.ff", &value, "Cleared pull.ff from global git config")
}

#[tauri::command]
pub fn set_global_pull_autostash(pull_autostash: String) -> Result<OperationResult, String> {
    let value = validate_config_choice(&pull_autostash, &["", "true", "false"], "pull.autostash")?;
    set_optional_global_config(
        "pull.autostash",
        &value,
        "Cleared pull.autostash from global git config",
    )
}

#[tauri::command]
pub fn set_global_fetch_prune(fetch_prune: String) -> Result<OperationResult, String> {
    let value = validate_config_choice(&fetch_prune, &["", "true", "false"], "fetch.prune")?;
    set_optional_global_config(
        "fetch.prune",
        &value,
        "Cleared fetch.prune from global git config",
    )
}

#[tauri::command]
pub fn set_global_push_default(push_default: String) -> Result<OperationResult, String> {
    let value = validate_config_choice(
        &push_default,
        &["", "nothing", "current", "upstream", "simple", "matching"],
        "push.default",
    )?;
    set_optional_global_config(
        "push.default",
        &value,
        "Cleared push.default from global git config",
    )
}

#[tauri::command]
pub fn set_global_push_auto_setup_remote(
    push_auto_setup_remote: String,
) -> Result<OperationResult, String> {
    let value = validate_config_choice(
        &push_auto_setup_remote,
        &["", "true", "false"],
        "push.autoSetupRemote",
    )?;
    set_optional_global_config(
        "push.autoSetupRemote",
        &value,
        "Cleared push.autoSetupRemote from global git config",
    )
}

#[tauri::command]
pub fn set_global_core_editor(core_editor: String) -> Result<OperationResult, String> {
    set_optional_global_config(
        "core.editor",
        &core_editor,
        "Cleared core.editor from global git config",
    )
}

#[tauri::command]
pub fn set_global_core_autocrlf(core_autocrlf: String) -> Result<OperationResult, String> {
    let value = validate_config_choice(
        &core_autocrlf,
        &["", "false", "true", "input"],
        "core.autocrlf",
    )?;
    set_optional_global_config(
        "core.autocrlf",
        &value,
        "Cleared core.autocrlf from global git config",
    )
}

#[tauri::command]
pub fn set_global_credential_helper(credential_helper: String) -> Result<OperationResult, String> {
    set_optional_global_config(
        "credential.helper",
        &credential_helper,
        "Cleared credential.helper from global git config",
    )
}

#[tauri::command]
pub fn set_global_file_mode(file_mode: bool) -> Result<OperationResult, String> {
    let value = if file_mode { "true" } else { "false" };
    git_config_global_set("core.fileMode", value)?;
    Ok(OperationResult {
        message: format!("Set git global core.fileMode={value}"),
        output: None,
        repo_path: None,
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

#[tauri::command]
pub fn set_global_gpg_program(gpg_program: String) -> Result<OperationResult, String> {
    let gpg_program = validate_gpg_program(&gpg_program)?;

    let message = if gpg_program.is_empty() {
        git_config_global_unset("gpg.program")?;
        "Cleared gpg.program from global git config".to_string()
    } else {
        git_config_global_set("gpg.program", &gpg_program)?;
        format!("Set git global gpg.program={gpg_program}")
    };

    Ok(OperationResult {
        message,
        output: None,
        repo_path: None,
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

fn validate_git_executable_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    let normalised = crate::normalise_display_path(trimmed);
    let path = Path::new(&normalised);
    if !path.exists() {
        return Err(format!("Git executable was not found: {normalised}"));
    }
    if path.is_dir() {
        return Err(format!(
            "Git executable path points to a directory: {normalised}"
        ));
    }

    Ok(normalised)
}

#[tauri::command]
pub fn set_git_executable_path(
    git_executable_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let git_executable_path = validate_git_executable_path(&git_executable_path)?;
    Ok(state
        .git_service
        .set_git_executable_path(git_executable_path))
}

#[tauri::command]
pub fn set_gpg_keyserver_verification_enabled(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_gpg_keyserver_verification_enabled(enabled)
}

#[tauri::command]
pub fn set_avatar_provider(
    avatar_provider: AvatarProviderMode,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state.avatar_service.set_mode(avatar_provider.clone());
    state.git_service.set_avatar_provider(avatar_provider)
}

#[tauri::command]
pub fn set_try_platform_first(
    try_platform_first: bool,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .avatar_service
        .set_try_platform_first(try_platform_first);
    state.git_service.set_try_platform_first(try_platform_first)
}

#[tauri::command]
pub fn set_default_clone_dir(
    default_clone_dir: String,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state.git_service.set_default_clone_dir(default_clone_dir)
}

#[tauri::command]
pub fn set_commit_date_mode(
    commit_date_mode: CommitDateMode,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state.git_service.set_commit_date_mode(commit_date_mode)
}

#[tauri::command]
pub fn set_push_follow_tags(push_follow_tags: bool, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_push_follow_tags(push_follow_tags)
}

#[tauri::command]
pub fn set_commit_primary_action(
    commit_primary_action: CommitPrimaryAction,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_commit_primary_action(commit_primary_action)
}

#[tauri::command]
pub fn set_commit_message_recommended_length(
    commit_message_recommended_length: u32,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_commit_message_recommended_length(commit_message_recommended_length)
}

#[tauri::command]
pub fn set_auto_check_for_updates_on_launch(
    auto_check_for_updates_on_launch: bool,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_auto_check_for_updates_on_launch(auto_check_for_updates_on_launch)
}

#[tauri::command]
pub fn set_auto_install_updates(
    auto_install_updates: bool,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_auto_install_updates(auto_install_updates)
}

#[tauri::command]
pub fn set_update_endpoint(
    update_endpoint: String,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let parsed = parse_update_endpoint(&update_endpoint)?;
    Ok(state.git_service.set_update_endpoint(parsed.to_string()))
}

#[tauri::command]
pub fn set_linux_graphics_mode(
    mode: LinuxGraphicsMode,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state.git_service.set_linux_graphics_mode(mode)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxTerminalOption {
    pub emulator: LinuxTerminalEmulator,
    pub label: &'static str,
}

#[tauri::command]
pub fn get_linux_terminal_options() -> Vec<LinuxTerminalOption> {
    linux_terminal_options()
}

#[cfg(target_os = "linux")]
fn linux_terminal_options() -> Vec<LinuxTerminalOption> {
    let mut options = vec![LinuxTerminalOption {
        emulator: LinuxTerminalEmulator::Auto,
        label: linux_terminal_launch::terminal_label(
            linux_terminal_launch::TerminalPreference::Auto,
        ),
    }];

    options.extend(
        linux_terminal_launch::known_terminals()
            .iter()
            .map(|terminal| LinuxTerminalOption {
                emulator: linux_terminal_emulator(terminal.terminal),
                label: terminal.label,
            }),
    );

    options.push(LinuxTerminalOption {
        emulator: LinuxTerminalEmulator::Custom,
        label: linux_terminal_launch::terminal_label(
            linux_terminal_launch::TerminalPreference::Custom,
        ),
    });

    options
}

#[cfg(target_os = "linux")]
fn linux_terminal_emulator(
    terminal: linux_terminal_launch::KnownTerminal,
) -> LinuxTerminalEmulator {
    match terminal {
        linux_terminal_launch::KnownTerminal::Konsole => LinuxTerminalEmulator::Konsole,
        linux_terminal_launch::KnownTerminal::GnomeTerminal => LinuxTerminalEmulator::GnomeTerminal,
        linux_terminal_launch::KnownTerminal::GnomeConsole => LinuxTerminalEmulator::GnomeConsole,
        linux_terminal_launch::KnownTerminal::Xfce4Terminal => LinuxTerminalEmulator::Xfce4Terminal,
        linux_terminal_launch::KnownTerminal::MateTerminal => LinuxTerminalEmulator::MateTerminal,
        linux_terminal_launch::KnownTerminal::Lxterminal => LinuxTerminalEmulator::Lxterminal,
        linux_terminal_launch::KnownTerminal::Alacritty => LinuxTerminalEmulator::Alacritty,
        linux_terminal_launch::KnownTerminal::Ghostty => LinuxTerminalEmulator::Ghostty,
        linux_terminal_launch::KnownTerminal::Kitty => LinuxTerminalEmulator::Kitty,
        linux_terminal_launch::KnownTerminal::WezTerm => LinuxTerminalEmulator::WezTerm,
        linux_terminal_launch::KnownTerminal::Foot => LinuxTerminalEmulator::Foot,
        linux_terminal_launch::KnownTerminal::Xterm => LinuxTerminalEmulator::Xterm,
    }
}

#[cfg(not(target_os = "linux"))]
fn linux_terminal_options() -> Vec<LinuxTerminalOption> {
    vec![
        LinuxTerminalOption {
            emulator: LinuxTerminalEmulator::Auto,
            label: "Terminal",
        },
        LinuxTerminalOption {
            emulator: LinuxTerminalEmulator::Custom,
            label: "Terminal",
        },
    ]
}

#[tauri::command]
pub fn set_linux_terminal_emulator(
    linux_terminal_emulator: LinuxTerminalEmulator,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_linux_terminal_emulator(linux_terminal_emulator)
}

#[tauri::command]
pub fn set_linux_terminal_custom_command(
    linux_terminal_custom_command: String,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_linux_terminal_custom_command(linux_terminal_custom_command)
}

#[tauri::command]
pub fn set_repo_open_behaviour(
    repo_open_behaviour: RepoOpenBehaviour,
    state: tauri::State<'_, AppState>,
) -> Settings {
    let settings = state
        .git_service
        .set_repo_open_behaviour(repo_open_behaviour);
    crate::instance_coordinator::broadcast_settings_updated();
    settings
}
