use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

use gitmun_lib::git::cli::CliGitHandler;
use gitmun_lib::git::error_interpretation::GitErrorCategory;
use gitmun_lib::git::gix_handler::GixGitHandler;
use gitmun_lib::git::handler::GitOperationHandler;
use gitmun_lib::git::types::{
    CommitDetailsRequest, CommitHistoryRequest, CommitLogScope, CommitRefKind, CommitRequest,
    CreateBranchRequest, DeleteBranchRequest, ExportCommitPatchRequest, ExportPatchFileSelection,
    ExportPatchRequest, ExportPatchScope, FileRequest, IdentityRequest, IdentityScope,
    ImportPatchRequest, PushFailureKind, PushRequest, RepoRequest, RepoStatus, ResetMode,
    ResetRequest, SetBranchUpstreamRequest, SetIdentityRequest, SshAllowedSignerReason,
    StageFilesRequest, SubmoduleActionRequest, SubmoduleState, UnversionedItemKind,
};

fn init_repo() -> TempDir {
    let dir = TempDir::new().expect("create temp dir");
    let path = dir.path();
    git(path, &["init", "-b", "main"]);
    git(path, &["config", "user.email", "test@gitmun.test"]);
    git(path, &["config", "user.name", "Gitmun Test"]);
    git(path, &["config", "commit.gpgsign", "false"]);
    git(path, &["config", "core.autocrlf", "false"]);
    // Initial empty commit so HEAD exists
    git(path, &["commit", "--allow-empty", "-m", "init"]);
    dir
}

fn init_unborn_repo() -> TempDir {
    let dir = TempDir::new().expect("create temp dir");
    let path = dir.path();
    git(path, &["init", "-b", "main"]);
    git(path, &["config", "user.email", "test@gitmun.test"]);
    git(path, &["config", "user.name", "Gitmun Test"]);
    git(path, &["config", "commit.gpgsign", "false"]);
    dir
}

fn git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git command");
    assert!(status.success(), "git {:?} failed", args);
}

fn git_stdout(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("git command output");
    assert!(output.status.success(), "git {:?} failed", args);
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn git_with_env(repo: &Path, args: &[&str], envs: &[(&str, &str)]) {
    let mut command = Command::new("git");
    command.args(args).current_dir(repo);
    for (key, value) in envs {
        command.env(key, value);
    }
    let status = command.status().expect("git command with env");
    assert!(status.success(), "git {:?} failed", args);
}

fn write_file(repo: &Path, name: &str, content: &str) {
    fs::write(repo.join(name), content).expect("write file");
}

fn read_file(repo: &Path, name: &str) -> String {
    fs::read_to_string(repo.join(name)).expect("read file")
}

fn repo_request(dir: &TempDir) -> RepoRequest {
    RepoRequest {
        repo_path: dir.path().to_str().unwrap().to_string(),
    }
}

fn file_request(dir: &TempDir, path: &str) -> FileRequest {
    FileRequest {
        repo_path: dir.path().to_str().unwrap().to_string(),
        file_path: path.to_string(),
    }
}

fn identity_request(dir: &TempDir) -> IdentityRequest {
    IdentityRequest {
        repo_path: dir.path().to_str().unwrap().to_string(),
        scope: IdentityScope::Local,
    }
}

fn set_local_identity(dir: &TempDir, email: Option<&str>, signing_key: Option<&str>, format: &str) {
    handler()
        .set_identity(&SetIdentityRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            scope: IdentityScope::Local,
            name: Some("Gitmun Test".to_string()),
            email: email.map(str::to_string),
            signing_key: signing_key.map(str::to_string),
            signing_format: Some(format.to_string()),
            ssh_key_path: None,
            commit_signing_enabled: Some(true),
        })
        .expect("set identity");
}

fn handler() -> CliGitHandler {
    CliGitHandler
}

fn gix_handler() -> GixGitHandler {
    GixGitHandler::new()
}

fn init_remote_with_clone() -> (TempDir, TempDir) {
    let remote = TempDir::new().expect("create remote dir");
    git(remote.path(), &["init", "--bare", "-b", "main"]);

    let local = TempDir::new().expect("create local dir");
    git(local.path(), &["init", "-b", "main"]);
    git(local.path(), &["config", "user.email", "test@gitmun.test"]);
    git(local.path(), &["config", "user.name", "Gitmun Test"]);
    git(local.path(), &["config", "commit.gpgsign", "false"]);
    git(
        local.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    write_file(local.path(), "seed.txt", "seed");
    git(local.path(), &["add", "seed.txt"]);
    git(local.path(), &["commit", "-m", "seed"]);
    git(local.path(), &["push", "-u", "origin", "main"]);
    (remote, local)
}

fn init_submodule_source() -> TempDir {
    let dir = init_repo();
    write_file(dir.path(), "lib.txt", "v1");
    git(dir.path(), &["add", "lib.txt"]);
    git(dir.path(), &["commit", "-m", "add lib"]);
    dir
}

fn repo_with_submodule() -> (TempDir, TempDir) {
    let parent = init_repo();
    let submodule = init_submodule_source();
    let submodule_path = submodule.path().to_str().unwrap();
    git(
        parent.path(),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            submodule_path,
            "deps/lib",
        ],
    );
    git(parent.path(), &["commit", "-m", "add submodule"]);
    (parent, submodule)
}

fn head_hash(repo: &Path) -> String {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo)
        .output()
        .expect("rev-parse HEAD");
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn details_request(dir: &TempDir, hash: &str) -> CommitDetailsRequest {
    CommitDetailsRequest {
        repo_path: dir.path().to_str().unwrap().to_string(),
        commit_hash: hash.to_string(),
    }
}

fn history_request(dir: &TempDir) -> CommitHistoryRequest {
    CommitHistoryRequest {
        repo_path: dir.path().to_str().unwrap().to_string(),
        limit: Some(10),
        after_hash: None,
        offset: None,
        commit_date_mode: Default::default(),
        scope: Default::default(),
    }
}

fn commit_with_identities(
    repo: &Path,
    file_name: &str,
    message: &str,
    author: (&str, &str),
    committer: (&str, &str),
) -> String {
    write_file(repo, file_name, message);
    git(repo, &["add", file_name]);
    git_with_env(
        repo,
        &["commit", "-m", message],
        &[
            ("GIT_AUTHOR_NAME", author.0),
            ("GIT_AUTHOR_EMAIL", author.1),
            ("GIT_COMMITTER_NAME", committer.0),
            ("GIT_COMMITTER_EMAIL", committer.1),
        ],
    );
    head_hash(repo)
}

fn push_request(repo: &TempDir) -> PushRequest {
    PushRequest {
        repo_path: repo.path().to_str().unwrap().to_string(),
        remote: None,
        remote_branch: None,
        set_upstream: false,
        force_with_lease: false,
        push_follow_tags: false,
    }
}

fn submodule_action_request(repo: &TempDir, path: &str) -> SubmoduleActionRequest {
    SubmoduleActionRequest {
        repo_path: repo.path().to_str().unwrap().to_string(),
        path: path.to_string(),
        recursive: false,
    }
}

fn import_patch_request(repo: &TempDir, patch_path: &Path) -> ImportPatchRequest {
    ImportPatchRequest {
        repo_path: repo.path().to_str().unwrap().to_string(),
        patch_path: patch_path.to_str().unwrap().to_string(),
        three_way: false,
    }
}

fn import_patch_request_with_three_way(
    repo: &TempDir,
    patch_path: &Path,
    three_way: bool,
) -> ImportPatchRequest {
    ImportPatchRequest {
        repo_path: repo.path().to_str().unwrap().to_string(),
        patch_path: patch_path.to_str().unwrap().to_string(),
        three_way,
    }
}

fn export_patch_request(
    repo: &TempDir,
    patch_path: &Path,
    scope: ExportPatchScope,
    files: Vec<ExportPatchFileSelection>,
) -> ExportPatchRequest {
    ExportPatchRequest {
        repo_path: repo.path().to_str().unwrap().to_string(),
        patch_path: patch_path.to_str().unwrap().to_string(),
        scope,
        files,
    }
}

fn assert_patch_contains_full_index(output: &str) {
    let index_line = output
        .lines()
        .find(|line| line.starts_with("index "))
        .expect("patch has index line");
    let ids = index_line
        .trim_start_matches("index ")
        .split_whitespace()
        .next()
        .expect("index line has object ids");
    let (old, new) = ids
        .split_once("..")
        .expect("index line separates object ids");
    assert_eq!(old.len(), 40);
    assert_eq!(new.len(), 40);
}

fn export_commit_patch_request(
    repo: &TempDir,
    patch_path: &Path,
    commit_hashes: Vec<String>,
) -> ExportCommitPatchRequest {
    ExportCommitPatchRequest {
        repo_path: repo.path().to_str().unwrap().to_string(),
        patch_path: patch_path.to_str().unwrap().to_string(),
        commit_hashes,
    }
}

#[test]
fn status_clean_repo() {
    let dir = init_repo();
    let status = handler()
        .get_repo_status(&repo_request(&dir))
        .expect("get_repo_status");
    assert!(status.staged_files.is_empty());
    assert!(status.changed_files.is_empty());
    assert!(status.unversioned_files.is_empty());
    assert!(status.submodules.is_empty());
}

#[test]
fn status_detects_untracked_file() {
    let dir = init_repo();
    write_file(dir.path(), "new.txt", "hello");
    let status = handler()
        .get_repo_status(&repo_request(&dir))
        .expect("get_repo_status");
    assert!(status.unversioned_files.iter().any(|f| f == "new.txt"));
}

fn assert_unversioned_item(status: &RepoStatus, path: &str, kind: UnversionedItemKind) {
    assert!(
        status
            .unversioned_items
            .iter()
            .any(|item| item.path == path && item.kind == kind),
        "missing {kind:?} item for {path}: {:?}",
        status.unversioned_items
    );
}

