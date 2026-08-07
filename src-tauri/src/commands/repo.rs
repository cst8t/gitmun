use crate::git::types::{
    CloneRequest, CommitDetails, CommitDetailsRequest, CommitFileItem, CommitFilesRequest,
    CommitMarkers, CommitMessageRecovery, CommitRequest, DiffRequest, ExportCommitPatchRequest,
    ExportPatchRequest, ExternalDiffRequest, FetchRequest, FileDiff, FileRequest, GitIdentity,
    HunkStageRequest, IdentityRequest, ImportPatchRequest, LocalCopyDestinationMode,
    LocalCopyError, LocalCopyMode, LocalCopyProgress, LocalCopyProgressPhase, LocalCopyRequest,
    LocalCopyResult, LocalCopyWarning, NumstatRequest, NumstatResult, OperationResult,
    PullAnalysis, PullStrategyRequest, PushRequest, PushResult, RepoRequest, RepoStatus,
    SetIdentityRequest, SshAllowedSignerStatus, StageFilesRequest, StashEntry, StashPushRequest,
    StashRequest, SubmoduleActionRequest,
};
#[cfg(target_os = "linux")]
use crate::git::types::{LINUX_TERMINAL_AUTO_ID, LINUX_TERMINAL_CUSTOM_ID};
use crate::{AppState, CloneCancelFlag, configure_command};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const DEFAULT_GIT_DESCRIPTION: &str =
    "Unnamed repository; edit this file 'description' to name the repository.";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepoOpenLocationKind {
    FileExplorer,
    Terminal,
    GitBash,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpenLocation {
    kind: RepoOpenLocationKind,
    label: String,
    fallback_label: String,
    icon_data_url: Option<String>,
}

#[tauri::command]
pub fn get_repo_display_name(repo_path: String) -> Option<String> {
    let trimmed = repo_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    read_repo_display_name(Path::new(trimmed))
}

fn read_repo_display_name(repo_path: &Path) -> Option<String> {
    let git_dir = resolve_git_dir(repo_path)?;
    let description = std::fs::read_to_string(git_dir.join("description")).ok()?;
    parse_repo_description(&description)
}

fn parse_repo_description(description: &str) -> Option<String> {
    let trimmed = description.trim();
    if trimmed.is_empty() || trimmed == DEFAULT_GIT_DESCRIPTION {
        return None;
    }
    Some(trimmed.to_string())
}

fn resolve_git_dir(repo_path: &Path) -> Option<PathBuf> {
    let dot_git = repo_path.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if !dot_git.is_file() {
        return None;
    }

    let gitdir = std::fs::read_to_string(&dot_git).ok()?;
    let path = gitdir.trim().strip_prefix("gitdir:")?.trim();
    if path.is_empty() {
        return None;
    }

    let path = PathBuf::from(path);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(repo_path.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn apply_staged_working_tree(
        source: &Path,
        destination: &Path,
        destination_mode: LocalCopyDestinationMode,
    ) -> Result<(), LocalCopyError> {
        let cancel = AtomicBool::new(false);
        let workspace = create_copy_workspace(destination)?;
        let staged_result = workspace.join("result");
        std::fs::create_dir(&staged_result).map_err(|error| {
            local_copy_error(
                "filesystemFailure",
                Some(&staged_result),
                Some(error.to_string()),
            )
        })?;
        if destination_mode == LocalCopyDestinationMode::DropOnTop {
            copy_working_tree(destination, &staged_result, &cancel)?;
        }
        copy_working_tree(source, &staged_result, &cancel)?;
        commit_staged_result(
            destination,
            &staged_result,
            &workspace,
            destination.join(".git").exists(),
            None,
            &cancel,
            &None,
        )?;
        drop(std::fs::remove_dir_all(workspace));
        Ok(())
    }

    fn repo_with_git_dir() -> TempDir {
        let dir = TempDir::new().expect("create temp dir");
        std::fs::create_dir(dir.path().join(".git")).expect("create git dir");
        dir
    }

    fn write_description(repo: &Path, description: &str) {
        std::fs::write(repo.join(".git").join("description"), description)
            .expect("write description");
    }

    #[test]
    fn repo_display_name_ignores_default_description() {
        let dir = repo_with_git_dir();
        write_description(dir.path(), DEFAULT_GIT_DESCRIPTION);

        assert_eq!(read_repo_display_name(dir.path()), None);
    }

    #[test]
    fn repo_display_name_ignores_empty_description() {
        let dir = repo_with_git_dir();
        write_description(dir.path(), "  \n");

        assert_eq!(read_repo_display_name(dir.path()), None);
    }

    #[test]
    fn repo_display_name_reads_custom_description() {
        let dir = repo_with_git_dir();
        write_description(dir.path(), "  Project Atlas  \n");

        assert_eq!(
            read_repo_display_name(dir.path()).as_deref(),
            Some("Project Atlas")
        );
    }

    #[test]
    fn repo_display_name_ignores_missing_description() {
        let dir = repo_with_git_dir();

        assert_eq!(read_repo_display_name(dir.path()), None);
    }

    #[test]
    fn repo_display_name_resolves_gitdir_file() {
        let dir = TempDir::new().expect("create temp dir");
        let git_dir = dir.path().join("actual-git-dir");
        std::fs::create_dir(&git_dir).expect("create git dir");
        std::fs::write(dir.path().join(".git"), "gitdir: actual-git-dir\n")
            .expect("write gitdir file");
        std::fs::write(git_dir.join("description"), "Linked Repo\n").expect("write description");

        assert_eq!(
            read_repo_display_name(dir.path()).as_deref(),
            Some("Linked Repo")
        );
    }

    #[test]
    fn working_tree_copy_skips_git_metadata() {
        let source = TempDir::new().expect("create source dir");
        std::fs::create_dir(source.path().join(".git")).expect("create source git dir");
        std::fs::write(source.path().join(".git").join("config"), "source")
            .expect("write source git config");
        std::fs::write(source.path().join("README.md"), "source readme")
            .expect("write source file");

        let destination = TempDir::new().expect("create destination dir");
        copy_working_tree(source.path(), destination.path(), &AtomicBool::new(false))
            .expect("copy working tree");

        assert_eq!(
            std::fs::read_to_string(destination.path().join("README.md"))
                .expect("read copied file"),
            "source readme"
        );
        assert!(!destination.path().join(".git").exists());
    }

    #[test]
    fn delete_existing_preserves_destination_git_metadata() {
        let source = TempDir::new().expect("create source dir");
        std::fs::write(source.path().join("README.md"), "new").expect("write source file");

        let destination = repo_with_git_dir();
        std::fs::write(
            destination.path().join(".git").join("config"),
            "destination",
        )
        .expect("write destination git config");
        std::fs::write(destination.path().join("stale.txt"), "stale").expect("write stale file");

        apply_staged_working_tree(
            source.path(),
            destination.path(),
            LocalCopyDestinationMode::DeleteExisting,
        )
        .expect("apply source");

        assert!(!destination.path().join("stale.txt").exists());
        assert_eq!(
            std::fs::read_to_string(destination.path().join("README.md")).expect("read new file"),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(destination.path().join(".git").join("config"))
                .expect("read destination git config"),
            "destination"
        );
    }

    #[test]
    fn drop_on_top_overwrites_matching_files_and_keeps_unrelated_files() {
        let source = TempDir::new().expect("create source dir");
        std::fs::write(source.path().join("README.md"), "new").expect("write source file");

        let destination = TempDir::new().expect("create destination dir");
        std::fs::write(destination.path().join("README.md"), "old")
            .expect("write old destination file");
        std::fs::write(destination.path().join("notes.txt"), "keep")
            .expect("write unrelated destination file");

        apply_staged_working_tree(
            source.path(),
            destination.path(),
            LocalCopyDestinationMode::DropOnTop,
        )
        .expect("apply source");

        assert_eq!(
            std::fs::read_to_string(destination.path().join("README.md"))
                .expect("read overwritten file"),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(destination.path().join("notes.txt"))
                .expect("read unrelated file"),
            "keep"
        );
    }

    #[test]
    fn drop_on_top_handles_file_directory_collisions_and_spaces() {
        let root = TempDir::new().expect("create root dir");
        let source = root.path().join("source with spaces");
        let destination = root.path().join("destination with spaces");
        std::fs::create_dir(&source).expect("create source");
        std::fs::create_dir(&destination).expect("create destination");
        std::fs::write(source.join("file-replaces-directory"), "file").expect("write source file");
        std::fs::create_dir(source.join("directory-replaces-file"))
            .expect("create source directory");
        std::fs::write(
            source.join("directory-replaces-file").join("nested.txt"),
            "nested",
        )
        .expect("write nested source file");
        std::fs::create_dir(destination.join("file-replaces-directory"))
            .expect("create destination directory");
        std::fs::write(destination.join("directory-replaces-file"), "old file")
            .expect("write destination file");

        apply_staged_working_tree(&source, &destination, LocalCopyDestinationMode::DropOnTop)
            .expect("apply source with collisions");

        assert_eq!(
            std::fs::read_to_string(destination.join("file-replaces-directory"))
                .expect("read replacement file"),
            "file"
        );
        assert_eq!(
            std::fs::read_to_string(
                destination
                    .join("directory-replaces-file")
                    .join("nested.txt")
            )
            .expect("read nested replacement file"),
            "nested"
        );
    }

    #[test]
    fn complete_repository_copy_rejects_existing_destination() {
        let source = TempDir::new().expect("create source dir");
        let destination = TempDir::new().expect("create destination dir");

        let error = validate_complete_repository_copy_request(
            source.path().to_str().expect("source path"),
            destination.path(),
        )
        .expect_err("reject existing destination");

        assert_eq!(error.code, "destinationExists");
    }

    #[test]
    fn files_only_copy_rejects_nested_destination() {
        let source = TempDir::new().expect("create source dir");
        let destination = source.path().join("nested");

        let error = validate_files_only_copy_request(
            source.path().to_str().expect("source path"),
            &destination,
        )
        .expect_err("reject nested destination");

        assert_eq!(error.code, "overlappingPaths");
    }

    #[test]
    fn local_copy_is_disabled_unless_experiment_is_enabled() {
        assert_eq!(
            require_local_copy_enabled(false)
                .expect_err("reject disabled Local Copy")
                .code,
            "featureDisabled"
        );
        require_local_copy_enabled(true).expect("allow enabled Local Copy");
    }

    #[test]
    fn working_tree_copy_includes_hidden_files_and_excludes_nested_git_metadata() {
        let source = TempDir::new().expect("create source dir");
        std::fs::write(source.path().join(".env"), "secret").expect("write hidden file");
        let nested = source.path().join("nested");
        std::fs::create_dir(&nested).expect("create nested dir");
        std::fs::create_dir(nested.join(".git")).expect("create nested git dir");
        std::fs::write(nested.join(".git").join("config"), "metadata")
            .expect("write nested git metadata");
        std::fs::write(nested.join("ignored.log"), "present").expect("write ignored file");

        let destination = TempDir::new().expect("create destination dir");
        copy_working_tree(source.path(), destination.path(), &AtomicBool::new(false))
            .expect("copy working tree");

        assert_eq!(
            std::fs::read_to_string(destination.path().join(".env")).expect("read hidden file"),
            "secret"
        );
        assert_eq!(
            std::fs::read_to_string(destination.path().join("nested").join("ignored.log"))
                .expect("read ignored file"),
            "present"
        );
        assert!(!destination.path().join("nested").join(".git").exists());
    }

    #[cfg(unix)]
    #[test]
    fn working_tree_copy_preserves_symbolic_links_without_following_them() {
        let source = TempDir::new().expect("create source dir");
        std::fs::write(source.path().join("target.txt"), "target").expect("write target");
        std::os::unix::fs::symlink("target.txt", source.path().join("link.txt"))
            .expect("create symbolic link");
        std::os::unix::fs::symlink("missing.txt", source.path().join("broken.txt"))
            .expect("create broken symbolic link");
        let destination = TempDir::new().expect("create destination dir");

        preflight_working_tree(source.path(), &AtomicBool::new(false))
            .expect("preflight symbolic links");
        copy_working_tree(source.path(), destination.path(), &AtomicBool::new(false))
            .expect("copy symbolic links");

        assert_eq!(
            std::fs::read_link(destination.path().join("link.txt")).expect("read symbolic link"),
            PathBuf::from("target.txt")
        );
        assert_eq!(
            std::fs::read_link(destination.path().join("broken.txt"))
                .expect("read broken symbolic link"),
            PathBuf::from("missing.txt")
        );
    }

    #[cfg(unix)]
    #[test]
    fn preflight_rejects_special_files_before_copying() {
        let source = TempDir::new().expect("create source dir");
        let fifo_path = source.path().join("events.fifo");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .expect("launch mkfifo");
        assert!(status.success());

        let error = preflight_working_tree(source.path(), &AtomicBool::new(false))
            .expect_err("reject FIFO");
        assert_eq!(error.code, "unsupportedFileType");
        assert_eq!(error.path.as_deref(), fifo_path.to_str());
    }

    #[test]
    fn preflight_honours_cancellation() {
        let source = TempDir::new().expect("create source dir");
        let cancel = AtomicBool::new(true);

        let error = preflight_working_tree(source.path(), &cancel).expect_err("cancel preflight");
        assert_eq!(error.code, "cancelled");
    }

    #[test]
    fn local_source_rejects_an_unavailable_declared_submodule() {
        let source = TempDir::new().expect("create source dir");
        std::fs::write(
            source.path().join(".gitmodules"),
            "[submodule \"missing\"]\n\tpath = dependencies/missing\n\turl = ../missing\n",
        )
        .expect("write gitmodules");

        let error = validate_local_submodules(source.path(), &AtomicBool::new(false))
            .expect_err("reject unavailable submodule");
        assert_eq!(error.code, "submoduleUnavailable");
        assert!(
            error
                .path
                .as_deref()
                .is_some_and(|path| path.ends_with("dependencies/missing"))
        );
    }

    #[test]
    fn destination_git_metadata_must_be_a_usable_repository() {
        let destination = repo_with_git_dir();

        let error = validate_destination_repository(destination.path())
            .expect_err("reject unusable git metadata");
        assert_eq!(error.code, "invalidDestination");
    }

    #[test]
    fn fresh_destination_repository_is_initialised() {
        let destination = TempDir::new().expect("create destination dir");

        run_git_init(destination.path()).expect("initialise repository");

        assert!(validate_destination_repository(destination.path()).expect("validate repository"));
    }

    #[test]
    fn rollback_restores_backed_up_entries_and_removes_installed_entries() {
        let root = TempDir::new().expect("create root dir");
        let destination = root.path().join("destination");
        let staged_result = root.path().join("staged");
        let backup = root.path().join("backup");
        std::fs::create_dir(&destination).expect("create destination");
        std::fs::create_dir(&staged_result).expect("create staged result");
        std::fs::create_dir(&backup).expect("create backup");
        std::fs::write(destination.join("new.txt"), "new").expect("write installed file");
        std::fs::write(backup.join("old.txt"), "old").expect("write backup file");

        rollback_staged_result(
            &destination,
            &staged_result,
            &backup,
            &[std::ffi::OsString::from("new.txt")],
        )
        .expect("rollback staged result");

        assert_eq!(
            std::fs::read_to_string(destination.join("old.txt")).expect("read restored file"),
            "old"
        );
        assert!(!destination.join("new.txt").exists());
        assert_eq!(
            std::fs::read_to_string(staged_result.join("new.txt"))
                .expect("read removed installed file"),
            "new"
        );
    }
}

#[tauri::command]
pub fn get_repo_open_locations(state: tauri::State<'_, AppState>) -> Vec<RepoOpenLocation> {
    let terminal_label = default_terminal_label(&state.git_service.get_settings());
    let locations = vec![
        RepoOpenLocation {
            kind: RepoOpenLocationKind::FileExplorer,
            label: default_file_manager_label().to_string(),
            fallback_label: default_file_manager_label().to_string(),
            icon_data_url: None,
        },
        RepoOpenLocation {
            kind: RepoOpenLocationKind::Terminal,
            label: terminal_label,
            fallback_label: "Terminal".to_string(),
            icon_data_url: None,
        },
    ];

    #[cfg(target_os = "windows")]
    let locations = {
        let mut locations = locations;
        if crate::resolve_system_git_bash_exe().is_some() {
            locations.push(RepoOpenLocation {
                kind: RepoOpenLocationKind::GitBash,
                label: "Git Bash".to_string(),
                fallback_label: "Git Bash".to_string(),
                icon_data_url: None,
            });
        }
        locations
    };

    locations
}

#[tauri::command]
pub fn open_repo_location(
    repo_path: String,
    kind: RepoOpenLocationKind,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    let path = validate_repo_open_path(&repo_path)?;

    match kind {
        RepoOpenLocationKind::FileExplorer => {
            app.opener()
                .open_path(path.to_string_lossy().to_string(), None::<&str>)
                .map_err(|e| format!("Failed to open file manager: {e}"))?;
            Ok(repo_open_result(
                format!("Opened repository in {}", default_file_manager_label()),
                path,
            ))
        }
        RepoOpenLocationKind::Terminal => {
            open_terminal_at(&path, &state.git_service.get_settings())?;
            Ok(repo_open_result(
                "Opened repository in Terminal".to_string(),
                path,
            ))
        }
        RepoOpenLocationKind::GitBash => {
            open_git_bash_at(&path)?;
            Ok(repo_open_result(
                "Opened repository in Git Bash".to_string(),
                path,
            ))
        }
    }
}

fn validate_repo_open_path(repo_path: &str) -> Result<PathBuf, String> {
    let trimmed = repo_path.trim();
    if trimmed.is_empty() {
        return Err("Repository path cannot be empty".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err("Repository path must be an existing directory".to_string());
    }
    Ok(path)
}

fn repo_open_result(message: String, path: PathBuf) -> OperationResult {
    OperationResult {
        message,
        output: None,
        repo_path: Some(path.to_string_lossy().to_string()),
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    }
}

fn default_file_manager_label() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "File Explorer"
    }
    #[cfg(target_os = "macos")]
    {
        "Finder"
    }
    #[cfg(target_os = "linux")]
    {
        "File Manager"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "File Manager"
    }
}

fn default_terminal_label(settings: &crate::git::types::Settings) -> String {
    #[cfg(target_os = "linux")]
    {
        return linux_terminal_label(settings);
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = settings;
        "Terminal".to_string()
    }
}

fn open_terminal_at(path: &Path, settings: &crate::git::types::Settings) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = settings;
        return open_terminal_at_windows(path);
    }

    #[cfg(target_os = "macos")]
    {
        let _ = settings;
        return open_terminal_at_macos(path);
    }

    #[cfg(target_os = "linux")]
    {
        return open_terminal_at_linux(path, settings);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        let _ = settings;
        Err("Opening a terminal is not supported on this platform".to_string())
    }
}

