use crate::git::types::{
    AvatarProviderMode, BackendMode, CommitDateMode, ExternalDiffTool, LinuxGraphicsMode,
    OperationResult, Settings, ThemeMode,
};
use crate::{configure_command, git_command, AppState};
use tauri::Manager;

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
            "Set git global diff.tool=meld".to_string()
        }
        ExternalDiffTool::Kompare => {
            git_config_global_set("diff.tool", "kompare")?;
            "Set git global diff.tool=kompare".to_string()
        }
        ExternalDiffTool::WinMerge => {
            git_config_global_set("diff.tool", "winmerge")?;
            "Set git global diff.tool=winmerge".to_string()
        }
        ExternalDiffTool::VsCode => {
            git_config_global_set("diff.tool", "vscode")?;
            git_config_global_set("difftool.vscode.cmd", "code --wait --diff $LOCAL $REMOTE")?;
            git_config_global_set("mergetool.vscode.cmd", "code --wait --merge $REMOTE $LOCAL $BASE $MERGED")?;
            "Set git global diff.tool=vscode (with difftool/mergetool cmd)".to_string()
        }
        ExternalDiffTool::VsCodium => {
            git_config_global_set("diff.tool", "vscodium")?;
            git_config_global_set("difftool.vscodium.cmd", "codium --wait --diff $LOCAL $REMOTE")?;
            git_config_global_set("mergetool.vscodium.cmd", "codium --wait --merge $REMOTE $LOCAL $BASE $MERGED")?;
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
    state.avatar_service.set_try_platform_first(try_platform_first);
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
pub fn set_push_follow_tags(
    push_follow_tags: bool,
    state: tauri::State<'_, AppState>,
) -> Settings {
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
    state.git_service.set_auto_install_updates(auto_install_updates)
}

#[tauri::command]
pub fn set_linux_graphics_mode(
    mode: LinuxGraphicsMode,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state.git_service.set_linux_graphics_mode(mode)
}