#[test]
fn status_reports_untracked_item_kinds() {
    let dir = init_repo();
    fs::create_dir_all(dir.path().join("tracked")).expect("create tracked directory");
    write_file(dir.path(), "tracked/kept.txt", "kept");
    git(dir.path(), &["add", "tracked/kept.txt"]);
    git(dir.path(), &["commit", "-m", "track directory"]);

    write_file(dir.path(), "new.txt", "hello");
    write_file(dir.path(), "tracked/new.txt", "new");
    fs::create_dir_all(dir.path().join("notes")).expect("create notes directory");
    write_file(dir.path(), "notes/draft.txt", "draft");

    let cli_status = handler()
        .get_repo_status(&repo_request(&dir))
        .expect("cli get_repo_status");
    assert!(cli_status.unversioned_files.iter().any(|path| path == "new.txt"));
    assert!(cli_status
        .unversioned_files
        .iter()
        .any(|path| path == "notes/"));
    assert_unversioned_item(&cli_status, "new.txt", UnversionedItemKind::File);
    assert_unversioned_item(&cli_status, "tracked/new.txt", UnversionedItemKind::File);
    assert_unversioned_item(&cli_status, "notes/", UnversionedItemKind::Directory);

    let gix_status = gix_handler()
        .get_repo_status(&repo_request(&dir))
        .expect("gix get_repo_status");
    assert!(gix_status.unversioned_files.iter().any(|path| path == "new.txt"));
    assert!(gix_status
        .unversioned_files
        .iter()
        .any(|path| path == "notes/"));
    assert_unversioned_item(&gix_status, "new.txt", UnversionedItemKind::File);
    assert_unversioned_item(&gix_status, "tracked/new.txt", UnversionedItemKind::File);
    assert_unversioned_item(&gix_status, "notes/", UnversionedItemKind::Directory);
}

#[test]
fn status_detects_staged_file() {
    let dir = init_repo();
    write_file(dir.path(), "staged.txt", "content");
    git(dir.path(), &["add", "staged.txt"]);
    let status = handler()
        .get_repo_status(&repo_request(&dir))
        .expect("get_repo_status");
    assert!(status.staged_files.iter().any(|f| f.path == "staged.txt"));
    assert!(status.unversioned_files.is_empty());
}

#[test]
fn status_detects_modified_unstaged_file() {
    let dir = init_repo();
    write_file(dir.path(), "file.txt", "v1");
    git(dir.path(), &["add", "file.txt"]);
    git(dir.path(), &["commit", "-m", "add file"]);
    write_file(dir.path(), "file.txt", "v2");
    let status = handler()
        .get_repo_status(&repo_request(&dir))
        .expect("get_repo_status");
    assert!(status.changed_files.iter().any(|f| f.path == "file.txt"));
}

#[test]
fn import_patch_applies_to_working_tree() {
    let dir = init_repo();
    write_file(dir.path(), "calibration-report.txt", "baseline reading\n");
    git(dir.path(), &["add", "calibration-report.txt"]);
    git(dir.path(), &["commit", "-m", "add calibration report"]);

    let patch = dir.path().join("sonar-calibration.patch");
    fs::write(
        &patch,
        "diff --git a/calibration-report.txt b/calibration-report.txt\n\
         index 624785c..172491a 100644\n\
         --- a/calibration-report.txt\n\
         +++ b/calibration-report.txt\n\
         @@ -1 +1 @@\n\
         -baseline reading\n\
         +corrected reading\n",
    )
    .expect("write patch");

    handler()
        .import_patch_file(&import_patch_request(&dir, &patch))
        .expect("import patch");

    assert_eq!(
        read_file(dir.path(), "calibration-report.txt"),
        "corrected reading\n"
    );
    assert_eq!(
        git_stdout(dir.path(), &["diff", "--cached", "--name-only"]),
        ""
    );
}

#[test]
fn import_patch_rejects_non_applicable_patch_without_modifying_files() {
    let dir = init_repo();
    write_file(dir.path(), "calibration-report.txt", "manual reading\n");
    git(dir.path(), &["add", "calibration-report.txt"]);
    git(dir.path(), &["commit", "-m", "add calibration report"]);

    let patch = dir.path().join("sonar-calibration.patch");
    fs::write(
        &patch,
        "diff --git a/calibration-report.txt b/calibration-report.txt\n\
         index 624785c..172491a 100644\n\
         --- a/calibration-report.txt\n\
         +++ b/calibration-report.txt\n\
         @@ -1 +1 @@\n\
         -baseline reading\n\
         +corrected reading\n",
    )
    .expect("write patch");

    let result = handler().import_patch_file(&import_patch_request(&dir, &patch));

    assert!(result.is_err());
    assert_eq!(
        read_file(dir.path(), "calibration-report.txt"),
        "manual reading\n"
    );
}

#[test]
fn import_patch_three_way_returns_conflict_result_for_drifted_full_index_patch() {
    let dir = init_repo();
    write_file(dir.path(), "calibration-report.txt", "baseline reading\n");
    git(dir.path(), &["add", "calibration-report.txt"]);
    git(dir.path(), &["commit", "-m", "add calibration baseline"]);
    let base_hash = head_hash(dir.path());

    write_file(dir.path(), "calibration-report.txt", "incoming calibration\n");
    git(dir.path(), &["add", "calibration-report.txt"]);
    git(dir.path(), &["commit", "-m", "record incoming calibration"]);
    let patch = dir.path().join("sonar-calibration.patch");
    let patch_content = git_stdout(
        dir.path(),
        &["diff", "--full-index", "--binary", &base_hash, "HEAD", "--"],
    );
    fs::write(&patch, format!("{patch_content}\n")).expect("write patch");

    git(dir.path(), &["reset", "--hard", &base_hash]);
    write_file(dir.path(), "calibration-report.txt", "operator correction\n");
    git(dir.path(), &["add", "calibration-report.txt"]);
    git(dir.path(), &["commit", "-m", "record operator correction"]);

    let result = handler()
        .import_patch_file(&import_patch_request_with_three_way(&dir, &patch, true))
        .expect("three-way import result");

    assert_eq!(result.message, "GITMUN_PATCH_IMPORT_CONFLICTS");
    assert!(
        git_stdout(dir.path(), &["status", "--porcelain"])
            .lines()
            .any(|line| line.starts_with("UU calibration-report.txt"))
    );
    assert!(read_file(dir.path(), "calibration-report.txt").contains("<<<<<<<"));
}

#[test]
fn import_patch_three_way_failure_without_blob_data_leaves_files_unchanged() {
    let dir = init_repo();
    write_file(dir.path(), "calibration-report.txt", "manual reading\n");
    git(dir.path(), &["add", "calibration-report.txt"]);
    git(dir.path(), &["commit", "-m", "add calibration report"]);

    let patch = dir.path().join("sonar-calibration.patch");
    fs::write(
        &patch,
        "diff --git a/calibration-report.txt b/calibration-report.txt\n\
         index 624785c..172491a 100644\n\
         --- a/calibration-report.txt\n\
         +++ b/calibration-report.txt\n\
         @@ -1 +1 @@\n\
         -baseline reading\n\
         +corrected reading\n",
    )
    .expect("write patch");

    let result =
        handler().import_patch_file(&import_patch_request_with_three_way(&dir, &patch, true));

    assert!(result.is_err());
    assert_eq!(
        read_file(dir.path(), "calibration-report.txt"),
        "manual reading\n"
    );
    assert!(
        git_stdout(dir.path(), &["status", "--porcelain"])
            .lines()
            .all(|line| !line.starts_with("UU "))
    );
}

#[test]
fn import_patch_three_way_blocks_dirty_tracked_files() {
    let dir = init_repo();
    write_file(dir.path(), "calibration-report.txt", "baseline reading\n");
    git(dir.path(), &["add", "calibration-report.txt"]);
    git(dir.path(), &["commit", "-m", "add calibration baseline"]);
    let base_hash = head_hash(dir.path());

    write_file(dir.path(), "calibration-report.txt", "incoming calibration\n");
    git(dir.path(), &["add", "calibration-report.txt"]);
    git(dir.path(), &["commit", "-m", "record incoming calibration"]);
    let patch = dir.path().join("sonar-calibration.patch");
    let patch_content = git_stdout(
        dir.path(),
        &["diff", "--full-index", "--binary", &base_hash, "HEAD", "--"],
    );
    fs::write(&patch, format!("{patch_content}\n")).expect("write patch");

    git(dir.path(), &["reset", "--hard", &base_hash]);
    write_file(dir.path(), "calibration-report.txt", "local reading\n");

    let error = handler()
        .import_patch_file(&import_patch_request_with_three_way(&dir, &patch, true))
        .expect_err("dirty files block three-way apply")
        .to_string();

    assert!(error.contains("GITMUN_ERROR_PATCH_IMPORT_THREE_WAY_BLOCKED"));
    assert_eq!(
        read_file(dir.path(), "calibration-report.txt"),
        "local reading\n"
    );
}

#[test]
fn export_staged_patch_contains_only_staged_changes() {
    let dir = init_repo();
    write_file(dir.path(), "staged.txt", "old\n");
    write_file(dir.path(), "unstaged.txt", "old\n");
    git(dir.path(), &["add", "staged.txt", "unstaged.txt"]);
    git(dir.path(), &["commit", "-m", "add files"]);
    write_file(dir.path(), "staged.txt", "new\n");
    write_file(dir.path(), "unstaged.txt", "new\n");
    git(dir.path(), &["add", "staged.txt"]);

    let patch = dir.path().join("staged.patch");
    handler()
        .export_patch_file(&export_patch_request(
            &dir,
            &patch,
            ExportPatchScope::Staged,
            vec![],
        ))
        .expect("export staged patch");
    let output = fs::read_to_string(patch).expect("read patch");

    assert!(output.contains("diff --git a/staged.txt b/staged.txt"));
    assert!(!output.contains("unstaged.txt"));
    assert_patch_contains_full_index(&output);
}

#[test]
fn export_unstaged_patch_contains_tracked_unstaged_and_untracked_files() {
    let dir = init_repo();
    write_file(dir.path(), "tracked.txt", "old\n");
    git(dir.path(), &["add", "tracked.txt"]);
    git(dir.path(), &["commit", "-m", "add tracked"]);
    write_file(dir.path(), "tracked.txt", "new\n");
    write_file(dir.path(), "new.txt", "new file\n");

    let patch = dir.path().join("unstaged.patch");
    handler()
        .export_patch_file(&export_patch_request(
            &dir,
            &patch,
            ExportPatchScope::Unstaged,
            vec![],
        ))
        .expect("export unstaged patch");
    let output = fs::read_to_string(patch).expect("read patch");

    assert!(output.contains("diff --git a/tracked.txt b/tracked.txt"));
    assert!(output.contains("diff --git a/new.txt b/new.txt"));
    assert!(output.contains("new file mode"));
    assert_patch_contains_full_index(&output);
}

#[test]
fn export_all_concatenates_staged_unstaged_and_untracked_changes() {
    let dir = init_repo();
    write_file(dir.path(), "staged.txt", "old\n");
    write_file(dir.path(), "unstaged.txt", "old\n");
    git(dir.path(), &["add", "staged.txt", "unstaged.txt"]);
    git(dir.path(), &["commit", "-m", "add files"]);
    write_file(dir.path(), "staged.txt", "new\n");
    write_file(dir.path(), "unstaged.txt", "new\n");
    write_file(dir.path(), "new.txt", "new file\n");
    git(dir.path(), &["add", "staged.txt"]);

    let patch = dir.path().join("all.patch");
    handler()
        .export_patch_file(&export_patch_request(
            &dir,
            &patch,
            ExportPatchScope::All,
            vec![],
        ))
        .expect("export all patch");
    let output = fs::read_to_string(patch).expect("read patch");

    assert!(output.contains("diff --git a/staged.txt b/staged.txt"));
    assert!(output.contains("diff --git a/unstaged.txt b/unstaged.txt"));
    assert!(output.contains("diff --git a/new.txt b/new.txt"));
    assert_patch_contains_full_index(&output);
}