fn open_git_bash_at(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return open_git_bash_at_windows(path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Git Bash is only available on Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn open_git_bash_at_windows(path: &Path) -> Result<(), String> {
    let git_bash = crate::resolve_system_git_bash_exe()
        .ok_or_else(|| "Git Bash from Git for Windows was not found".to_string())?;
    std::process::Command::new(git_bash)
        .arg(format!("--cd={}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open Git Bash: {e}"))
}

#[cfg(target_os = "windows")]
fn open_terminal_at_windows(path: &Path) -> Result<(), String> {
    let mut wt = std::process::Command::new("wt.exe");
    wt.arg("-d").arg(path);
    if wt.spawn().is_ok() {
        return Ok(());
    }

    std::process::Command::new("cmd.exe")
        .arg("/C")
        .arg("start")
        .arg("")
        .arg("/D")
        .arg(path)
        .arg("cmd.exe")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open terminal: {e}"))
}

#[cfg(target_os = "macos")]
fn open_terminal_at_macos(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open Terminal: {e}"))
}

#[cfg(target_os = "linux")]
fn open_terminal_at_linux(
    path: &Path,
    settings: &crate::git::types::Settings,
) -> Result<(), String> {
    linux_terminal_launcher(settings, path)
        .spawn()
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn linux_terminal_label(settings: &crate::git::types::Settings) -> String {
    let registry = linux_terminal_launch::TerminalRegistry::with_known_terminals();
    registry.label_for_preference(&linux_terminal_preference(
        settings.linux_terminal_emulator.as_str(),
    ))
}

#[cfg(target_os = "linux")]
fn linux_terminal_launcher(
    settings: &crate::git::types::Settings,
    path: &Path,
) -> linux_terminal_launch::TerminalLauncher {
    linux_terminal_launch::TerminalLauncher::new()
        .working_dir(path)
        .registry(linux_terminal_launch::TerminalRegistry::with_known_terminals())
        .preference(linux_terminal_preference(
            settings.linux_terminal_emulator.as_str(),
        ))
        .custom_command(settings.linux_terminal_custom_command.clone())
        .detach_from_parent(true)
}

#[cfg(target_os = "linux")]
fn linux_terminal_preference(id: &str) -> linux_terminal_launch::TerminalPreference {
    match id {
        LINUX_TERMINAL_AUTO_ID => linux_terminal_launch::TerminalPreference::Auto,
        LINUX_TERMINAL_CUSTOM_ID => linux_terminal_launch::TerminalPreference::Custom,
        other => linux_terminal_launch::TerminalPreference::registered(other),
    }
}

#[tauri::command]
pub async fn get_commit_markers(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<CommitMarkers, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .get_commit_markers(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_commit_files(
    request: CommitFilesRequest,
    app: tauri::AppHandle,
) -> Result<Vec<CommitFileItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .get_commit_files(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_commit_details(
    request: CommitDetailsRequest,
    app: tauri::AppHandle,
) -> Result<CommitDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .get_commit_details(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn validate_repo_path(
    repo_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .validate_repo_path(&repo_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn init_repo(repo_path: String) -> Result<OperationResult, String> {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return Err("Repository path cannot be empty".to_string());
    }

    let path = std::path::PathBuf::from(repo_path);
    if path.exists() && !path.is_dir() {
        return Err("Repository path must be a directory".to_string());
    }
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {e}"))?;
    }

    if path.join(".git").exists() {
        return Ok(OperationResult {
            message: format!("Repository already initialised at {}", path.display()),
            output: None,
            repo_path: Some(path.to_string_lossy().to_string()),
            backend_used: "git-cli".to_string(),
            interpreted_error: None,
        });
    }

    let mut command = crate::git_command();
    configure_command(&mut command);
    command.arg("init").arg("-b").arg("main").current_dir(&path);
    let output = command
        .output()
        .map_err(|e| format!("Failed to launch git: {e}"))?;

    if !output.status.success() {
        let mut fallback = crate::git_command();
        configure_command(&mut fallback);
        fallback.arg("init").current_dir(&path);
        let fallback_output = fallback
            .output()
            .map_err(|e| format!("Failed to launch git: {e}"))?;
        if !fallback_output.status.success() {
            let stderr = String::from_utf8_lossy(&fallback_output.stderr)
                .trim()
                .to_string();
            return Err(if stderr.is_empty() {
                "Failed to initialise repository".to_string()
            } else {
                stderr
            });
        }
    }

    Ok(OperationResult {
        message: format!("Initialised repository at {}", path.display()),
        output: None,
        repo_path: Some(path.to_string_lossy().to_string()),
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

#[tauri::command]
pub fn path_is_nonempty_dir(path: String) -> bool {
    let path = PathBuf::from(path.trim());
    if !path.is_dir() {
        return false;
    }
    path.read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn local_copy_repo(
    request: LocalCopyRequest,
    on_progress: tauri::ipc::Channel<LocalCopyProgress>,
    cancel_flag: tauri::State<'_, CloneCancelFlag>,
    operation: tauri::State<'_, crate::LocalCopyOperation>,
    state: tauri::State<'_, AppState>,
) -> Result<LocalCopyResult, LocalCopyError> {
    require_local_copy_enabled(state.git_service.get_settings().enable_local_copy)?;

    let source = request.source.trim().to_string();
    let destination = PathBuf::from(request.destination.trim());

    // Single-flight guard.  Reset the shared cancel flag after acquire so
    // a stale cancellation does not poison this operation.
    let _guard = acquire_single_flight(&operation.0)?;
    cancel_flag.0.store(false, Ordering::Relaxed);

    let result = run_local_copy_operation(
        &source,
        &destination,
        request.copy_mode,
        request.destination_mode,
        on_progress,
        cancel_flag.0.clone(),
    )
    .await;

    result
}

/// RAII guard that releases the single-flight lock on drop.
struct SingleFlightGuard<'a>(&'a Mutex<Option<Arc<AtomicBool>>>);

impl<'a> Drop for SingleFlightGuard<'a> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = None;
        }
    }
}

fn acquire_single_flight<'a>(
    lock: &'a Mutex<Option<Arc<AtomicBool>>>,
) -> Result<SingleFlightGuard<'a>, LocalCopyError> {
    let mut guard = lock.lock().map_err(|_| {
        local_copy_error("filesystemFailure", None, Some("Internal lock poisoned".to_string()))
    })?;
    if guard.is_some() {
        return Err(local_copy_error("busy", None, None));
    }
    *guard = Some(Arc::new(AtomicBool::new(false)));
    Ok(SingleFlightGuard(lock))
}

/// Helper so the compiler knows we never hold the mutex across awaits.
async fn run_local_copy_operation(
    source: &str,
    destination: &Path,
    copy_mode: LocalCopyMode,
    destination_mode: LocalCopyDestinationMode,
    on_progress: tauri::ipc::Channel<LocalCopyProgress>,
    shared_cancel: Arc<AtomicBool>,
) -> Result<LocalCopyResult, LocalCopyError> {
    send_local_copy_phase(&on_progress, LocalCopyProgressPhase::Preparing);

    let cancel = Arc::new(AtomicBool::new(false));

    // Propagate shared cancel requests to the operation-scoped flag.
    let cancellation_watch = CancelWatch::new(cancel.clone(), shared_cancel);

    let warning = match copy_mode {
        LocalCopyMode::CompleteRepository => {
            validate_complete_repository_copy_request(source, destination)?;
            run_complete_repository_copy(source, destination, on_progress, cancel.clone()).await?
        }
        LocalCopyMode::FilesOnly => {
            validate_files_only_copy_request(source, destination)?;
            run_files_only_copy(
                source,
                destination,
                destination_mode,
                on_progress,
                cancel.clone(),
            )
            .await?
        }
    };

    drop(cancellation_watch);

    Ok(LocalCopyResult {
        destination_path: destination.to_string_lossy().to_string(),
        backend: "git-cli".to_string(),
        warning,
    })
}

struct CancelWatch(Option<tokio::task::JoinHandle<()>>);

impl CancelWatch {
    fn new(cancel: Arc<AtomicBool>, shared_cancel: Arc<AtomicBool>) -> Self {
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                if shared_cancel.load(Ordering::Relaxed) {
                    cancel.store(true, Ordering::Relaxed);
                    break;
                }
            }
        });
        Self(Some(handle))
    }
}

impl Drop for CancelWatch {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

fn require_local_copy_enabled(enabled: bool) -> Result<(), LocalCopyError> {
    if enabled {
        Ok(())
    } else {
        Err(local_copy_error("featureDisabled", None, None))
    }
}

fn validate_complete_repository_copy_request(
    source: &str,
    destination: &Path,
) -> Result<(), LocalCopyError> {
    validate_local_copy_source(source)?;
    validate_destination_path(destination)?;
    validate_source_destination_overlap(source, destination)?;

    if destination.exists() {
        return Err(local_copy_error(
            "destinationExists",
            Some(destination),
            None,
        ));
    }

    Ok(())
}

fn validate_files_only_copy_request(
    source: &str,
    destination: &Path,
) -> Result<(), LocalCopyError> {
    validate_local_copy_source(source)?;
    validate_destination_path(destination)?;
    validate_source_destination_overlap(source, destination)
}

fn validate_local_copy_source(source: &str) -> Result<(), LocalCopyError> {
    if source.is_empty() {
        return Err(local_copy_error("invalidSource", None, None));
    }
    if source.starts_with('-') {
        return Err(local_copy_error("invalidSource", None, None));
    }
    if source.chars().any(char::is_control) {
        return Err(local_copy_error("invalidSource", None, None));
    }

    let source_path = PathBuf::from(source);
    if source_path.exists() && !source_path.is_dir() {
        return Err(local_copy_error("invalidSource", Some(&source_path), None));
    }

    Ok(())
}

fn validate_destination_path(destination: &Path) -> Result<(), LocalCopyError> {
    if destination.as_os_str().is_empty() {
        return Err(local_copy_error("invalidDestination", None, None));
    }
    if destination.exists() && !destination.is_dir() {
        return Err(local_copy_error(
            "invalidDestination",
            Some(destination),
            None,
        ));
    }
    canonical_destination_path(destination)?;
    Ok(())
}

fn validate_source_destination_overlap(
    source: &str,
    destination: &Path,
) -> Result<(), LocalCopyError> {
    let source_local = resolve_source_path(source);
    let Some(source_path) = source_local else {
        return Ok(());
    };
    if !source_path.exists() {
        return Ok(());
    }

    let source_canonical = source_path.canonicalize().map_err(|error| {
        local_copy_error("invalidSource", Some(&source_path), Some(error.to_string()))
    })?;
    let destination_canonical = canonical_destination_path(destination)?;

    if paths_are_same_or_ancestor(&source_canonical, &destination_canonical) {
        return Err(local_copy_error(
            "overlappingPaths",
            Some(destination),
            None,
        ));
    }

    Ok(())
}

/// Resolve a source string that may be a `file://` URL to a local `PathBuf`.
/// Returns `None` for remote sources.
fn resolve_source_path(source: &str) -> Option<PathBuf> {
    if let Some(local_path) = source.strip_prefix("file://") {
        #[cfg(windows)]
        let local_path = local_path.strip_prefix('/').unwrap_or(local_path);
        return Some(PathBuf::from(local_path));
    }
    let path = PathBuf::from(source);
    if path.exists() {
        return Some(path);
    }
    None
}

/// Check whether two canonical paths are identical or one is an ancestor of
/// the other.  Handles case-insensitive filesystems where the canonical form
/// may not detect collisions on its own.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn paths_are_same_or_ancestor(a: &Path, b: &Path) -> bool {
    a == b || b.starts_with(a) || a.starts_with(b)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn paths_are_same_or_ancestor(a: &Path, b: &Path) -> bool {
    fn lower(path: &Path) -> String {
        path.to_string_lossy().to_lowercase()
    }
    let a_lower = lower(a);
    let b_lower = lower(b);
    if a_lower == b_lower {
        return true;
    }
    // Only treat b as a descendant of a when b's canonicalised path starts
    // with a followed by a separator (handles both / and \ on Windows).
    fn is_boundary(prefix: &str, candidate: &str) -> bool {
        candidate
            .as_bytes()
            .get(prefix.len())
            .is_some_and(|&b| std::path::is_separator(char::from(b)))
    }
    (b_lower.starts_with(&a_lower) && is_boundary(&a_lower, &b_lower))
        || (a_lower.starts_with(&b_lower) && is_boundary(&b_lower, &a_lower))
}

fn canonical_destination_path(destination: &Path) -> Result<PathBuf, LocalCopyError> {
    if destination.exists() {
        return destination.canonicalize().map_err(|error| {
            local_copy_error(
                "invalidDestination",
                Some(destination),
                Some(error.to_string()),
            )
        });
    }

    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = parent.canonicalize().map_err(|error| {
        local_copy_error("invalidDestination", Some(parent), Some(error.to_string()))
    })?;
    let name = destination
        .file_name()
        .ok_or_else(|| local_copy_error("invalidDestination", Some(destination), None))?;
    Ok(parent.join(name))
}

async fn run_complete_repository_copy(
    source: &str,
    destination: &Path,
    on_progress: tauri::ipc::Channel<LocalCopyProgress>,
    cancel: Arc<AtomicBool>,
) -> Result<Option<LocalCopyWarning>, LocalCopyError> {
    let workspace = create_copy_workspace(destination)?;
    let staged_repository = workspace.join("repository");
    send_local_copy_phase(&on_progress, LocalCopyProgressPhase::Cloning);

    let clone_result = run_local_copy_git_clone(
        source,
        &staged_repository,
        true,
        on_progress.clone(),
        cancel.clone(),
    )
    .await;
    if let Err(error) = clone_result {
        drop(std::fs::remove_dir_all(&workspace));
        return Err(error);
    }

    if let Err(error) = check_local_copy_cancelled(&cancel) {
        drop(std::fs::remove_dir_all(&workspace));
        return Err(error);
    }
    send_local_copy_phase(&on_progress, LocalCopyProgressPhase::Finalising);
    std::fs::rename(&staged_repository, destination).map_err(|error| {
        drop(std::fs::remove_dir_all(&workspace));
        local_copy_error(
            "filesystemFailure",
            Some(destination),
            Some(error.to_string()),
        )
    })?;

    Ok(cleanup_workspace_warning(&workspace))
}

async fn run_files_only_copy(
    source: &str,
    destination: &Path,
    destination_mode: LocalCopyDestinationMode,
    on_progress: tauri::ipc::Channel<LocalCopyProgress>,
    cancel: Arc<AtomicBool>,
) -> Result<Option<LocalCopyWarning>, LocalCopyError> {
    send_local_copy_phase(&on_progress, LocalCopyProgressPhase::Scanning);
    let local_source = resolve_source_path(source);
    let source_is_local = local_source.is_some();
    let local_source = local_source.unwrap_or_else(|| PathBuf::from(source));

    // Perform preflight and validation inside spawn_blocking to avoid
    // blocking the async runtime during recursive tree scans and Git
    // subprocess calls.
    let (preserve_destination_git, destination_identity) = {
        let destination = destination.to_path_buf();
        let local_source = if source_is_local {
            Some(local_source.clone())
        } else {
            None
        };
        let cancel = cancel.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(ref src) = local_source {
                preflight_working_tree(src, &cancel)?;
                validate_local_submodules(src, &cancel)?;
            }
            let preserve = validate_destination_repository(&destination)?;
            preflight_destination(&destination, &cancel)?;
            let identity = record_destination_identity(&destination)?;
            Ok::<_, LocalCopyError>((preserve, identity))
        })
        .await
        .map_err(|error| {
            local_copy_error("filesystemFailure", None, Some(error.to_string()))
        })??
    };

    let workspace = create_copy_workspace(destination)?;
    let staged_source = workspace.join("source");
    let copy_source = if source_is_local {
        local_source
    } else {
        send_local_copy_phase(&on_progress, LocalCopyProgressPhase::Cloning);
        if let Err(error) = run_local_copy_git_clone(
            source,
            &staged_source,
            true,
            on_progress.clone(),
            cancel.clone(),
        )
        .await
        {
            drop(std::fs::remove_dir_all(&workspace));
            return Err(error);
        }
        if let Err(error) = preflight_working_tree(&staged_source, &cancel) {
            drop(std::fs::remove_dir_all(&workspace));
            return Err(error);
        }
        staged_source
    };

    // Move the heavy copy, git init, and commit operations into a blocking
    // thread so the async runtime stays responsive to cancellation and
    // other commands.
    let destination = destination.to_path_buf();
    let staged_result = workspace.join("result");
    let workspace_path = workspace;
    let workspace_path_for_result = workspace_path.clone();
    let on_progress_clone = on_progress;
    let cancel_clone = cancel;
    let identity = destination_identity;

    let staged_result_operation = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir(&staged_result).map_err(|error| {
            local_copy_error(
                "filesystemFailure",
                Some(&staged_result),
                Some(error.to_string()),
            )
        })?;
        send_local_copy_phase(&on_progress_clone, LocalCopyProgressPhase::Copying);
        if destination.exists() && destination_mode == LocalCopyDestinationMode::DropOnTop {
            copy_working_tree_preserving_nested_git(&destination, &staged_result, &cancel_clone)?;
        }
        copy_working_tree(&copy_source, &staged_result, &cancel_clone)?;

        if !preserve_destination_git {
            send_local_copy_phase(&on_progress_clone, LocalCopyProgressPhase::Initialising);
            run_git_init(&staged_result)?;
        }

        check_local_copy_cancelled(&cancel_clone)?;
        send_local_copy_phase(&on_progress_clone, LocalCopyProgressPhase::Finalising);
        commit_staged_result(
            &destination,
            &staged_result,
            &workspace_path,
            preserve_destination_git,
            Some(&on_progress_clone),
            &cancel_clone,
            &identity,
        )
    })
    .await
    .map_err(|error| {
        local_copy_error("filesystemFailure", None, Some(error.to_string()))
    })?;

    let warning = match staged_result_operation {
        Ok(warning) => warning,
        Err(error) => {
            if error.code != "rollbackFailure" {
                drop(std::fs::remove_dir_all(&workspace_path_for_result));
            }
            return Err(error);
        }
    };
    Ok(warning.or_else(|| cleanup_workspace_warning(&workspace_path_for_result)))
}

