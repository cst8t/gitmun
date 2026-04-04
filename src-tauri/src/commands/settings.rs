use crate::git::types::{
    AvatarProviderMode, BackendMode, CommitDateMode, ExternalDiffTool, LinuxGraphicsMode,
    OperationResult, Settings, ThemeMode,
};
use crate::{AppState, configure_command, git_command};
use reqwest::header::{ACCEPT, HeaderValue, RANGE};
use serde::Serialize;
#[cfg(windows)]
use std::path::Path;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const GITHUB_UPDATE_ENDPOINT: &str =
    "https://github.com/cst8t/gitmun/releases/latest/download/latest.json";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
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

async fn check_update_from_endpoint(
    app: &tauri::AppHandle,
    update_endpoint: &str,
) -> Result<Option<Update>, String> {
    let endpoint = parse_update_endpoint(update_endpoint)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(UPDATE_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;

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
        date: update.date.map(|date| date.to_string()),
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
    settings
}

#[tauri::command]
pub fn set_wrap_diff_lines(wrap_diff_lines: bool, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_wrap_diff_lines(wrap_diff_lines)
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
pub fn get_build_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn is_updater_enabled() -> bool {
    if std::env::var_os("GITMUN_NO_UPDATER").is_some() {
        return false;
    }
    // Flatpak bundles are updated by the Flatpak runtime, not in-app.
    if std::env::var_os("FLATPAK_ID").is_some() {
        return false;
    }
    // Distro package maintainers (e.g. Debian) install this file to signal
    // that the system package manager owns updates, not the in-app updater.
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/usr/share/gitmun/system-managed").exists() {
        return false;
    }
    true
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
) -> Result<(), String> {
    let update_endpoint = current_update_endpoint(&state);
    let expected_version = expected_version.as_deref();
    let update = get_installable_update(&app, &update_endpoint, expected_version).await?;
    update
        .download_and_install(|_, _| {}, || {})
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
fn first_existing_path<'a>(candidates: &'a [&'a str]) -> Option<&'a str> {
    candidates
        .iter()
        .copied()
        .find(|candidate| Path::new(candidate).exists())
}

fn maybe_set_tool_paths(tool_key: &str) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let candidates = match tool_key {
            "meld" => &[
                r"C:\Program Files\Meld\Meld.exe",
                r"C:\Program Files (x86)\Meld\Meld.exe",
            ][..],
            "winmerge" => &[
                r"C:\Program Files\WinMerge\WinMergeU.exe",
                r"C:\Program Files (x86)\WinMerge\WinMergeU.exe",
            ][..],
            _ => return Ok(false),
        };

        let Some(path) = first_existing_path(candidates) else {
            return Ok(false);
        };

        git_config_global_set(&format!("difftool.{tool_key}.path"), path)?;
        git_config_global_set(&format!("mergetool.{tool_key}.path"), path)?;
        return Ok(true);
    }

    #[cfg(not(windows))]
    {
        let _ = tool_key;
        Ok(false)
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
pub fn set_global_diff_tool(tool: ExternalDiffTool) -> Result<OperationResult, String> {
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
            "Cleared diff.tool from global git config".to_string()
        }
        ExternalDiffTool::Meld => {
            git_config_global_set("diff.tool", "meld")?;
            if maybe_set_tool_paths("meld")? {
                "Set git global diff.tool=meld (with detected tool path)".to_string()
            } else {
                "Set git global diff.tool=meld".to_string()
            }
        }
        ExternalDiffTool::Kompare => {
            git_config_global_set("diff.tool", "kompare")?;
            "Set git global diff.tool=kompare".to_string()
        }
        ExternalDiffTool::WinMerge => {
            git_config_global_set("diff.tool", "winmerge")?;
            if maybe_set_tool_paths("winmerge")? {
                "Set git global diff.tool=winmerge (with detected tool path)".to_string()
            } else {
                "Set git global diff.tool=winmerge".to_string()
            }
        }
        ExternalDiffTool::VsCode => {
            git_config_global_set("diff.tool", "vscode")?;
            git_config_global_set("difftool.vscode.cmd", "code --wait --diff $LOCAL $REMOTE")?;
            git_config_global_set(
                "mergetool.vscode.cmd",
                "code --wait --merge $REMOTE $LOCAL $BASE $MERGED",
            )?;
            "Set git global diff.tool=vscode (with difftool/mergetool cmd)".to_string()
        }
        ExternalDiffTool::VsCodium => {
            git_config_global_set("diff.tool", "vscodium")?;
            git_config_global_set(
                "difftool.vscodium.cmd",
                "codium --wait --diff $LOCAL $REMOTE",
            )?;
            git_config_global_set(
                "mergetool.vscodium.cmd",
                "codium --wait --merge $REMOTE $LOCAL $BASE $MERGED",
            )?;
            "Set git global diff.tool=vscodium (with difftool/mergetool cmd)".to_string()
        }
    };

    Ok(OperationResult {
        message,
        output: None,
        repo_path: None,
        backend_used: "git-cli".to_string(),
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
    })
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