#[test]
fn export_selected_honours_staged_and_unstaged_file_selections() {
    let dir = init_repo();
    for name in ["staged.txt", "unstaged.txt", "ignored.txt"] {
        write_file(dir.path(), name, "old\n");
    }
    git(
        dir.path(),
        &["add", "staged.txt", "unstaged.txt", "ignored.txt"],
    );
    git(dir.path(), &["commit", "-m", "add files"]);
    for name in ["staged.txt", "unstaged.txt", "ignored.txt"] {
        write_file(dir.path(), name, "new\n");
    }
    write_file(dir.path(), "new.txt", "new file\n");
    git(dir.path(), &["add", "staged.txt"]);

    let patch = dir.path().join("selected.patch");
    handler()
        .export_patch_file(&export_patch_request(
            &dir,
            &patch,
            ExportPatchScope::Selected,
            vec![
                ExportPatchFileSelection {
                    path: "staged.txt".to_string(),
                    staged: true,
                },
                ExportPatchFileSelection {
                    path: "unstaged.txt".to_string(),
                    staged: false,
                },
                ExportPatchFileSelection {
                    path: "new.txt".to_string(),
                    staged: false,
                },
            ],
        ))
        .expect("export selected patch");
    let output = fs::read_to_string(patch).expect("read patch");

    assert!(output.contains("diff --git a/staged.txt b/staged.txt"));
    assert!(output.contains("diff --git a/unstaged.txt b/unstaged.txt"));
    assert!(output.contains("diff --git a/new.txt b/new.txt"));
    assert!(!output.contains("ignored.txt"));
    assert_patch_contains_full_index(&output);
}

#[test]
fn export_commit_patch_contains_selected_commit_changes() {
    let dir = init_repo();
    write_file(dir.path(), "analysis-notes.txt", "sonar baseline\n");
    git(dir.path(), &["add", "analysis-notes.txt"]);
    git(dir.path(), &["commit", "-m", "add sonar analysis notes"]);
    let hash = head_hash(dir.path());

    let patch = dir.path().join("analysis-notes.patch");
    handler()
        .export_commit_patch_file(&export_commit_patch_request(&dir, &patch, vec![hash]))
        .expect("export commit patch");
    let output = fs::read_to_string(patch).expect("read patch");

    assert!(output.contains("diff --git a/analysis-notes.txt b/analysis-notes.txt"));
    assert!(output.contains("+sonar baseline"));
    assert_patch_contains_full_index(&output);
}

#[test]
fn export_commit_patch_orders_multiple_commits_oldest_first() {
    let dir = init_repo();
    write_file(dir.path(), "survey-intake.txt", "morning survey\n");
    git(dir.path(), &["add", "survey-intake.txt"]);
    git(dir.path(), &["commit", "-m", "add morning survey"]);
    let first_hash = head_hash(dir.path());
    write_file(dir.path(), "survey-review.txt", "evening review\n");
    git(dir.path(), &["add", "survey-review.txt"]);
    git(dir.path(), &["commit", "-m", "add evening survey review"]);
    let second_hash = head_hash(dir.path());

    let patch = dir.path().join("survey-commits.patch");
    handler()
        .export_commit_patch_file(&export_commit_patch_request(
            &dir,
            &patch,
            vec![second_hash, first_hash],
        ))
        .expect("export commit patch");
    let output = fs::read_to_string(patch).expect("read patch");

    let first_index = output
        .find("diff --git a/survey-intake.txt b/survey-intake.txt")
        .unwrap();
    let second_index = output
        .find("diff --git a/survey-review.txt b/survey-review.txt")
        .unwrap();
    assert!(first_index < second_index);
}

#[test]
fn export_commit_patch_supports_root_commit() {
    let dir = init_unborn_repo();
    write_file(dir.path(), "baseline-report.txt", "initial survey\n");
    git(dir.path(), &["add", "baseline-report.txt"]);
    git(dir.path(), &["commit", "-m", "add baseline report"]);
    let hash = head_hash(dir.path());

    let patch = dir.path().join("baseline-root.patch");
    handler()
        .export_commit_patch_file(&export_commit_patch_request(&dir, &patch, vec![hash]))
        .expect("export root commit patch");
    let output = fs::read_to_string(patch).expect("read patch");

    assert!(output.contains("diff --git a/baseline-report.txt b/baseline-report.txt"));
    assert!(output.contains("new file mode"));
    assert!(output.contains("+initial survey"));
}

#[test]
fn export_commit_patch_rejects_empty_selection() {
    let dir = init_repo();
    let patch = dir.path().join("empty-selection.patch");
    let result =
        handler().export_commit_patch_file(&export_commit_patch_request(&dir, &patch, vec![]));

    assert!(result.is_err());
    assert!(!patch.exists());
}

#[test]
fn export_commit_patch_rejects_invalid_commit_hash() {
    let dir = init_repo();
    let patch = dir.path().join("invalid-selection.patch");
    let result = handler().export_commit_patch_file(&export_commit_patch_request(
        &dir,
        &patch,
        vec!["not-a-commit".to_string()],
    ));

    assert!(result.is_err());
    assert!(!patch.exists());
}

#[test]
fn discard_file_removes_untracked_directory() {
    let dir = init_repo();
    fs::create_dir_all(dir.path().join("new-dir")).expect("create directory");
    write_file(dir.path(), "new-dir/file.txt", "new");

    handler()
        .discard_file(&file_request(&dir, "new-dir"))
        .expect("discard_file");

    assert!(!dir.path().join("new-dir").exists());
}

#[test]
fn discard_file_removes_untracked_ignored_directory() {
    let dir = init_repo();
    write_file(dir.path(), ".gitignore", "packaging/flatpak/repo/\n");
    git(dir.path(), &["add", ".gitignore"]);
    git(dir.path(), &["commit", "-m", "ignore generated repo"]);
    fs::create_dir_all(dir.path().join("packaging/flatpak/repo")).expect("create directory");
    write_file(
        dir.path(),
        "packaging/flatpak/repo/generated.txt",
        "generated",
    );

    handler()
        .discard_file(&file_request(&dir, "packaging/flatpak/repo"))
        .expect("discard_file");

    assert!(!dir.path().join("packaging/flatpak/repo").exists());
}

#[test]
fn discard_file_does_not_remove_clean_tracked_directory() {
    let dir = init_repo();
    fs::create_dir_all(dir.path().join("tracked")).expect("create directory");
    write_file(dir.path(), "tracked/file.txt", "tracked");
    git(dir.path(), &["add", "tracked/file.txt"]);
    git(dir.path(), &["commit", "-m", "add tracked directory"]);

    handler()
        .discard_file(&file_request(&dir, "tracked"))
        .expect("discard_file");

    assert!(dir.path().join("tracked/file.txt").exists());
}

#[test]
fn stage_files_moves_file_to_staged() {
    let dir = init_repo();
    write_file(dir.path(), "a.txt", "hello");
    handler()
        .stage_files(&StageFilesRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            files: vec!["a.txt".to_string()],
        })
        .expect("stage_files");
    let status = handler()
        .get_repo_status(&repo_request(&dir))
        .expect("get_repo_status");
    assert!(status.staged_files.iter().any(|f| f.path == "a.txt"));
    assert!(status.unversioned_files.is_empty());
}

#[test]
fn stage_files_handles_large_selection_with_spaces() {
    let dir = init_repo();
    fs::create_dir_all(dir.path().join("bulk files")).expect("create bulk directory");

    let mut files = vec!["bulk files/root note.txt".to_string()];
    write_file(dir.path(), &files[0], "root");
    for index in 0..200 {
        let path = format!("bulk files/file {index}.txt");
        write_file(dir.path(), &path, "content");
        files.push(path);
    }

    handler()
        .stage_files(&StageFilesRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            files: files.clone(),
        })
        .expect("stage_files");

    let staged = git_stdout(dir.path(), &["diff", "--cached", "--name-only"]);
    for path in files {
        assert!(staged.lines().any(|line| line == path), "missing {path}");
    }
}

#[test]
fn unstage_file_in_initial_commit_keeps_worktree_file() {
    let dir = init_unborn_repo();
    write_file(dir.path(), "PLAN.md", "draft v1");
    git(dir.path(), &["add", "PLAN.md"]);
    write_file(dir.path(), "PLAN.md", "draft v2");

    handler()
        .unstage_file(&file_request(&dir, "PLAN.md"))
        .expect("unstage_file");

    assert_eq!(
        fs::read_to_string(dir.path().join("PLAN.md")).expect("read PLAN.md"),
        "draft v2"
    );
    assert_eq!(
        git_stdout(dir.path(), &["diff", "--cached", "--name-only"]),
        ""
    );
    assert_eq!(
        git_stdout(dir.path(), &["status", "--porcelain"]),
        "?? PLAN.md"
    );
}

#[test]
fn unstage_all_in_initial_commit_keeps_worktree_files() {
    let dir = init_unborn_repo();
    fs::create_dir_all(dir.path().join("notes")).expect("create notes dir");
    write_file(dir.path(), "PLAN.md", "plan");
    write_file(dir.path(), "notes/todo.txt", "todo v1");
    git(dir.path(), &["add", "."]);
    write_file(dir.path(), "notes/todo.txt", "todo v2");

    handler()
        .unstage_all(&repo_request(&dir))
        .expect("unstage_all");

    assert!(dir.path().join("PLAN.md").exists());
    assert_eq!(
        fs::read_to_string(dir.path().join("notes/todo.txt")).expect("read todo"),
        "todo v2"
    );
    assert_eq!(
        git_stdout(dir.path(), &["diff", "--cached", "--name-only"]),
        ""
    );
    assert_eq!(
        git_stdout(dir.path(), &["status", "--porcelain"]),
        "?? PLAN.md\n?? notes/"
    );
}

#[test]
fn unstage_file_in_repo_with_head_keeps_change_unstaged() {
    let dir = init_repo();
    write_file(dir.path(), "tracked.txt", "v1");
    git(dir.path(), &["add", "tracked.txt"]);
    git(dir.path(), &["commit", "-m", "add tracked file"]);
    write_file(dir.path(), "tracked.txt", "v2");
    git(dir.path(), &["add", "tracked.txt"]);

    handler()
        .unstage_file(&file_request(&dir, "tracked.txt"))
        .expect("unstage_file");

    assert_eq!(
        git_stdout(dir.path(), &["diff", "--cached", "--name-only"]),
        ""
    );
    assert_eq!(
        git_stdout(dir.path(), &["diff", "--name-only"]),
        "tracked.txt"
    );
}