fn run_git_init(path: &Path) -> Result<(), LocalCopyError> {
    let mut command = crate::git_command();
    configure_command(&mut command);
    command.arg("init").arg("-b").arg("main").current_dir(path);
    let output = command
        .output()
        .map_err(|error| local_copy_error("gitFailure", Some(path), Some(error.to_string())))?;

    if output.status.success() {
        return Ok(());
    }

    let mut fallback = crate::git_command();
    configure_command(&mut fallback);
    fallback.arg("init").current_dir(path);
    let fallback_output = fallback
        .output()
        .map_err(|error| local_copy_error("gitFailure", Some(path), Some(error.to_string())))?;
    if fallback_output.status.success() {
        return Ok(());
    }

    Err(local_copy_error(
        "gitFailure",
        Some(path),
        Some(
            String::from_utf8_lossy(&fallback_output.stderr)
                .trim()
                .to_string(),
        ),
    ))
}

fn local_copy_error(code: &str, path: Option<&Path>, detail: Option<String>) -> LocalCopyError {
    LocalCopyError {
        code: code.to_string(),
        path: path.map(|value| value.to_string_lossy().to_string()),
        detail,
    }
}

fn send_local_copy_phase(
    on_progress: &tauri::ipc::Channel<LocalCopyProgress>,
    phase: LocalCopyProgressPhase,
) {
    drop(on_progress.send(LocalCopyProgress::Phase { phase }));
}

