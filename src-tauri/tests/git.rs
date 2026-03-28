use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

use gitmun_lib::git::cli::CliGitHandler;
use gitmun_lib::git::handler::GitOperationHandler;
use gitmun_lib::git::types::{
    CommitHistoryRequest, CommitRequest, CreateBranchRequest, RepoRequest, StageFilesRequest,
};

fn init_repo() -> TempDir {
    let dir = TempDir::new().expect("create temp dir");
    let path = dir.path();
    git(path, &["init"]);
    git(path, &["config", "user.email", "test@gitmun.test"]);
    git(path, &["config", "user.name", "Gitmun Test"]);
    git(path, &["config", "commit.gpgsign", "false"]);
    // Initial empty commit so HEAD exists
    git(path, &["commit", "--allow-empty", "-m", "init"]);
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

fn write_file(repo: &Path, name: &str, content: &str) {
    fs::write(repo.join(name), content).expect("write file");
}

fn repo_request(dir: &TempDir) -> RepoRequest {
    RepoRequest {
        repo_path: dir.path().to_str().unwrap().to_string(),
    }
}

fn handler() -> CliGitHandler {
    CliGitHandler
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
        })
        .expect("get_commit_history");
    assert!(commits.iter().any(|c| c.message == "add b.txt"));
}

#[test]
fn branches_includes_default_branch() {
    let dir = init_repo();
    let branches = handler()
        .get_branches(&repo_request(&dir))
        .expect("get_branches");
    // git init uses "master" or "main" depending on config; accept either
    let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
    assert!(
        names.contains(&"main") || names.contains(&"master"),
        "expected main or master, got {:?}",
        names
    );
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
        })
        .expect("get_commit_history");
    assert_eq!(commits[0].message, "third");
}