#[test]
fn hard_reset_to_head_discards_tracked_changes_and_keeps_untracked_files() {
    let dir = init_repo();
    write_file(dir.path(), "tracked.txt", "v1");
    git(dir.path(), &["add", "tracked.txt"]);
    git(dir.path(), &["commit", "-m", "add tracked file"]);
    write_file(dir.path(), "tracked.txt", "v2");
    git(dir.path(), &["add", "tracked.txt"]);
    write_file(dir.path(), "untracked.txt", "new");

    let result = handler()
        .reset(&ResetRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            target: "HEAD".to_string(),
            mode: ResetMode::Hard,
        })
        .expect("hard reset");

    assert_eq!(result.message, "Reset (hard) to HEAD");
    assert_eq!(read_file(dir.path(), "tracked.txt"), "v1");
    assert_eq!(read_file(dir.path(), "untracked.txt"), "new");
    assert_eq!(
        git_stdout(dir.path(), &["status", "--porcelain"]),
        "?? untracked.txt"
    );
}

#[test]
fn status_detects_clean_submodule() {
    let (parent, _submodule) = repo_with_submodule();
    let status = handler()
        .get_repo_status(&repo_request(&parent))
        .expect("get_repo_status");

    assert_eq!(status.submodules.len(), 1);
    let submodule = &status.submodules[0];
    assert_eq!(submodule.path, "deps/lib");
    assert_eq!(submodule.state, SubmoduleState::Clean);
    assert!(submodule.initialised);
    assert!(!submodule.dirty);
    assert!(!submodule.out_of_sync);
    assert!(submodule.expected_commit.is_some());
    assert_eq!(submodule.expected_commit, submodule.checked_out_commit);
}

#[test]
fn status_detects_uninitialised_submodule() {
    let (parent, _submodule) = repo_with_submodule();
    git(
        parent.path(),
        &["submodule", "deinit", "-f", "--", "deps/lib"],
    );

    let status = handler()
        .get_repo_status(&repo_request(&parent))
        .expect("get_repo_status");

    let submodule = &status.submodules[0];
    assert_eq!(submodule.state, SubmoduleState::Uninitialised);
    assert!(!submodule.initialised);
    assert!(submodule.checked_out_commit.is_none());
}

#[test]
fn status_detects_dirty_submodule_without_normal_file_entry() {
    let (parent, _submodule) = repo_with_submodule();
    write_file(&parent.path().join("deps/lib"), "lib.txt", "dirty");

    let status = handler()
        .get_repo_status(&repo_request(&parent))
        .expect("get_repo_status");

    let submodule = &status.submodules[0];
    assert_eq!(submodule.state, SubmoduleState::Dirty);
    assert!(submodule.dirty);
    assert!(
        status
            .changed_files
            .iter()
            .all(|file| file.path != "deps/lib")
    );
    assert!(
        status
            .staged_files
            .iter()
            .all(|file| file.path != "deps/lib")
    );
    assert!(
        status
            .unversioned_files
            .iter()
            .all(|path| path != "deps/lib")
    );
}

#[test]
fn status_detects_out_of_sync_submodule() {
    let (parent, _submodule) = repo_with_submodule();
    let submodule_path = parent.path().join("deps/lib");
    git(
        &submodule_path,
        &["config", "user.email", "test@gitmun.test"],
    );
    git(&submodule_path, &["config", "user.name", "Gitmun Test"]);
    git(&submodule_path, &["config", "commit.gpgsign", "false"]);
    write_file(&submodule_path, "lib.txt", "v2");
    git(&submodule_path, &["add", "lib.txt"]);
    git(&submodule_path, &["commit", "-m", "advance submodule"]);

    let status = handler()
        .get_repo_status(&repo_request(&parent))
        .expect("get_repo_status");

    let submodule = &status.submodules[0];
    assert_eq!(submodule.state, SubmoduleState::OutOfSync);
    assert!(submodule.out_of_sync);
    assert_ne!(submodule.expected_commit, submodule.checked_out_commit);
    assert!(
        status
            .changed_files
            .iter()
            .all(|file| file.path != "deps/lib")
    );
}

#[test]
fn status_detects_sync_required_submodule() {
    let (parent, _submodule) = repo_with_submodule();
    git(
        parent.path(),
        &[
            "config",
            "--file",
            ".gitmodules",
            "submodule.deps/lib.url",
            "https://example.invalid/changed.git",
        ],
    );

    let status = handler()
        .get_repo_status(&repo_request(&parent))
        .expect("get_repo_status");

    let submodule = &status.submodules[0];
    assert_eq!(submodule.state, SubmoduleState::SyncRequired);
    assert!(submodule.sync_required);
    assert_ne!(submodule.configured_url, submodule.local_url);
}

#[test]
fn submodule_init_initialises_deinitialised_submodule() {
    let (parent, _submodule) = repo_with_submodule();
    git(
        parent.path(),
        &["submodule", "deinit", "-f", "--", "deps/lib"],
    );
    git(parent.path(), &["config", "protocol.file.allow", "always"]);

    handler()
        .submodule_init(&submodule_action_request(&parent, "deps/lib"))
        .expect("submodule_init");

    let status = handler()
        .get_repo_status(&repo_request(&parent))
        .expect("get_repo_status");
    assert_eq!(status.submodules[0].state, SubmoduleState::Clean);
    assert!(status.submodules[0].initialised);
}

#[test]
fn submodule_sync_clears_url_mismatch() {
    let (parent, _submodule) = repo_with_submodule();
    git(
        parent.path(),
        &[
            "config",
            "--file",
            ".gitmodules",
            "submodule.deps/lib.url",
            "https://example.invalid/changed.git",
        ],
    );

    handler()
        .submodule_sync(&submodule_action_request(&parent, "deps/lib"))
        .expect("submodule_sync");

    let status = handler()
        .get_repo_status(&repo_request(&parent))
        .expect("get_repo_status");
    assert!(!status.submodules[0].sync_required);
    assert_eq!(
        status.submodules[0].configured_url,
        status.submodules[0].local_url
    );
}

#[test]
fn submodule_action_rejects_unknown_path() {
    let (parent, _submodule) = repo_with_submodule();
    let error = handler()
        .submodule_update(&submodule_action_request(&parent, "../outside"))
        .expect_err("unknown submodule path should fail");

    assert!(error.to_string().contains("Invalid submodule path"));
}

#[test]
fn submodule_pull_rejects_dirty_submodule() {
    let (parent, _submodule) = repo_with_submodule();
    write_file(&parent.path().join("deps/lib"), "lib.txt", "dirty");

    let error = handler()
        .submodule_pull(&submodule_action_request(&parent, "deps/lib"))
        .expect_err("dirty submodule pull should fail");

    assert!(error.to_string().contains("local changes"));
}

#[test]
fn commit_creates_entry_in_log() {
    let dir = init_repo();
    write_file(dir.path(), "b.txt", "data");
    git(dir.path(), &["add", "b.txt"]);
    handler()
        .commit_changes(&CommitRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            message: "add b.txt".to_string(),
            amend: None,
        })
        .expect("commit_changes");
    let commits = handler()
        .get_commit_history(&CommitHistoryRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            limit: Some(10),
            after_hash: None,
            offset: None,
            commit_date_mode: Default::default(),
            scope: Default::default(),
        })
        .expect("get_commit_history");
    assert!(commits.iter().any(|c| c.message == "add b.txt"));
}

#[test]
fn commit_preserves_description_and_trailer_like_lines() {
    let dir = init_repo();
    write_file(dir.path(), "body.txt", "data");
    git(dir.path(), &["add", "body.txt"]);
    let message = "add body\n\nExplain the change\n\nCo-authored-by: Name <name@example.com>";

    handler()
        .commit_changes(&CommitRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            message: message.to_string(),
            amend: None,
        })
        .expect("commit_changes");

    let committed_message = git_stdout(dir.path(), &["log", "-1", "--format=%B"]);
    assert_eq!(committed_message, message);
}

#[test]
fn commit_message_recovery_reads_commit_editmsg() {
    let dir = init_repo();
    let commit_editmsg = git_stdout(dir.path(), &["rev-parse", "--git-path", "COMMIT_EDITMSG"]);
    fs::write(
        dir.path().join(commit_editmsg),
        "Restore buoy calibration\n\nRecovered after the interrupted commit.\n# ignored comment\n",
    )
    .expect("write COMMIT_EDITMSG");

    let recovery = handler()
        .get_commit_message_recovery(&repo_request(&dir))
        .expect("get_commit_message_recovery")
        .expect("recovery message");

    assert_eq!(
        recovery.message,
        "Restore buoy calibration\n\nRecovered after the interrupted commit."
    );
    assert!(recovery.updated_at > 0);
}

#[test]
fn commit_message_recovery_ignores_missing_or_comment_only_file() {
    let dir = init_repo();
    let commit_editmsg = git_stdout(dir.path(), &["rev-parse", "--git-path", "COMMIT_EDITMSG"]);
    let commit_editmsg_path = dir.path().join(commit_editmsg);
    fs::remove_file(&commit_editmsg_path).expect("remove COMMIT_EDITMSG");

    assert!(
        handler()
            .get_commit_message_recovery(&repo_request(&dir))
            .expect("missing COMMIT_EDITMSG")
            .is_none()
    );

    fs::write(commit_editmsg_path, "# comment only\n\n# still comment\n").expect("write COMMIT_EDITMSG");

    assert!(
        handler()
            .get_commit_message_recovery(&repo_request(&dir))
            .expect("comment-only COMMIT_EDITMSG")
            .is_none()
    );
}

#[test]
fn ssh_allowed_signer_status_ignores_non_ssh_signing() {
    let dir = init_repo();
    set_local_identity(&dir, Some("test@gitmun.test"), Some("ABC123"), "openpgp");

    let status = handler()
        .get_ssh_allowed_signer_status(&identity_request(&dir))
        .expect("status");

    assert!(!status.setup_needed);
    assert_eq!(status.blocking_reason, None);
    assert_eq!(status.reason, Some(SshAllowedSignerReason::NotSsh));
}

#[test]
fn ssh_allowed_signer_status_requires_signing_key() {
    let dir = init_repo();
    set_local_identity(&dir, Some("test@gitmun.test"), None, "ssh");

    let status = handler()
        .get_ssh_allowed_signer_status(&identity_request(&dir))
        .expect("status");

    assert!(!status.setup_needed);
    assert_eq!(status.blocking_reason, None);
    assert_eq!(
        status.reason,
        Some(SshAllowedSignerReason::MissingSigningKey)
    );
    assert!(!status.signing_key_present);
}