fn check_local_copy_cancelled(cancel: &AtomicBool) -> Result<(), LocalCopyError> {
    if cancel.load(Ordering::Relaxed) {
        Err(local_copy_error("cancelled", None, None))
    } else {
        Ok(())
    }
}

fn create_copy_workspace(destination: &Path) -> Result<PathBuf, LocalCopyError> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| {
            local_copy_error("filesystemFailure", Some(parent), Some(error.to_string()))
        })?
        .as_nanos();

    for attempt in 0..100_u8 {
        let workspace = parent.join(format!(
            ".gitmun-local-copy-{}-{timestamp}-{attempt}",
            std::process::id()
        ));
        match std::fs::create_dir(&workspace) {
            Ok(()) => return Ok(workspace),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(local_copy_error(
                    "filesystemFailure",
                    Some(&workspace),
                    Some(error.to_string()),
                ));
            }
        }
    }

    Err(local_copy_error(
        "filesystemFailure",
        Some(parent),
        Some("Unable to allocate a unique staging directory".to_string()),
    ))
}

fn cleanup_workspace_warning(workspace: &Path) -> Option<LocalCopyWarning> {
    if !workspace.exists() {
        return None;
    }
    // Normalise directory permissions so read-only files can be removed.
    let _ = make_tree_writable(workspace);
    std::fs::remove_dir_all(workspace)
        .err()
        .map(|error| LocalCopyWarning {
            code: "backupCleanupFailed".to_string(),
            path: Some(workspace.to_string_lossy().to_string()),
            detail: Some(error.to_string()),
        })
}

