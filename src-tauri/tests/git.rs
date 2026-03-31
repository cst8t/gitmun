use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

use gitmun_lib::git::cli::CliGitHandler;
use gitmun_lib::git::gix_handler::GixGitHandler;
use gitmun_lib::git::handler::GitOperationHandler;
use gitmun_lib::git::types::{
    CommitDetailsRequest, CommitHistoryRequest, CommitRequest, CreateBranchRequest, PushRequest,
    RepoRequest, StageFilesRequest,
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

fn gix_handler() -> GixGitHandler {
    GixGitHandler::new()
}

fn init_remote_with_clone() -> (TempDir, TempDir) {
    let remote = TempDir::new().expect("create remote dir");
    git(remote.path(), &["init", "--bare"]);

    let local = TempDir::new().expect("create local dir");
    git(local.path(), &["init"]);
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
    git(local.path(), &["branch", "-M", "main"]);
    git(local.path(), &["push", "-u", "origin", "main"]);
    (remote, local)
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
    assert!(details.trailers.is_empty());
    assert!(details.tags.is_empty());
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
        .push_changes(&PushRequest {
            repo_path: local.path().to_str().unwrap().to_string(),
            force: false,
            push_follow_tags: false,
        })
        .expect("push_changes");

    assert!(!result.success);
    let rejection = result.rejection.expect("push rejection");
    assert!(matches!(
        rejection.kind,
        gitmun_lib::git::types::PushFailureKind::NonFastForward
    ));
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

    assert!(details.trailers.is_empty());
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