#[test]
fn ssh_allowed_signer_adds_inline_key_to_local_default_file() {
    let dir = init_repo();
    let key = "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test@gitmun.test";
    set_local_identity(&dir, Some("test@gitmun.test"), Some(key), "ssh");

    let status = handler()
        .get_ssh_allowed_signer_status(&identity_request(&dir))
        .expect("status");
    assert!(status.setup_needed);
    assert!(!status.allowed_signers_configured);
    assert!(!status.allowed_signers_exists);
    assert_eq!(
        status.reason,
        Some(SshAllowedSignerReason::UntrustedSigningKey)
    );
    assert!(status.signing_key_present);
    assert!(!status.signing_key_trusted);

    handler()
        .add_ssh_signing_key_to_allowed_signers(&identity_request(&dir))
        .expect("add allowed signer");

    let configured = git_stdout(
        dir.path(),
        &["config", "--local", "--get", "gpg.ssh.allowedSignersFile"],
    );
    let content = fs::read_to_string(&configured).expect("read allowed signers");
    assert_eq!(
        content,
        "test@gitmun.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test@gitmun.test\n"
    );
    assert!(!git_stdout(dir.path(), &["status", "--porcelain"]).contains("gitmun_allowed_signers"));
}

#[test]
fn ssh_allowed_signer_accepts_raw_public_key() {
    let dir = init_repo();
    let allowed = dir.path().join("allowed_signers");
    git(
        dir.path(),
        &[
            "config",
            "--local",
            "gpg.ssh.allowedSignersFile",
            allowed.to_str().unwrap(),
        ],
    );
    set_local_identity(
        &dir,
        Some("test@gitmun.test"),
        Some("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRawKey"),
        "ssh",
    );

    handler()
        .add_ssh_signing_key_to_allowed_signers(&identity_request(&dir))
        .expect("add allowed signer");

    assert_eq!(
        fs::read_to_string(allowed).expect("read allowed signers"),
        "test@gitmun.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRawKey\n"
    );
}

#[test]
fn ssh_allowed_signer_reports_configured_missing_file() {
    let dir = init_repo();
    let allowed = dir.path().join("missing_allowed_signers");
    git(
        dir.path(),
        &[
            "config",
            "--local",
            "gpg.ssh.allowedSignersFile",
            allowed.to_str().unwrap(),
        ],
    );
    set_local_identity(
        &dir,
        Some("test@gitmun.test"),
        Some("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMissingFile"),
        "ssh",
    );

    let status = handler()
        .get_ssh_allowed_signer_status(&identity_request(&dir))
        .expect("status");

    assert!(status.setup_needed);
    assert!(status.allowed_signers_configured);
    assert!(!status.allowed_signers_exists);
    assert_eq!(
        status.reason,
        Some(SshAllowedSignerReason::MissingAllowedSignersFile)
    );
}

#[test]
fn ssh_allowed_signer_accepts_public_key_file() {
    let dir = init_repo();
    let public_key = dir.path().join("id_ed25519.pub");
    fs::write(
        &public_key,
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFileKey test@gitmun.test\n",
    )
    .expect("write public key");
    set_local_identity(
        &dir,
        Some("test@gitmun.test"),
        Some(public_key.to_str().unwrap()),
        "ssh",
    );

    handler()
        .add_ssh_signing_key_to_allowed_signers(&identity_request(&dir))
        .expect("add allowed signer");

    let configured = git_stdout(
        dir.path(),
        &["config", "--local", "--get", "gpg.ssh.allowedSignersFile"],
    );
    assert!(
        fs::read_to_string(configured)
            .expect("read allowed signers")
            .contains("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFileKey")
    );
}

#[test]
fn ssh_allowed_signer_accepts_private_key_path_with_public_pair() {
    let dir = init_repo();
    let private_key = dir.path().join("id_ed25519");
    fs::write(&private_key, "marine lab private key fixture\n").expect("write private key");
    fs::write(
        dir.path().join("id_ed25519.pub"),
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPairedKey test@gitmun.test\n",
    )
    .expect("write public key");
    set_local_identity(
        &dir,
        Some("test@gitmun.test"),
        Some(private_key.to_str().unwrap()),
        "ssh",
    );

    handler()
        .add_ssh_signing_key_to_allowed_signers(&identity_request(&dir))
        .expect("add allowed signer");

    let configured = git_stdout(
        dir.path(),
        &["config", "--local", "--get", "gpg.ssh.allowedSignersFile"],
    );
    assert!(
        fs::read_to_string(configured)
            .expect("read allowed signers")
            .contains("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPairedKey")
    );
}

#[test]
fn ssh_allowed_signer_does_not_duplicate_existing_key() {
    let dir = init_repo();
    let allowed = dir.path().join("allowed_signers");
    fs::write(
        &allowed,
        "other@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDupeKey other\n",
    )
    .expect("write allowed signers");
    git(
        dir.path(),
        &[
            "config",
            "--local",
            "gpg.ssh.allowedSignersFile",
            allowed.to_str().unwrap(),
        ],
    );
    set_local_identity(
        &dir,
        Some("test@gitmun.test"),
        Some("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDupeKey test"),
        "ssh",
    );

    let status = handler()
        .get_ssh_allowed_signer_status(&identity_request(&dir))
        .expect("status");
    assert!(!status.setup_needed);
    assert_eq!(status.reason, Some(SshAllowedSignerReason::Trusted));
    assert!(status.signing_key_trusted);

    handler()
        .add_ssh_signing_key_to_allowed_signers(&identity_request(&dir))
        .expect("add allowed signer");
    let content = fs::read_to_string(allowed).expect("read allowed signers");
    assert_eq!(content.lines().count(), 1);
}

#[test]
fn ssh_allowed_signer_requires_email() {
    let dir = init_repo();
    git(dir.path(), &["config", "--local", "--unset", "user.email"]);
    set_local_identity(
        &dir,
        None,
        Some("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINoEmail"),
        "ssh",
    );

    let status = handler()
        .get_ssh_allowed_signer_status(&identity_request(&dir))
        .expect("status");

    assert!(!status.setup_needed);
    assert_eq!(
        status.blocking_reason.as_deref(),
        Some("GITMUN_ERROR_SSH_ALLOWED_SIGNERS_MISSING_EMAIL")
    );
    assert_eq!(status.reason, Some(SshAllowedSignerReason::MissingEmail));
}

#[test]
fn ssh_allowed_signer_reports_unresolved_signing_key() {
    let dir = init_repo();
    set_local_identity(
        &dir,
        Some("test@gitmun.test"),
        Some("missing_id_ed25519"),
        "ssh",
    );

    let status = handler()
        .get_ssh_allowed_signer_status(&identity_request(&dir))
        .expect("status");

    assert!(!status.setup_needed);
    assert_eq!(
        status.reason,
        Some(SshAllowedSignerReason::UnresolvedSigningKey)
    );
    assert!(
        status
            .blocking_reason
            .as_deref()
            .unwrap_or_default()
            .contains("GITMUN_ERROR_SSH_ALLOWED_SIGNERS_SIGNING_KEY_UNRESOLVED")
    );
}

#[test]
fn commit_history_all_refs_includes_branch_outside_detached_head() {
    let dir = init_repo();
    let init_hash = git_stdout(dir.path(), &["rev-parse", "HEAD"]);
    git(dir.path(), &["checkout", "-b", "side"]);
    write_file(dir.path(), "side.txt", "side");
    git(dir.path(), &["add", "side.txt"]);
    git(dir.path(), &["commit", "-m", "side branch commit"]);
    git(dir.path(), &["checkout", "main"]);
    write_file(dir.path(), "scratch.txt", "stash me");
    git(dir.path(), &["stash", "push", "-u", "-m", "hidden stash"]);
    git(dir.path(), &["checkout", "--detach"]);

    let current_commits = handler()
        .get_commit_history(&CommitHistoryRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            limit: Some(10),
            after_hash: None,
            offset: None,
            commit_date_mode: Default::default(),
            scope: CommitLogScope::CurrentCheckout,
        })
        .expect("get current checkout history");

    let all_ref_commits = handler()
        .get_commit_history(&CommitHistoryRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            limit: Some(10),
            after_hash: None,
            offset: None,
            commit_date_mode: Default::default(),
            scope: CommitLogScope::AllRefs,
        })
        .expect("get all refs history");

    assert!(
        !current_commits
            .iter()
            .any(|c| c.message == "side branch commit")
    );
    assert!(
        all_ref_commits
            .iter()
            .any(|c| c.message == "side branch commit")
    );
    assert!(
        !all_ref_commits
            .iter()
            .any(|c| c.message.contains("hidden stash")),
        "All refs history should not include refs/stash"
    );

    let side_commit = all_ref_commits
        .iter()
        .find(|c| c.message == "side branch commit")
        .expect("side branch commit in all refs");
    assert_eq!(side_commit.parent_hashes, vec![init_hash]);
}

fn assert_commit_history_includes_merge_parents(handler: impl GitOperationHandler) {
    let dir = init_repo();
    git(dir.path(), &["checkout", "-b", "side"]);
    write_file(dir.path(), "side.txt", "side");
    git(dir.path(), &["add", "side.txt"]);
    git(dir.path(), &["commit", "-m", "side commit"]);
    let side_hash = git_stdout(dir.path(), &["rev-parse", "HEAD"]);

    git(dir.path(), &["checkout", "main"]);
    write_file(dir.path(), "main.txt", "main");
    git(dir.path(), &["add", "main.txt"]);
    git(dir.path(), &["commit", "-m", "main commit"]);
    let main_hash = git_stdout(dir.path(), &["rev-parse", "HEAD"]);

    git(
        dir.path(),
        &["merge", "--no-ff", "side", "-m", "merge side"],
    );
    let merge_hash = git_stdout(dir.path(), &["rev-parse", "HEAD"]);

    let commits = handler
        .get_commit_history(&CommitHistoryRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            limit: Some(10),
            after_hash: None,
            offset: None,
            commit_date_mode: Default::default(),
            scope: CommitLogScope::CurrentCheckout,
        })
        .expect("get commit history");

    let merge_commit = commits
        .iter()
        .find(|commit| commit.hash == merge_hash)
        .expect("merge commit in history");
    assert_eq!(merge_commit.parent_hashes, vec![main_hash, side_hash]);
}

#[test]
fn cli_commit_history_includes_merge_parents() {
    assert_commit_history_includes_merge_parents(handler());
}

#[test]
fn gix_commit_history_includes_merge_parents() {
    assert_commit_history_includes_merge_parents(gix_handler());
}