/// Recursively make every entry in `root` writable so `remove_dir_all` can succeed.
fn make_tree_writable(root: &Path) -> Result<(), std::io::Error> {
    if !root.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            make_tree_writable(&path)?;
        }
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(&path, permissions);
        }
    }
    Ok(())
}

fn record_destination_identity(destination: &Path) -> Result<Option<DestinationIdentity>, LocalCopyError> {
    if !destination.exists() {
        return Ok(Some(DestinationIdentity::Absent));
    }
    // Record the set of top-level entries at the destination.  If the
    // destination appears or changes during staging we will detect it
    // before committing.
    let entries = std::fs::read_dir(destination).map_err(|error| {
        local_copy_error("filesystemFailure", Some(destination), Some(error.to_string()))
    })?;
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            local_copy_error("filesystemFailure", Some(destination), Some(error.to_string()))
        })?;
        if !is_git_metadata_name(&entry.file_name()) {
            names.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    let canonical = canonical_destination_path(destination)?;
    Ok(Some(DestinationIdentity::Present {
        canonical_path: canonical,
        top_level_names: names,
    }))
}

fn check_destination_unchanged(destination: &Path, identity: &Option<DestinationIdentity>) -> Result<(), LocalCopyError> {
    let Some(id) = identity else { return Ok(()); };
    match id {
        DestinationIdentity::Absent => {
            if destination.exists() {
                return Err(local_copy_error("destinationChanged", Some(destination), None));
            }
        }
        DestinationIdentity::Present { canonical_path, top_level_names } => {
            if !destination.exists() {
                return Err(local_copy_error("destinationChanged", Some(destination), None));
            }
            // Canonical path should remain the same (detects replacement with symlink etc.)
            let current_canonical = canonical_destination_path(destination)?;
            if &current_canonical != canonical_path {
                return Err(local_copy_error("destinationChanged", Some(destination), None));
            }
            // Top-level entries should match exactly (neither added nor removed).
            // This is required because commit_staged_result moves *all* current
            // top-level entries to backup and deletes the backup on success.
            let current_entries = std::fs::read_dir(destination).map_err(|error| {
                local_copy_error("filesystemFailure", Some(destination), Some(error.to_string()))
            })?;
            let current_names: std::collections::HashSet<String> = current_entries
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    if is_git_metadata_name(&entry.file_name()) {
                        None
                    } else {
                        Some(entry.file_name().to_string_lossy().to_string())
                    }
                })
                .collect();
            if current_names != top_level_names.iter().cloned().collect::<std::collections::HashSet<String>>() {
                return Err(local_copy_error("destinationChanged", Some(destination), None));
            }
        }
    }
    Ok(())
}

enum DestinationIdentity {
    Absent,
    Present {
        canonical_path: PathBuf,
        top_level_names: Vec<String>,
    },
}

/// Check whether a filename is a Git metadata entry (`.git`, `.GIT`, etc.).
fn is_git_metadata_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|s| s.eq_ignore_ascii_case(".git"))
}

fn preflight_destination(destination: &Path, cancel: &AtomicBool) -> Result<(), LocalCopyError> {
    if destination.exists() {
        preflight_working_tree(destination, cancel)?;
    }
    Ok(())
}

fn preflight_working_tree(source: &Path, cancel: &AtomicBool) -> Result<(), LocalCopyError> {
    check_local_copy_cancelled(cancel)?;
    let entries = std::fs::read_dir(source).map_err(|error| {
        local_copy_error("filesystemFailure", Some(source), Some(error.to_string()))
    })?;

    for entry_result in entries {
        check_local_copy_cancelled(cancel)?;
        let entry = entry_result.map_err(|error| {
            local_copy_error("filesystemFailure", Some(source), Some(error.to_string()))
        })?;
        if is_git_metadata_name(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            local_copy_error("filesystemFailure", Some(&path), Some(error.to_string()))
        })?;

        if file_type.is_dir() {
            preflight_working_tree(&path, cancel)?;
        } else if file_type.is_symlink() {
            preflight_symbolic_link(&path)?;
        } else if !file_type.is_file() {
            return Err(local_copy_error("unsupportedFileType", Some(&path), None));
        }
    }

    Ok(())
}