fn assert_commit_history_includes_ref_decorations(handler: impl GitOperationHandler) {
    let dir = init_repo();
    let head_hash = git_stdout(dir.path(), &["rev-parse", "HEAD"]);
    git(dir.path(), &["branch", "topic"]);
    git(dir.path(), &["tag", "v-test"]);
    git(
        dir.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    git(
        dir.path(),
        &["update-ref", "refs/remotes/origin/HEAD", "HEAD"],
    );

    let commits = handler
        .get_commit_history(&CommitHistoryRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            limit: Some(10),
            after_hash: None,
            offset: None,
            commit_date_mode: Default::default(),
            scope: CommitLogScope::CurrentCheckout,
        })
        .expect("get commit history");

    let head_commit = commits
        .iter()
        .find(|commit| commit.hash == head_hash)
        .expect("head commit in history");
    assert!(
        head_commit
            .ref_decorations
            .iter()
            .any(|decoration| decoration.kind == CommitRefKind::LocalBranch
                && decoration.name == "main")
    );
    assert!(
        head_commit
            .ref_decorations
            .iter()
            .any(|decoration| decoration.kind == CommitRefKind::LocalBranch
                && decoration.name == "topic")
    );
    assert!(
        head_commit
            .ref_decorations
            .iter()
            .any(|decoration| decoration.kind == CommitRefKind::RemoteBranch
                && decoration.name == "origin/main")
    );
    assert!(
        head_commit
            .ref_decorations
            .iter()
            .any(|decoration| decoration.kind == CommitRefKind::Tag && decoration.name == "v-test")
    );
    assert!(
        !head_commit
            .ref_decorations
            .iter()
            .any(|decoration| decoration.name == "origin/HEAD")
    );
}

#[test]
fn cli_commit_history_includes_ref_decorations() {
    assert_commit_history_includes_ref_decorations(handler());
}

#[test]
fn gix_commit_history_includes_ref_decorations() {
    assert_commit_history_includes_ref_decorations(gix_handler());
}

#[test]
fn branches_includes_default_branch() {
    let dir = init_repo();
    let branches = handler()
        .get_branches(&repo_request(&dir))
        .expect("get_branches");
    let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
    assert!(names.contains(&"main"), "expected main, got {:?}", names);
}

#[test]
fn create_branch_appears_in_branch_list() {
    let dir = init_repo();
    handler()
        .create_branch(&CreateBranchRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            branch_name: "feature/test".to_string(),
            base_ref: None,
            checkout_after_creation: None,
            track_remote: None,
            match_tracking_branch: None,
        })
        .expect("create_branch");
    let branches = handler()
        .get_branches(&repo_request(&dir))
        .expect("get_branches");
    assert!(branches.iter().any(|b| b.name == "feature/test"));
}

#[test]
fn delete_unmerged_branch_suggests_force_delete() {
    let dir = init_repo();
    git(dir.path(), &["switch", "-c", "feature/unmerged"]);
    write_file(dir.path(), "feature.txt", "feature");
    git(dir.path(), &["add", "feature.txt"]);
    git(dir.path(), &["commit", "-m", "feature commit"]);
    git(dir.path(), &["switch", "main"]);

    let error = handler()
        .delete_branch(&DeleteBranchRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            branch_name: "feature/unmerged".to_string(),
            force: None,
        })
        .expect_err("delete unmerged branch");
    let message = error.to_string();

    assert!(message.contains("GITMUN_ERROR_UNMERGED_BRANCH_DELETE"));
    assert!(message.contains("feature/unmerged"));
}

#[test]
fn commit_history_respects_limit() {
    let dir = init_repo();
    for i in 0..5 {
        write_file(dir.path(), &format!("f{i}.txt"), "x");
        git(dir.path(), &["add", &format!("f{i}.txt")]);
        git(dir.path(), &["commit", "-m", &format!("commit {i}")]);
    }
    let commits = handler()
        .get_commit_history(&CommitHistoryRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            limit: Some(3),
            after_hash: None,
            offset: None,
            commit_date_mode: Default::default(),
            scope: Default::default(),
        })
        .expect("get_commit_history");
    assert_eq!(commits.len(), 3);
}

#[test]
fn commit_history_returns_commits_newest_first() {
    let dir = init_repo();
    for msg in ["first", "second", "third"] {
        write_file(dir.path(), &format!("{msg}.txt"), msg);
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", msg]);
    }
    let commits = handler()
        .get_commit_history(&CommitHistoryRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            limit: Some(10),
            after_hash: None,
            offset: None,
            commit_date_mode: Default::default(),
            scope: Default::default(),
        })
        .expect("get_commit_history");
    assert_eq!(commits[0].message, "third");
}

fn assert_commit_history_honours_mailmap<H: GitOperationHandler>(handler: H) {
    let dir = init_repo();
    commit_with_identities(
        dir.path(),
        "mailmap-history.txt",
        "mailmap history",
        ("Old Name", "old@example.test"),
        ("Old Name", "old@example.test"),
    );
    write_file(
        dir.path(),
        ".mailmap",
        "Canonical Name <canonical@example.test> Old Name <old@example.test>\n",
    );

    let commits = handler
        .get_commit_history(&history_request(&dir))
        .expect("get_commit_history");
    let commit = commits
        .iter()
        .find(|commit| commit.message == "mailmap history")
        .expect("mailmap history commit");

    assert_eq!(commit.author, "Canonical Name");
    assert_eq!(commit.author_email, "canonical@example.test");
}

#[test]
fn cli_commit_history_honours_mailmap() {
    assert_commit_history_honours_mailmap(handler());
}

#[test]
fn gix_commit_history_honours_mailmap() {
    assert_commit_history_honours_mailmap(gix_handler());
}

fn assert_commit_history_without_mailmap_keeps_raw_identity<H: GitOperationHandler>(handler: H) {
    let dir = init_repo();
    commit_with_identities(
        dir.path(),
        "raw-history.txt",
        "raw history",
        ("Old Name", "old@example.test"),
        ("Old Name", "old@example.test"),
    );

    let commits = handler
        .get_commit_history(&history_request(&dir))
        .expect("get_commit_history");
    let commit = commits
        .iter()
        .find(|commit| commit.message == "raw history")
        .expect("raw history commit");

    assert_eq!(commit.author, "Old Name");
    assert_eq!(commit.author_email, "old@example.test");
}

#[test]
fn cli_commit_history_without_mailmap_keeps_raw_identity() {
    assert_commit_history_without_mailmap_keeps_raw_identity(handler());
}

#[test]
fn gix_commit_history_without_mailmap_keeps_raw_identity() {
    assert_commit_history_without_mailmap_keeps_raw_identity(gix_handler());
}

#[test]
fn gix_commit_history_matches_git_log_order_for_merge_commits() {
    let dir = init_repo();
    let initial_date = [
        ("GIT_AUTHOR_DATE", "2026-04-01T09:00:00+01:00"),
        ("GIT_COMMITTER_DATE", "2026-04-01T09:00:00+01:00"),
    ];
    git_with_env(
        dir.path(),
        &["commit", "--amend", "--no-edit", "--allow-empty"],
        &initial_date,
    );

    git(dir.path(), &["checkout", "-b", "feature"]);
    write_file(dir.path(), "feature-a.txt", "feature a");
    git(dir.path(), &["add", "feature-a.txt"]);
    let feature_first_date = [
        ("GIT_AUTHOR_DATE", "2026-05-06T16:40:00+01:00"),
        ("GIT_COMMITTER_DATE", "2026-05-06T16:40:00+01:00"),
    ];
    git_with_env(
        dir.path(),
        &["commit", "-m", "feature first"],
        &feature_first_date,
    );

    write_file(dir.path(), "feature-b.txt", "feature b");
    git(dir.path(), &["add", "feature-b.txt"]);
    let feature_second_date = [
        ("GIT_AUTHOR_DATE", "2026-05-06T16:50:00+01:00"),
        ("GIT_COMMITTER_DATE", "2026-05-06T16:50:00+01:00"),
    ];
    git_with_env(
        dir.path(),
        &["commit", "-m", "feature second"],
        &feature_second_date,
    );

    git(dir.path(), &["checkout", "main"]);
    write_file(dir.path(), "main-older.txt", "main older");
    git(dir.path(), &["add", "main-older.txt"]);
    let main_older_date = [
        ("GIT_AUTHOR_DATE", "2026-04-27T14:34:55+01:00"),
        ("GIT_COMMITTER_DATE", "2026-04-27T14:34:55+01:00"),
    ];
    git_with_env(
        dir.path(),
        &["commit", "-m", "main older"],
        &main_older_date,
    );

    let merge_date = [
        ("GIT_AUTHOR_DATE", "2026-05-06T16:51:09+01:00"),
        ("GIT_COMMITTER_DATE", "2026-05-06T16:51:09+01:00"),
    ];
    git_with_env(
        dir.path(),
        &["merge", "--no-ff", "feature", "-m", "merge feature"],
        &merge_date,
    );

    let expected_messages: Vec<String> = git_stdout(dir.path(), &["log", "-5", "--format=%s"])
        .lines()
        .map(ToString::to_string)
        .collect();

    let commits = gix_handler()
        .get_commit_history(&CommitHistoryRequest {
            repo_path: dir.path().to_str().unwrap().to_string(),
            limit: Some(5),
            after_hash: None,
            offset: None,
            commit_date_mode: Default::default(),
            scope: Default::default(),
        })
        .expect("get gix commit history");
    let actual_messages: Vec<String> = commits
        .iter()
        .map(|commit| commit.message.clone())
        .collect();

    assert_eq!(actual_messages, expected_messages);
}

// commit_details: CLI handler

#[test]
fn cli_commit_details_basic_fields() {
    let dir = init_repo();
    let hash = head_hash(dir.path());

    let details = handler()
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert_eq!(details.hash, hash);
    assert_eq!(details.author, "Gitmun Test");
    assert_eq!(details.author_email, "test@gitmun.test");
    assert!(!details.author_date.is_empty());
    assert!(details.body.is_empty());
    assert!(details.trailers.is_empty());
    assert!(details.tags.is_empty());
}

fn assert_commit_details_honours_mailmap<H: GitOperationHandler>(handler: H) {
    let dir = init_repo();
    let hash = commit_with_identities(
        dir.path(),
        "mailmap-details.txt",
        "mailmap details",
        ("Old Author", "old-author@example.test"),
        ("Old Committer", "old-committer@example.test"),
    );
    write_file(
        dir.path(),
        ".mailmap",
        "Canonical Author <canonical-author@example.test> <old-author@example.test>\n\
         Canonical Committer <canonical-committer@example.test> Old Committer <old-committer@example.test>\n",
    );

    let details = handler
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert_eq!(details.author, "Canonical Author");
    assert_eq!(details.author_email, "canonical-author@example.test");
    assert_eq!(details.committer, "Canonical Committer");
    assert_eq!(details.committer_email, "canonical-committer@example.test");
}

#[test]
fn cli_commit_details_honours_mailmap() {
    assert_commit_details_honours_mailmap(handler());
}

#[test]
fn gix_commit_details_honours_mailmap() {
    assert_commit_details_honours_mailmap(gix_handler());
}

fn assert_commit_details_without_mailmap_keeps_raw_identity<H: GitOperationHandler>(handler: H) {
    let dir = init_repo();
    let hash = commit_with_identities(
        dir.path(),
        "raw-details.txt",
        "raw details",
        ("Old Author", "old-author@example.test"),
        ("Old Committer", "old-committer@example.test"),
    );

    let details = handler
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert_eq!(details.author, "Old Author");
    assert_eq!(details.author_email, "old-author@example.test");
    assert_eq!(details.committer, "Old Committer");
    assert_eq!(details.committer_email, "old-committer@example.test");
}

#[test]
fn cli_commit_details_without_mailmap_keeps_raw_identity() {
    assert_commit_details_without_mailmap_keeps_raw_identity(handler());
}

#[test]
fn gix_commit_details_without_mailmap_keeps_raw_identity() {
    assert_commit_details_without_mailmap_keeps_raw_identity(gix_handler());
}

#[test]
fn cli_commit_details_parent_hash() {
    let dir = init_repo();
    let first_hash = head_hash(dir.path());
    write_file(dir.path(), "a.txt", "hi");
    git(dir.path(), &["add", "a.txt"]);
    git(dir.path(), &["commit", "-m", "second"]);
    let second_hash = head_hash(dir.path());

    let details = handler()
        .get_commit_details(&details_request(&dir, &second_hash))
        .expect("get_commit_details");

    assert_eq!(details.parent_hashes.len(), 1);
    assert_eq!(details.parent_hashes[0], first_hash);
}

#[test]
fn analyze_pull_reports_up_to_date() {
    let (_remote, local) = init_remote_with_clone();
    let analysis = handler()
        .analyze_pull(&repo_request(&local))
        .expect("analyze_pull");

    assert_eq!(analysis.current_branch.as_deref(), Some("main"));
    assert_eq!(analysis.upstream_branch.as_deref(), Some("origin/main"));
    assert_eq!(analysis.ahead, 0);
    assert_eq!(analysis.behind, 0);
    assert!(matches!(
        analysis.state,
        gitmun_lib::git::types::PullState::UpToDate
    ));
}

#[test]
fn analyze_pull_reports_behind_only() {
    let (remote, local) = init_remote_with_clone();
    let peer = TempDir::new().expect("create peer dir");
    git(
        Path::new("."),
        &[
            "clone",
            remote.path().to_str().unwrap(),
            peer.path().to_str().unwrap(),
        ],
    );
    git(peer.path(), &["config", "user.email", "peer@gitmun.test"]);
    git(peer.path(), &["config", "user.name", "Peer"]);
    git(peer.path(), &["config", "commit.gpgsign", "false"]);
    write_file(peer.path(), "peer.txt", "remote");
    git(peer.path(), &["add", "peer.txt"]);
    git(peer.path(), &["commit", "-m", "remote commit"]);
    git(peer.path(), &["push", "origin", "main"]);
    git(local.path(), &["fetch", "origin"]);

    let analysis = handler()
        .analyze_pull(&repo_request(&local))
        .expect("analyze_pull");

    assert_eq!(analysis.ahead, 0);
    assert_eq!(analysis.behind, 1);
    assert!(matches!(
        analysis.state,
        gitmun_lib::git::types::PullState::BehindOnly
    ));
}

#[test]
fn analyze_pull_reports_divergent() {
    let (remote, local) = init_remote_with_clone();
    let peer = TempDir::new().expect("create peer dir");
    git(
        Path::new("."),
        &[
            "clone",
            remote.path().to_str().unwrap(),
            peer.path().to_str().unwrap(),
        ],
    );
    git(peer.path(), &["config", "user.email", "peer@gitmun.test"]);
    git(peer.path(), &["config", "user.name", "Peer"]);
    git(peer.path(), &["config", "commit.gpgsign", "false"]);
    write_file(peer.path(), "peer.txt", "remote");
    git(peer.path(), &["add", "peer.txt"]);
    git(peer.path(), &["commit", "-m", "remote commit"]);
    git(peer.path(), &["push", "origin", "main"]);

    write_file(local.path(), "local.txt", "local");
    git(local.path(), &["add", "local.txt"]);
    git(local.path(), &["commit", "-m", "local commit"]);
    git(local.path(), &["fetch", "origin"]);

    let analysis = handler()
        .analyze_pull(&repo_request(&local))
        .expect("analyze_pull");

    assert_eq!(analysis.ahead, 1);
    assert_eq!(analysis.behind, 1);
    assert!(matches!(
        analysis.state,
        gitmun_lib::git::types::PullState::Divergent
    ));
}

#[test]
fn analyze_pull_blocks_dirty_worktree() {
    let (_remote, local) = init_remote_with_clone();
    write_file(local.path(), "seed.txt", "changed");

    let analysis = handler()
        .analyze_pull(&repo_request(&local))
        .expect("analyze_pull");

    assert!(analysis.has_working_tree_changes);
    assert!(matches!(
        analysis.state,
        gitmun_lib::git::types::PullState::BlockedDirtyWorktree
    ));
}

#[test]
fn push_changes_classifies_non_fast_forward() {
    let (remote, local) = init_remote_with_clone();
    let peer = TempDir::new().expect("create peer dir");
    git(
        Path::new("."),
        &[
            "clone",
            remote.path().to_str().unwrap(),
            peer.path().to_str().unwrap(),
        ],
    );
    git(peer.path(), &["config", "user.email", "peer@gitmun.test"]);
    git(peer.path(), &["config", "user.name", "Peer"]);
    git(peer.path(), &["config", "commit.gpgsign", "false"]);
    write_file(peer.path(), "peer.txt", "remote");
    git(peer.path(), &["add", "peer.txt"]);
    git(peer.path(), &["commit", "-m", "remote commit"]);
    git(peer.path(), &["push", "origin", "main"]);

    write_file(local.path(), "local.txt", "local");
    git(local.path(), &["add", "local.txt"]);
    git(local.path(), &["commit", "-m", "local commit"]);

    let result = handler()
        .push_changes(&push_request(&local))
        .expect("push_changes");

    assert!(!result.success);
    let interpreted = result.interpreted_error.expect("interpreted error");
    assert_eq!(interpreted.category, GitErrorCategory::NonFastForward);
    assert!(interpreted.confidence >= 0.9);
    assert!(
        result
            .output
            .as_deref()
            .is_some_and(|output| output.contains("[rejected]") || output.contains("fetch first")),
        "raw Git output is preserved"
    );
    let rejection = result.rejection.expect("push rejection");
    assert!(matches!(rejection.kind, PushFailureKind::NonFastForward));
}

#[test]
fn publish_branch_sets_upstream() {
    let (_remote, local) = init_remote_with_clone();
    git(local.path(), &["switch", "-c", "feature/publish"]);
    write_file(local.path(), "publish.txt", "publish");
    git(local.path(), &["add", "publish.txt"]);
    git(local.path(), &["commit", "-m", "publish branch"]);

    let mut request = push_request(&local);
    request.remote = Some("origin".to_string());
    request.remote_branch = Some("feature/publish".to_string());
    request.set_upstream = true;

    let result = handler().push_changes(&request).expect("publish branch");

    assert!(result.success);
    assert_eq!(result.message, "Published branch to origin/feature/publish");
    assert_eq!(
        git_stdout(
            local.path(),
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}"
            ],
        ),
        "origin/feature/publish"
    );
}

#[test]
fn publish_branch_can_target_non_origin_remote() {
    let (_remote, local) = init_remote_with_clone();
    let backup = TempDir::new().expect("create backup remote");
    git(backup.path(), &["init", "--bare", "-b", "main"]);
    git(
        local.path(),
        &["remote", "add", "backup", backup.path().to_str().unwrap()],
    );
    git(local.path(), &["switch", "-c", "feature/backup"]);
    write_file(local.path(), "backup.txt", "backup");
    git(local.path(), &["add", "backup.txt"]);
    git(local.path(), &["commit", "-m", "backup branch"]);

    let mut request = push_request(&local);
    request.remote = Some("backup".to_string());
    request.remote_branch = Some("feature/backup".to_string());
    request.set_upstream = true;

    let result = handler().push_changes(&request).expect("publish branch");

    assert!(result.success);
    assert_eq!(
        git_stdout(
            local.path(),
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}"
            ],
        ),
        "backup/feature/backup"
    );
}

#[test]
fn set_branch_upstream_changes_tracking_without_push() {
    let (_remote, local) = init_remote_with_clone();
    let backup = TempDir::new().expect("create backup remote");
    git(backup.path(), &["init", "--bare", "-b", "main"]);
    git(
        local.path(),
        &["remote", "add", "backup", backup.path().to_str().unwrap()],
    );
    git(local.path(), &["push", "backup", "main"]);

    let result = handler()
        .set_branch_upstream(&SetBranchUpstreamRequest {
            repo_path: local.path().to_str().unwrap().to_string(),
            branch_name: "main".to_string(),
            remote: "backup".to_string(),
            remote_branch: "main".to_string(),
        })
        .expect("set_branch_upstream");

    assert_eq!(result.message, "Set upstream for 'main' to 'backup/main'");
    assert_eq!(
        git_stdout(
            local.path(),
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}"
            ],
        ),
        "backup/main"
    );
}

#[test]
fn get_branches_marks_missing_upstream() {
    let (_remote, local) = init_remote_with_clone();
    git(
        local.path(),
        &["update-ref", "-d", "refs/remotes/origin/main"],
    );

    let branches = handler()
        .get_branches(&repo_request(&local))
        .expect("get_branches");
    let main = branches
        .into_iter()
        .find(|branch| branch.name == "main")
        .expect("main branch");

    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert!(matches!(
        main.upstream_status,
        gitmun_lib::git::types::UpstreamStatus::Missing
    ));
}

#[test]
fn push_without_upstream_returns_publish_guidance() {
    let (_remote, local) = init_remote_with_clone();
    git(local.path(), &["switch", "-c", "feature/no-upstream"]);
    write_file(local.path(), "no-upstream.txt", "publish me");
    git(local.path(), &["add", "no-upstream.txt"]);
    git(local.path(), &["commit", "-m", "no upstream"]);

    let result = handler()
        .push_changes(&push_request(&local))
        .expect("push_changes");

    assert!(!result.success);
    let interpreted = result.interpreted_error.expect("interpreted error");
    assert_eq!(interpreted.category, GitErrorCategory::NoUpstream);
    assert_eq!(interpreted.suggested_actions, vec!["set-upstream"]);
    assert!(
        result
            .output
            .as_deref()
            .is_some_and(|output| output.contains("no upstream branch")),
        "raw Git output is preserved"
    );
    let rejection = result.rejection.expect("push rejection");
    assert!(matches!(rejection.kind, PushFailureKind::NoUpstream));
}