#[cfg(unix)]
fn preflight_symbolic_link(path: &Path) -> Result<(), LocalCopyError> {
    std::fs::read_link(path)
        .map(|_| ())
        .map_err(|error| local_copy_error("symlinkFailure", Some(path), Some(error.to_string())))
}

#[cfg(windows)]
fn preflight_symbolic_link(path: &Path) -> Result<(), LocalCopyError> {
    std::fs::read_link(path)
        .map_err(|error| local_copy_error("symlinkFailure", Some(path), Some(error.to_string())))?;
    std::fs::metadata(path)
        .map(|_| ())
        .map_err(|error| local_copy_error("symlinkFailure", Some(path), Some(error.to_string())))
}

fn validate_local_submodules(source: &Path, cancel: &AtomicBool) -> Result<(), LocalCopyError> {
    check_local_copy_cancelled(cancel)?;
    if !source.join(".gitmodules").is_file() {
        return Ok(());
    }

    if source.join(".git").exists() {
        let mut command = crate::git_command();
        configure_command(&mut command);
        command
            .arg("-C")
            .arg(source)
            .args(["submodule", "status", "--recursive"]);
        let output = command.output().map_err(|error| {
            local_copy_error("gitFailure", Some(source), Some(error.to_string()))
        })?;
        if !output.status.success() {
            return Err(local_copy_error(
                "gitFailure",
                Some(source),
                Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
            ));
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            check_local_copy_cancelled(cancel)?;
            if line.starts_with('-') || line.starts_with('U') {
                let submodule_path = line.split_whitespace().nth(1).map(PathBuf::from);
                return Err(local_copy_error(
                    "submoduleUnavailable",
                    submodule_path
                        .as_deref()
                        .map(|path| source.join(path))
                        .as_deref(),
                    None,
                ));
            }
        }
        return Ok(());
    }

    validate_declared_submodule_paths(source, cancel)
}

fn validate_declared_submodule_paths(
    source: &Path,
    cancel: &AtomicBool,
) -> Result<(), LocalCopyError> {
    let mut command = crate::git_command();
    configure_command(&mut command);
    command
        .arg("config")
        .args(["--file", ".gitmodules", "--null", "--get-regexp", "path"])
        .current_dir(source);
    let output = command
        .output()
        .map_err(|error| local_copy_error("gitFailure", Some(source), Some(error.to_string())))?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(local_copy_error(
            "gitFailure",
            Some(source),
            Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        ));
    }

    // git config --null --get-regexp produces NUL-delimited output:
    // key\nvalue\0key\nvalue\0...
    for chunk in output.stdout.split(|&b| b == 0) {
        if chunk.is_empty() {
            continue;
        }
        check_local_copy_cancelled(cancel)?;
        // Split on the first newline to separate key from value.
        let Some(newline_pos) = chunk.iter().position(|&b| b == b'\n') else {
            continue;
        };
        let relative_path = String::from_utf8_lossy(&chunk[newline_pos + 1..]).trim().to_string();
        if relative_path.is_empty() {
            continue;
        }
        let submodule = source.join(&relative_path);
        let available = submodule.is_dir()
            && std::fs::read_dir(&submodule)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);
        if !available {
            return Err(local_copy_error(
                "submoduleUnavailable",
                Some(&submodule),
                None,
            ));
        }
        validate_local_submodules(&submodule, cancel)?;
    }
    Ok(())
}

fn validate_destination_repository(destination: &Path) -> Result<bool, LocalCopyError> {
    if !destination.exists() {
        return Ok(false);
    }
    let dot_git = destination.join(".git");
    if std::fs::symlink_metadata(&dot_git).is_err() {
        return Ok(false);
    }

    let mut command = crate::git_command();
    configure_command(&mut command);
    command
        .arg("-C")
        .arg(destination)
        .args(["rev-parse", "--git-dir"]);
    let output = command.output().map_err(|error| {
        local_copy_error(
            "invalidDestination",
            Some(&dot_git),
            Some(error.to_string()),
        )
    })?;
    if !output.status.success() {
        return Err(local_copy_error(
            "invalidDestination",
            Some(&dot_git),
            Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        ));
    }
    let _git_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Reject bare repositories.
    let mut is_bare = crate::git_command();
    configure_command(&mut is_bare);
    is_bare
        .arg("-C")
        .arg(destination)
        .args(["rev-parse", "--is-bare-repository"]);
    let bare_output = is_bare.output().map_err(|error| {
        local_copy_error("invalidDestination", Some(destination), Some(error.to_string()))
    })?;
    if bare_output.status.success()
        && String::from_utf8_lossy(&bare_output.stdout).trim() == "true"
    {
        return Err(local_copy_error(
            "bareRepository",
            Some(destination),
            None,
        ));
    }

    // Validate that the working tree's toplevel matches the destination.
    // This correctly handles linked worktrees (whose .git file points to a
    // git-dir inside the main repository's worktrees/ directory) while
    // rejecting bare repos and external core.worktree destinations.
    let mut toplevel_cmd = crate::git_command();
    configure_command(&mut toplevel_cmd);
    toplevel_cmd
        .arg("-C")
        .arg(destination)
        .args(["rev-parse", "--show-toplevel"]);
    let toplevel_output = toplevel_cmd.output().map_err(|error| {
        local_copy_error("invalidDestination", Some(destination), Some(error.to_string()))
    })?;
    if !toplevel_output.status.success() {
        return Err(local_copy_error(
            "invalidDestination",
            Some(destination),
            Some(String::from_utf8_lossy(&toplevel_output.stderr).trim().to_string()),
        ));
    }
    let toplevel = String::from_utf8_lossy(&toplevel_output.stdout).trim().to_string();
    let canonical_toplevel = std::fs::canonicalize(&toplevel).unwrap_or(PathBuf::from(&toplevel));
    let canonical_destination = destination.canonicalize().unwrap_or(destination.to_path_buf());
    if canonical_toplevel != canonical_destination {
        return Err(local_copy_error(
            "externalWorktree",
            Some(destination),
            None,
        ));
    }

    // Reject destinations with core.worktree pointing elsewhere
    // (belt-and-suspenders in case --show-toplevel did not catch it).
    let mut worktree_cmd = crate::git_command();
    configure_command(&mut worktree_cmd);
    worktree_cmd
        .arg("-C")
        .arg(destination)
        .args(["config", "core.worktree"]);
    if let Ok(worktree_output) = worktree_cmd.output() {
        if worktree_output.status.success() {
            let configured = String::from_utf8_lossy(&worktree_output.stdout).trim().to_string();
            if !configured.is_empty() {
                let configured_path = if std::path::Path::new(&configured).is_absolute() {
                    PathBuf::from(&configured)
                } else {
                    destination.join(&configured)
                };
                let canonical_configured = configured_path.canonicalize().unwrap_or(configured_path);
                let canonical_destination = destination.canonicalize().unwrap_or(destination.to_path_buf());
                if canonical_configured != canonical_destination {
                    return Err(local_copy_error(
                        "externalWorktree",
                        Some(destination),
                        None,
                    ));
                }
            }
        }
    }

    Ok(true)
}

fn copy_working_tree(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<(), LocalCopyError> {
    copy_working_tree_inner(source, destination, cancel, false, 0)
}

fn copy_working_tree_preserving_nested_git(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<(), LocalCopyError> {
    copy_working_tree_inner(source, destination, cancel, true, 0)
}

fn copy_working_tree_inner(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
    preserve_nested_git: bool,
    depth: usize,
) -> Result<(), LocalCopyError> {
    check_local_copy_cancelled(cancel)?;
    let entries = std::fs::read_dir(source).map_err(|error| {
        local_copy_error("filesystemFailure", Some(source), Some(error.to_string()))
    })?;
    for entry_result in entries {
        check_local_copy_cancelled(cancel)?;
        let entry = entry_result.map_err(|error| {
            local_copy_error("filesystemFailure", Some(source), Some(error.to_string()))
        })?;
        // At the root (depth 0) always skip the root .git entry (it is handled
        // separately by commit_staged_result).  At deeper levels, skip .git
        // entries only when not preserving nested metadata (source copy).
        let is_git_entry = is_git_metadata_name(&entry.file_name());
        if is_git_entry && (depth == 0 || !preserve_nested_git) {
            continue;
        }
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            local_copy_error(
                "filesystemFailure",
                Some(&source_path),
                Some(error.to_string()),
            )
        })?;

        if file_type.is_dir() {
            if let Ok(destination_metadata) = std::fs::symlink_metadata(&destination_path) {
                if !destination_metadata.file_type().is_dir() {
                    remove_path(&destination_path)?;
                }
            }
            std::fs::create_dir_all(&destination_path).map_err(|error| {
                local_copy_error(
                    "filesystemFailure",
                    Some(&destination_path),
                    Some(error.to_string()),
                )
            })?;
            copy_working_tree_inner(&source_path, &destination_path, cancel, preserve_nested_git, depth + 1)?;
            let permissions = std::fs::metadata(&source_path)
                .map_err(|error| {
                    local_copy_error(
                        "filesystemFailure",
                        Some(&source_path),
                        Some(error.to_string()),
                    )
                })?
                .permissions();
            std::fs::set_permissions(&destination_path, permissions).map_err(|error| {
                local_copy_error(
                    "filesystemFailure",
                    Some(&destination_path),
                    Some(error.to_string()),
                )
            })?;
        } else if file_type.is_file() {
            if std::fs::symlink_metadata(&destination_path).is_ok() {
                remove_path(&destination_path)?;
            }
            copy_regular_file(&source_path, &destination_path, cancel)?;
        } else if file_type.is_symlink() {
            if std::fs::symlink_metadata(&destination_path).is_ok() {
                remove_path(&destination_path)?;
            }
            copy_symbolic_link(&source_path, &destination_path)?;
        } else {
            return Err(local_copy_error(
                "unsupportedFileType",
                Some(&source_path),
                None,
            ));
        }
    }
    Ok(())
}

fn copy_regular_file(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<(), LocalCopyError> {
    let mut source_file = std::fs::File::open(source).map_err(|error| {
        local_copy_error("filesystemFailure", Some(source), Some(error.to_string()))
    })?;
    let mut destination_file = std::fs::File::create(destination).map_err(|error| {
        local_copy_error(
            "filesystemFailure",
            Some(destination),
            Some(error.to_string()),
        )
    })?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        check_local_copy_cancelled(cancel)?;
        let bytes_read = source_file.read(&mut buffer).map_err(|error| {
            local_copy_error("filesystemFailure", Some(source), Some(error.to_string()))
        })?;
        if bytes_read == 0 {
            break;
        }
        destination_file
            .write_all(&buffer[..bytes_read])
            .map_err(|error| {
                local_copy_error(
                    "filesystemFailure",
                    Some(destination),
                    Some(error.to_string()),
                )
            })?;
    }
    let permissions = std::fs::metadata(source)
        .map_err(|error| {
            local_copy_error("filesystemFailure", Some(source), Some(error.to_string()))
        })?
        .permissions();
    std::fs::set_permissions(destination, permissions).map_err(|error| {
        local_copy_error(
            "filesystemFailure",
            Some(destination),
            Some(error.to_string()),
        )
    })
}

fn remove_path(path: &Path) -> Result<(), LocalCopyError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        local_copy_error("filesystemFailure", Some(path), Some(error.to_string()))
    })?;
    let result = if metadata.file_type().is_symlink() || metadata.is_file() {
        std::fs::remove_file(path)
    } else {
        std::fs::remove_dir_all(path)
    };
    result
        .map_err(|error| local_copy_error("filesystemFailure", Some(path), Some(error.to_string())))
}

#[cfg(unix)]
fn copy_symbolic_link(source: &Path, destination: &Path) -> Result<(), LocalCopyError> {
    let target = std::fs::read_link(source).map_err(|error| {
        local_copy_error("symlinkFailure", Some(source), Some(error.to_string()))
    })?;
    std::os::unix::fs::symlink(target, destination).map_err(|error| {
        local_copy_error("symlinkFailure", Some(destination), Some(error.to_string()))
    })
}

#[cfg(windows)]
fn copy_symbolic_link(source: &Path, destination: &Path) -> Result<(), LocalCopyError> {
    let target = std::fs::read_link(source).map_err(|error| {
        local_copy_error("symlinkFailure", Some(source), Some(error.to_string()))
    })?;
    let metadata = std::fs::metadata(source).map_err(|error| {
        local_copy_error("symlinkFailure", Some(source), Some(error.to_string()))
    })?;
    let result = if metadata.is_dir() {
        std::os::windows::fs::symlink_dir(target, destination)
    } else {
        std::os::windows::fs::symlink_file(target, destination)
    };
    result.map_err(|error| {
        local_copy_error("symlinkFailure", Some(destination), Some(error.to_string()))
    })
}

fn commit_staged_result(
    destination: &Path,
    staged_result: &Path,
    workspace: &Path,
    preserve_destination_git: bool,
    on_progress: Option<&tauri::ipc::Channel<LocalCopyProgress>>,
    cancel: &AtomicBool,
    destination_identity: &Option<DestinationIdentity>,
) -> Result<Option<LocalCopyWarning>, LocalCopyError> {
    check_local_copy_cancelled(cancel)?;
    check_destination_unchanged(destination, destination_identity)?;

    if !destination.exists() {
        std::fs::rename(staged_result, destination).map_err(|error| {
            local_copy_error(
                "filesystemFailure",
                Some(destination),
                Some(error.to_string()),
            )
        })?;
        return Ok(None);
    }

    let backup = workspace.join("backup");
    std::fs::create_dir(&backup).map_err(|error| {
        local_copy_error("filesystemFailure", Some(&backup), Some(error.to_string()))
    })?;
    let mut installed_names = Vec::new();
    let finalisation_result = (|| {
        for entry_result in std::fs::read_dir(destination).map_err(|error| {
            local_copy_error(
                "filesystemFailure",
                Some(destination),
                Some(error.to_string()),
            )
        })? {
            check_local_copy_cancelled(cancel)?;
            let entry = entry_result.map_err(|error| {
                local_copy_error(
                    "filesystemFailure",
                    Some(destination),
                    Some(error.to_string()),
                )
            })?;
            if preserve_destination_git && is_git_metadata_name(&entry.file_name()) {
                continue;
            }
            std::fs::rename(entry.path(), backup.join(entry.file_name())).map_err(|error| {
                local_copy_error(
                    "filesystemFailure",
                    Some(&entry.path()),
                    Some(error.to_string()),
                )
            })?;
        }

        for entry_result in std::fs::read_dir(staged_result).map_err(|error| {
            local_copy_error(
                "filesystemFailure",
                Some(staged_result),
                Some(error.to_string()),
            )
        })? {
            check_local_copy_cancelled(cancel)?;
            let entry = entry_result.map_err(|error| {
                local_copy_error(
                    "filesystemFailure",
                    Some(staged_result),
                    Some(error.to_string()),
                )
            })?;
            if preserve_destination_git && is_git_metadata_name(&entry.file_name()) {
                return Err(local_copy_error(
                    "filesystemFailure",
                    Some(&entry.path()),
                    Some("Staged result unexpectedly contains Git metadata".to_string()),
                ));
            }
            let name = entry.file_name();
            std::fs::rename(entry.path(), destination.join(&name)).map_err(|error| {
                local_copy_error(
                    "filesystemFailure",
                    Some(&entry.path()),
                    Some(error.to_string()),
                )
            })?;
            installed_names.push(name);
        }
        Ok(())
    })();

    if let Err(finalisation_error) = finalisation_result {
        if let Some(progress_channel) = on_progress {
            send_local_copy_phase(progress_channel, LocalCopyProgressPhase::RollingBack);
        }
        if let Err(rollback_error) =
            rollback_staged_result(destination, staged_result, &backup, &installed_names)
        {
            return Err(local_copy_error(
                "rollbackFailure",
                Some(&backup),
                Some(format!(
                    "Finalisation failed: {}; rollback failed: {}",
                    finalisation_error.detail.unwrap_or_default(),
                    rollback_error.detail.unwrap_or_default()
                )),
            ));
        }
        return Err(finalisation_error);
    }

    let _ = make_tree_writable(&backup);
    if let Err(error) = std::fs::remove_dir_all(&backup) {
        return Ok(Some(LocalCopyWarning {
            code: "backupCleanupFailed".to_string(),
            path: Some(backup.to_string_lossy().to_string()),
            detail: Some(error.to_string()),
        }));
    }
    Ok(None)
}

fn rollback_staged_result(
    destination: &Path,
    staged_result: &Path,
    backup: &Path,
    installed_names: &[std::ffi::OsString],
) -> Result<(), LocalCopyError> {
    for name in installed_names.iter().rev() {
        let installed_path = destination.join(name);
        if std::fs::symlink_metadata(&installed_path).is_ok() {
            std::fs::rename(&installed_path, staged_result.join(name)).map_err(|error| {
                local_copy_error("rollbackFailure", Some(backup), Some(error.to_string()))
            })?;
        }
    }
    for entry_result in std::fs::read_dir(backup).map_err(|error| {
        local_copy_error("rollbackFailure", Some(backup), Some(error.to_string()))
    })? {
        let entry = entry_result.map_err(|error| {
            local_copy_error("rollbackFailure", Some(backup), Some(error.to_string()))
        })?;
        std::fs::rename(entry.path(), destination.join(entry.file_name())).map_err(|error| {
            local_copy_error("rollbackFailure", Some(backup), Some(error.to_string()))
        })?;
    }
    Ok(())
}