#[test]
fn push_with_mismatched_upstream_returns_repair_guidance() {
    let (_remote, local) = init_remote_with_clone();
    git(
        local.path(),
        &["config", "branch.main.merge", "refs/heads/missing"],
    );

    let result = handler()
        .push_changes(&push_request(&local))
        .expect("push_changes");

    assert!(!result.success);
    let interpreted = result.interpreted_error.expect("interpreted error");
    assert_eq!(interpreted.category, GitErrorCategory::UpstreamMissing);
    assert!(
        interpreted
            .suggested_actions
            .contains(&"repair-upstream".to_string())
    );
    let rejection = result.rejection.expect("push rejection");
    assert!(matches!(rejection.kind, PushFailureKind::UpstreamMissing));
    assert!(
        result
            .output
            .as_deref()
            .is_some_and(|output| output.contains("upstream branch")),
        "raw Git output is preserved"
    );
}

#[test]
fn push_to_unresolvable_remote_returns_network_guidance() {
    let (_remote, local) = init_remote_with_clone();
    write_file(local.path(), "network.txt", "network");
    git(local.path(), &["add", "network.txt"]);
    git(local.path(), &["commit", "-m", "network"]);
    git(
        local.path(),
        &[
            "config",
            "core.sshCommand",
            "sh -c 'echo \"ssh: Could not resolve hostname example.invalid: Name or service not known\" >&2; exit 255'",
        ],
    );
    git(
        local.path(),
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://git@example.invalid/repo.git",
        ],
    );

    let result = handler()
        .push_changes(&push_request(&local))
        .expect("push_changes");

    assert!(!result.success);
    let interpreted = result.interpreted_error.expect("interpreted error");
    assert_eq!(interpreted.category, GitErrorCategory::Network);
    assert!(
        result
            .output
            .as_deref()
            .is_some_and(|output| output.contains("Could not resolve hostname")),
        "raw Git output is preserved"
    );
}

#[test]
fn force_with_lease_push_succeeds_when_plain_push_would_reject() {
    let (_remote, local) = init_remote_with_clone();
    write_file(local.path(), "seed.txt", "updated");
    git(local.path(), &["add", "seed.txt"]);
    git(local.path(), &["commit", "--amend", "-m", "seed updated"]);

    let rejected = handler()
        .push_changes(&push_request(&local))
        .expect("plain push");
    assert!(!rejected.success);

    let mut request = push_request(&local);
    request.force_with_lease = true;

    let forced = handler()
        .push_changes(&request)
        .expect("force-with-lease push");

    assert!(forced.success);
}

#[test]
fn status_detects_remote_tracking_merge_branch_from_merge_msg() {
    let dir = init_repo();
    let git_dir = dir.path().join(".git");
    fs::write(
        git_dir.join("MERGE_HEAD"),
        format!("{}\n", head_hash(dir.path())),
    )
    .expect("write MERGE_HEAD");
    fs::write(
        git_dir.join("MERGE_MSG"),
        "Merge remote-tracking branch 'origin/main' into main\n",
    )
    .expect("write MERGE_MSG");

    let cli_status = handler()
        .get_repo_status(&repo_request(&dir))
        .expect("cli get_repo_status");
    assert!(cli_status.merge_in_progress);
    assert_eq!(cli_status.merge_head_branch.as_deref(), Some("origin/main"));

    let gix_status = gix_handler()
        .get_repo_status(&repo_request(&dir))
        .expect("gix get_repo_status");
    assert!(gix_status.merge_in_progress);
    assert_eq!(gix_status.merge_head_branch.as_deref(), Some("origin/main"));
}

#[test]
fn cli_commit_details_trailers_parsed() {
    let dir = init_repo();
    git(
        dir.path(),
        &[
            "commit",
            "--allow-empty",
            "-m",
            "subject",
            "-m",
            "Reviewed-by: Alice <a@b.com>",
        ],
    );
    let hash = head_hash(dir.path());

    let details = handler()
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert!(details.body.is_empty());
    assert_eq!(details.trailers.len(), 1);
    assert_eq!(details.trailers[0].key, "Reviewed-by");
    assert_eq!(details.trailers[0].value, "Alice <a@b.com>");
}

#[test]
fn cli_commit_details_no_trailers() {
    let dir = init_repo();
    git(
        dir.path(),
        &["commit", "--allow-empty", "-m", "plain message"],
    );
    let hash = head_hash(dir.path());

    let details = handler()
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert!(details.body.is_empty());
    assert!(details.trailers.is_empty());
}

#[test]
fn commit_details_backends_return_identical_body_and_trailers() {
    let dir = init_repo();
    git(
        dir.path(),
        &[
            "commit",
            "--allow-empty",
            "-m",
            "subject",
            "-m",
            "First paragraph.\n\nSecond paragraph.\n\nReviewed-by: Alice <a@b.com>\nSigned-off-by: Bob <b@example.com>",
        ],
    );
    let hash = head_hash(dir.path());
    let request = details_request(&dir, &hash);

    let cli_details = handler()
        .get_commit_details(&request)
        .expect("get CLI commit details");
    let gix_details = gix_handler()
        .get_commit_details(&request)
        .expect("get gix commit details");

    assert_eq!(cli_details.body, "First paragraph.\n\nSecond paragraph.");
    assert_eq!(gix_details.body, cli_details.body);
    assert_eq!(cli_details.trailers.len(), 2);
    assert_eq!(gix_details.trailers.len(), cli_details.trailers.len());
    for (cli_trailer, gix_trailer) in cli_details.trailers.iter().zip(gix_details.trailers.iter()) {
        assert_eq!(gix_trailer.key, cli_trailer.key);
        assert_eq!(gix_trailer.value, cli_trailer.value);
    }
}

#[test]
fn cli_commit_details_tagged_commit() {
    let dir = init_repo();
    let hash = head_hash(dir.path());
    git(dir.path(), &["tag", "v1.0", &hash]);

    let details = handler()
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert!(details.tags.contains(&"v1.0".to_string()));
}

#[test]
fn cli_commit_details_merge_has_two_parents() {
    let dir = init_repo();
    git(dir.path(), &["checkout", "-b", "feature"]);
    write_file(dir.path(), "feature.txt", "x");
    git(dir.path(), &["add", "feature.txt"]);
    git(dir.path(), &["commit", "-m", "feature commit"]);
    git(dir.path(), &["checkout", "-"]);
    git(
        dir.path(),
        &["merge", "--no-ff", "feature", "-m", "merge feature"],
    );
    let merge_hash = head_hash(dir.path());

    let details = handler()
        .get_commit_details(&details_request(&dir, &merge_hash))
        .expect("get_commit_details");

    assert_eq!(details.parent_hashes.len(), 2);
}

#[test]
fn cli_commit_details_empty_hash_returns_error() {
    let dir = init_repo();
    let result = handler().get_commit_details(&CommitDetailsRequest {
        repo_path: dir.path().to_str().unwrap().to_string(),
        commit_hash: "".to_string(),
    });
    assert!(result.is_err());
}

// commit_details: gix handler

#[test]
fn gix_commit_details_basic_fields() {
    let dir = init_repo();
    let hash = head_hash(dir.path());

    let details = gix_handler()
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert_eq!(details.hash, hash);
    assert_eq!(details.author, "Gitmun Test");
    assert_eq!(details.author_email, "test@gitmun.test");
    assert!(!details.author_date.is_empty());
    assert!(details.body.is_empty());
    assert!(details.trailers.is_empty());
    assert!(details.tags.is_empty());
}

#[test]
fn gix_commit_details_parent_hash() {
    let dir = init_repo();
    let first_hash = head_hash(dir.path());
    write_file(dir.path(), "a.txt", "hi");
    git(dir.path(), &["add", "a.txt"]);
    git(dir.path(), &["commit", "-m", "second"]);
    let second_hash = head_hash(dir.path());

    let details = gix_handler()
        .get_commit_details(&details_request(&dir, &second_hash))
        .expect("get_commit_details");

    assert_eq!(details.parent_hashes.len(), 1);
    assert_eq!(details.parent_hashes[0], first_hash);
}

#[test]
fn gix_commit_details_trailers_parsed() {
    let dir = init_repo();
    git(
        dir.path(),
        &[
            "commit",
            "--allow-empty",
            "-m",
            "subject",
            "-m",
            "Reviewed-by: Alice <a@b.com>",
        ],
    );
    let hash = head_hash(dir.path());

    let details = gix_handler()
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert!(details.body.is_empty());
    assert_eq!(details.trailers.len(), 1);
    assert_eq!(details.trailers[0].key, "Reviewed-by");
    assert_eq!(details.trailers[0].value, "Alice <a@b.com>");
}

#[test]
fn gix_commit_details_no_trailers() {
    let dir = init_repo();
    git(
        dir.path(),
        &["commit", "--allow-empty", "-m", "plain message"],
    );
    let hash = head_hash(dir.path());

    let details = gix_handler()
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert!(details.body.is_empty());
    assert!(details.trailers.is_empty());
}

#[test]
fn gix_commit_details_tagged_commit() {
    let dir = init_repo();
    let hash = head_hash(dir.path());
    git(dir.path(), &["tag", "v1.0", &hash]);

    let details = gix_handler()
        .get_commit_details(&details_request(&dir, &hash))
        .expect("get_commit_details");

    assert!(details.tags.contains(&"v1.0".to_string()));
}

#[test]
fn gix_commit_details_merge_has_two_parents() {
    let dir = init_repo();
    git(dir.path(), &["checkout", "-b", "feature"]);
    write_file(dir.path(), "feature.txt", "x");
    git(dir.path(), &["add", "feature.txt"]);
    git(dir.path(), &["commit", "-m", "feature commit"]);
    git(dir.path(), &["checkout", "-"]);
    git(
        dir.path(),
        &["merge", "--no-ff", "feature", "-m", "merge feature"],
    );
    let merge_hash = head_hash(dir.path());

    let details = gix_handler()
        .get_commit_details(&details_request(&dir, &merge_hash))
        .expect("get_commit_details");

    assert_eq!(details.parent_hashes.len(), 2);
}

#[test]
fn gix_commit_details_invalid_hash_returns_error() {
    let dir = init_repo();
    let result = gix_handler().get_commit_details(&CommitDetailsRequest {
        repo_path: dir.path().to_str().unwrap().to_string(),
        commit_hash: "notahash".to_string(),
    });
    assert!(result.is_err());
}