async fn run_local_copy_git_clone(
    source: &str,
    destination: &Path,
    recursive_submodules: bool,
    on_progress: tauri::ipc::Channel<LocalCopyProgress>,
    cancel: Arc<AtomicBool>,
) -> Result<(), LocalCopyError> {
    let destination_path = destination.to_path_buf();
    let mut command = crate::git_command();
    configure_command(&mut command);
    command.args(["clone", "--progress"]);
    if recursive_submodules {
        command.arg("--recurse-submodules");
    }
    command
        .arg(source)
        .arg(destination)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());

    let mut child = command.spawn().map_err(|error| {
        local_copy_error("gitFailure", Some(destination), Some(error.to_string()))
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        local_copy_error(
            "gitFailure",
            Some(destination),
            Some("Git clone stderr was unavailable".to_string()),
        )
    })?;
    let progress_thread = std::thread::spawn(move || -> String {
        let mut reader = std::io::BufReader::new(stderr);
        let mut buffer = [0_u8; 4096];
        let mut partial = String::new();
        let mut collected = String::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(bytes_read) => {
                    partial.push_str(&String::from_utf8_lossy(&buffer[..bytes_read]));
                    let lines: Vec<&str> = partial.split(['\r', '\n']).collect();
                    for part in &lines[..lines.len() - 1] {
                        let line = part.trim();
                        if !line.is_empty() {
                            collected.push_str(line);
                            collected.push('\n');
                            drop(on_progress.send(LocalCopyProgress::ExternalOutput {
                                line: line.to_string(),
                            }));
                        }
                    }
                    partial = lines.last().unwrap_or(&"").to_string();
                }
                Err(_) => break,
            }
        }
        let remaining = partial.trim();
        if !remaining.is_empty() {
            collected.push_str(remaining);
            collected.push('\n');
            drop(on_progress.send(LocalCopyProgress::ExternalOutput {
                line: remaining.to_string(),
            }));
        }
        collected
    });

    tauri::async_runtime::spawn_blocking(move || -> Result<(), LocalCopyError> {
        loop {
            match child.try_wait().map_err(|error| {
                local_copy_error(
                    "gitFailure",
                    Some(&destination_path),
                    Some(error.to_string()),
                )
            })? {
                Some(status) => {
                    let output = progress_thread.join().unwrap_or_default();
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(local_copy_error(
                            "gitFailure",
                            Some(&destination_path),
                            Some(output.trim_end().to_string()),
                        ))
                    };
                }
                None if cancel.load(Ordering::Relaxed) => {
                    drop(child.kill());
                    drop(child.wait());
                    drop(progress_thread.join());
                    return Err(local_copy_error("cancelled", None, None));
                }
                None => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
    })
    .await
    .map_err(|error| {
        local_copy_error(
            "filesystemFailure",
            Some(destination),
            Some(error.to_string()),
        )
    })?
}

async fn run_git_clone_with_progress(
    repo_url: &str,
    final_dest_str: &str,
    on_progress: tauri::ipc::Channel<String>,
    cancel: Arc<AtomicBool>,
    dest_existed: bool,
) -> Result<(), String> {
    let cleanup_path = final_dest_str.to_string();
    let mut cmd = crate::git_command();
    configure_command(&mut cmd);
    cmd.args(["clone", "--progress", repo_url, final_dest_str])
        .stderr(Stdio::piped())
        .stdout(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch git: {e}"))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture git clone stderr".to_string())?;

    let reader_thread = std::thread::spawn(move || -> String {
        let mut reader = std::io::BufReader::new(stderr);
        let mut buf = [0u8; 4096];
        let mut partial = String::new();
        let mut collected = String::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    partial.push_str(&chunk);
                    let parts: Vec<&str> = partial.split(|c| c == '\r' || c == '\n').collect();
                    for part in &parts[..parts.len() - 1] {
                        let line = part.trim();
                        if !line.is_empty() {
                            collected.push_str(line);
                            collected.push('\n');
                            let _ = on_progress.send(line.to_string());
                        }
                    }
                    partial = parts.last().unwrap_or(&"").to_string();
                }
                Err(_) => break,
            }
        }

        let remaining = partial.trim().to_string();
        if !remaining.is_empty() {
            collected.push_str(&remaining);
            collected.push('\n');
            let _ = on_progress.send(remaining.clone());
        }
        collected
    });

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        loop {
            match child.try_wait().map_err(|e| format!("Clone error: {e}"))? {
                Some(status) => {
                    let stderr_output = reader_thread.join().unwrap_or_default();
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(format!("Clone failed: {}", stderr_output.trim_end()))
                    };
                }
                None => {
                    if cancel.load(Ordering::Relaxed) {
                        child.kill().ok();
                        child.wait().ok();
                        reader_thread.join().ok();
                        if !dest_existed {
                            let _ = std::fs::remove_dir_all(&cleanup_path);
                        }
                        return Err("Clone cancelled.".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Internal error: {e}"))?
}

#[tauri::command]
pub async fn clone_repo(
    request: CloneRequest,
    on_progress: tauri::ipc::Channel<String>,
    cancel_flag: tauri::State<'_, CloneCancelFlag>,
    operation: tauri::State<'_, crate::LocalCopyOperation>,
) -> Result<OperationResult, String> {
    use crate::git::cli::CliGitHandler;

    let repo_url = request.repo_url.trim().to_string();
    let destination = request.destination.trim().to_string();

    CliGitHandler::validate_clone_repo_url(&repo_url).map_err(|e| e.to_string())?;

    let final_dest = CliGitHandler::resolve_clone_destination(&repo_url, &destination)
        .map_err(|e| e.to_string())?;
    let final_dest_str = final_dest.to_string_lossy().to_string();
    let dest_existed = final_dest.exists();

    // Single-flight: reject if a copy is in progress.  Reset shared cancel
    // after acquire so a stale cancellation does not poison this clone.
    let _guard = acquire_single_flight(&operation.0).map_err(|e| e.code)?;
    cancel_flag.0.store(false, Ordering::Relaxed);

    run_git_clone_with_progress(
        &repo_url,
        &final_dest_str,
        on_progress,
        cancel_flag.0.clone(),
        dest_existed,
    )
    .await?;

    Ok(OperationResult {
        message: format!("Cloned repository to {}", final_dest.display()),
        output: None,
        repo_path: Some(final_dest_str),
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

#[tauri::command]
pub fn cancel_clone(flag: tauri::State<'_, CloneCancelFlag>) {
    flag.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_default_clone_dir() -> String {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join("GitmunProjects")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub fn open_external_diff(
    request: ExternalDiffRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .open_external_diff(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_working_tree_diff(
    request: DiffRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .open_working_tree_diff(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn check_patch_file(
    request: ImportPatchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .check_patch_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_patch_file(
    request: ImportPatchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .import_patch_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_patch_file(
    request: ExportPatchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .export_patch_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_commit_patch_file(
    request: ExportCommitPatchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .export_commit_patch_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_repo_diff_tool(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    state
        .git_service
        .get_configured_diff_tool(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pull_changes(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.pull_changes(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn analyze_pull(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<PullAnalysis, String> {
    state
        .git_service
        .analyze_pull(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pull_with_strategy(
    request: PullStrategyRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .pull_with_strategy(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_repo_status(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<RepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_repo_status(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_numstat(
    request: NumstatRequest,
    app: tauri::AppHandle,
) -> Result<NumstatResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_numstat(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stage_files(
    request: StageFilesRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.stage_files(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn commit_changes(
    request: CommitRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.commit_changes(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_commit_message_recovery(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CommitMessageRecovery>, String> {
    state
        .git_service
        .get_commit_message_recovery(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_diff(request: DiffRequest, app: tauri::AppHandle) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_diff(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn unstage_file(
    request: FileRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.unstage_file(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn unstage_all(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.unstage_all(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stage_all(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.stage_all(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stage_hunk(
    request: HunkStageRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stage_hunk(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn unstage_hunk(
    request: HunkStageRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .unstage_hunk(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn discard_file(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .discard_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_init(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_init(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_update(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_update(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_sync(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_sync(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_fetch(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_fetch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_pull(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_pull(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn fetch_remote(
    request: FetchRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.fetch_remote(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stash(
    request: StashPushRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stash_list(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<Vec<StashEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.stash_list(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stash_apply(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_apply(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stash_pop(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_pop(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stash_drop(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_drop(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_identity(
    request: IdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<GitIdentity, String> {
    state
        .git_service
        .get_identity(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_identity(
    request: SetIdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .set_identity(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_ssh_allowed_signer_status(
    request: IdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshAllowedSignerStatus, String> {
    state
        .git_service
        .get_ssh_allowed_signer_status(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_ssh_signing_key_to_allowed_signers(
    request: IdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .add_ssh_signing_key_to_allowed_signers(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn push_changes(
    request: PushRequest,
    app: tauri::AppHandle,
) -> Result<PushResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.push_changes(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_avatar(
    email: String,
    repo_path: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    // Clone the Arc before any await so the non-'static State borrow is not
    // captured in the async generator.
    let service = app.state::<AppState>().avatar_service.clone();
    tauri::async_runtime::spawn_blocking(move || service.fetch(&email, &repo_path))
        .await
        .map_err(|e| e.to_string())
}
