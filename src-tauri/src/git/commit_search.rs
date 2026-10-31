use super::cli::CliGitHandler;
use super::types::{
    CommitDateMode, CommitHistoryItem, CommitLogScope, CommitSearchEvent, CommitSearchFailure,
    CommitSearchRequest, CommitSearchStatus, SignatureStatus,
};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

const PAGE_SIZE: usize = 100;
const EVENT_BATCH_SIZE: usize = 25;

#[derive(Default)]
pub struct CommitSearchManager {
    sessions: Mutex<HashMap<String, Arc<SearchSession>>>,
}

struct SearchSession {
    id: String,
    resume: mpsc::Sender<SearchControl>,
    cancelled: AtomicBool,
    paused: AtomicBool,
    child: Mutex<Option<Child>>,
}

enum SearchControl {
    Resume,
}

impl SearchSession {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        drop(self.resume.send(SearchControl::Resume));
        if let Some(child) = self.child.lock().expect("search child lock").as_mut() {
            drop(child.kill());
        }
    }
}

impl CommitSearchManager {
    pub fn start(
        self: &Arc<Self>,
        window_label: String,
        request: CommitSearchRequest,
        commit_date_mode: CommitDateMode,
        send: impl Fn(CommitSearchEvent) -> bool + Send + 'static,
    ) -> Result<(), CommitSearchFailure> {
        if request.session_id.is_empty() || request.query.trim().is_empty() {
            return Err(failure("COMMIT_SEARCH_INVALID_REQUEST", ""));
        }
        let (resume, receiver) = mpsc::channel();
        let session = Arc::new(SearchSession {
            id: request.session_id.clone(),
            resume,
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            child: Mutex::new(None),
        });
        let previous = self
            .sessions
            .lock()
            .expect("search sessions lock")
            .insert(window_label.clone(), session.clone());
        if let Some(previous) = previous {
            previous.cancel();
        }
        let manager = self.clone();
        thread::spawn(move || {
            let mut scanned = 0;
            let result = stream_search(
                &request,
                commit_date_mode,
                &session,
                &receiver,
                &send,
                &mut scanned,
            );
            if let Err(error) = result
                && !session.cancelled.load(Ordering::Acquire)
            {
                send(CommitSearchEvent {
                    session_id: session.id.clone(),
                    commits: Vec::new(),
                    scanned_count: scanned,
                    status: CommitSearchStatus::Error,
                    error: Some(error),
                });
            }
            let mut sessions = manager.sessions.lock().expect("search sessions lock");
            if sessions
                .get(&window_label)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                sessions.remove(&window_label);
            }
        });
        Ok(())
    }

    pub fn continue_search(
        &self,
        window_label: &str,
        session_id: &str,
    ) -> Result<(), CommitSearchFailure> {
        let sessions = self.sessions.lock().expect("search sessions lock");
        let session = sessions
            .get(window_label)
            .filter(|session| session.id == session_id)
            .ok_or_else(|| failure("COMMIT_SEARCH_SESSION_MISSING", ""))?;
        if session.paused.swap(false, Ordering::AcqRel) {
            session
                .resume
                .send(SearchControl::Resume)
                .map_err(|error| failure("COMMIT_SEARCH_SESSION_MISSING", error.to_string()))?;
        }
        Ok(())
    }

    pub fn cancel(&self, window_label: &str, session_id: &str) {
        let mut sessions = self.sessions.lock().expect("search sessions lock");
        if sessions
            .get(window_label)
            .is_some_and(|session| session.id == session_id)
            && let Some(session) = sessions.remove(window_label)
        {
            session.cancel();
        }
    }

    pub fn cancel_window(&self, window_label: &str) {
        if let Some(session) = self
            .sessions
            .lock()
            .expect("search sessions lock")
            .remove(window_label)
        {
            session.cancel();
        }
    }
}

struct SearchProcess<'a> {
    session: &'a SearchSession,
    stderr: Option<thread::JoinHandle<String>>,
}

impl<'a> SearchProcess<'a> {
    fn spawn(
        mut command: Command,
        session: &'a SearchSession,
    ) -> Result<(Self, BufReader<ChildStdout>), CommitSearchFailure> {
        let mut slot = session.child.lock().expect("search child lock");
        if session.cancelled.load(Ordering::Acquire) {
            return Err(failure("COMMIT_SEARCH_CANCELLED", ""));
        }
        let mut child = command
            .spawn()
            .map_err(|error| failure("COMMIT_SEARCH_START_FAILED", error.to_string()))?;
        let stdout = child.stdout.take().expect("piped search stdout");
        let stderr = child.stderr.take().expect("piped search stderr");
        *slot = Some(child);
        let stderr = thread::spawn(move || {
            // Drain the pipe even after the diagnostic buffer is full.
            let mut reader = BufReader::new(stderr);
            let mut diagnostic = Vec::new();
            let mut buffer = [0; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                let retained = count.min(65536usize.saturating_sub(diagnostic.len()));
                diagnostic.extend_from_slice(&buffer[..retained]);
            }
            String::from_utf8_lossy(&diagnostic).trim().to_string()
        });
        Ok((
            Self {
                session,
                stderr: Some(stderr),
            },
            BufReader::new(stdout),
        ))
    }

    fn finish(&mut self) -> Result<(ExitStatus, String), CommitSearchFailure> {
        let status = loop {
            let mut slot = self.session.child.lock().expect("search child lock");
            let child = slot.as_mut().expect("running search child");
            if let Some(status) = child
                .try_wait()
                .map_err(|error| failure("COMMIT_SEARCH_GIT_FAILED", error.to_string()))?
            {
                slot.take();
                break status;
            }
            drop(slot);
            thread::sleep(Duration::from_millis(10));
        };
        let diagnostic = self
            .stderr
            .take()
            .expect("search stderr reader")
            .join()
            .unwrap_or_default();
        Ok((status, diagnostic))
    }
}

impl Drop for SearchProcess<'_> {
    fn drop(&mut self) {
        if let Some(mut child) = self.session.child.lock().expect("search child lock").take() {
            drop(child.kill());
            drop(child.wait());
        }
        if let Some(stderr) = self.stderr.take() {
            drop(stderr.join());
        }
    }
}

fn stream_search(
    request: &CommitSearchRequest,
    date_mode: CommitDateMode,
    session: &SearchSession,
    resume: &mpsc::Receiver<SearchControl>,
    send: &impl Fn(CommitSearchEvent) -> bool,
    scanned: &mut usize,
) -> Result<(), CommitSearchFailure> {
    let emit = |commits, status| -> bool {
        send(CommitSearchEvent {
            session_id: session.id.clone(),
            commits,
            scanned_count: 0,
            status,
            error: None,
        })
    };
    if !emit(Vec::new(), CommitSearchStatus::Scanning) {
        return Ok(());
    }
    let repo = gix::discover(&request.repo_path).ok();
    if request.scope == CommitLogScope::CurrentCheckout
        && repo
            .as_ref()
            .and_then(|repo| repo.head().ok())
            .is_some_and(|head| head.is_unborn())
    {
        emit(Vec::new(), CommitSearchStatus::Complete);
        return Ok(());
    }
    let (mut process, mut reader) =
        SearchProcess::spawn(search_command(request, date_mode), session)?;
    let query = request.query.trim().to_lowercase();
    let mut page_matches = 0;
    let mut batch = Vec::with_capacity(EVENT_BATCH_SIZE);
    let mut decorations = None;
    let mut last_progress = Instant::now();
    loop {
        if session.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        let Some(record) = read_record(&mut reader)? else {
            break;
        };
        *scanned += 1;
        if record.matches(&query) {
            let commit = record.into_history_item();
            batch.push(commit);
            page_matches += 1;
        }
        let page_full = page_matches == PAGE_SIZE;
        if batch.len() == EVENT_BATCH_SIZE
            || page_full
            || last_progress.elapsed() >= Duration::from_millis(100)
        {
            if !batch.is_empty() {
                let decorations = decorations.get_or_insert_with(|| {
                    CliGitHandler::collect_commit_ref_decorations(std::path::Path::new(
                        &request.repo_path,
                    ))
                    .unwrap_or_default()
                });
                enrich_matches(repo.as_ref(), decorations, &mut batch);
            }
            if page_full {
                session.paused.store(true, Ordering::Release);
            }
            if session.cancelled.load(Ordering::Acquire)
                || !send(CommitSearchEvent {
                    session_id: session.id.clone(),
                    commits: std::mem::take(&mut batch),
                    scanned_count: *scanned,
                    status: if page_full {
                        CommitSearchStatus::Paused
                    } else {
                        CommitSearchStatus::Scanning
                    },
                    error: None,
                })
            {
                return Ok(());
            }
            last_progress = Instant::now();
        }
        if page_full {
            if resume.recv().is_err() || session.cancelled.load(Ordering::Acquire) {
                return Ok(());
            }
            page_matches = 0;
        }
    }
    let (status, diagnostic) = process.finish()?;
    if session.cancelled.load(Ordering::Acquire) {
        return Ok(());
    }
    if !batch.is_empty() {
        let decorations = decorations.get_or_insert_with(|| {
            CliGitHandler::collect_commit_ref_decorations(std::path::Path::new(&request.repo_path))
                .unwrap_or_default()
        });
        enrich_matches(repo.as_ref(), decorations, &mut batch);
    }
    // Deliver matches before reporting a traversal error so partial results remain reviewable.
    if !status.success() {
        if !batch.is_empty() {
            send(CommitSearchEvent {
                session_id: session.id.clone(),
                commits: batch,
                scanned_count: *scanned,
                status: CommitSearchStatus::Scanning,
                error: None,
            });
        }
        return Err(failure("COMMIT_SEARCH_GIT_FAILED", diagnostic));
    }
    send(CommitSearchEvent {
        session_id: session.id.clone(),
        commits: batch,
        scanned_count: *scanned,
        status: CommitSearchStatus::Complete,
        error: None,
    });
    Ok(())
}

fn search_command(request: &CommitSearchRequest, date_mode: CommitDateMode) -> Command {
    let date = match date_mode {
        CommitDateMode::AuthorDate => "%ad",
        CommitDateMode::CommitterDate => "%cd",
    };
    let mut command = crate::configured_git_command();
    command
        .current_dir(&request.repo_path)
        .env("GIT_NO_LAZY_FETCH", "1")
        .args([
            "log",
            "-z",
            "--abbrev=7",
            "--no-show-signature",
            "--no-notes",
            "--no-patch",
            "--no-color",
            "--encoding=UTF-8",
            "--date=iso-strict",
        ])
        .arg(format!(
            "--format=tformat:%H%x00%h%x00%aN%x00%aE%x00{date}%x00%P%x00%s%x00%B"
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if request.topo_order || request.scope == CommitLogScope::AllRefs {
        command.arg("--topo-order");
    }
    if request.scope == CommitLogScope::AllRefs {
        command.args(["--branches", "--tags", "--remotes"]);
    }
    command
}

struct SearchRecord {
    hash: String,
    short_hash: String,
    author: String,
    author_email: String,
    date: String,
    parents: String,
    subject: String,
    message: String,
}

fn read_record(reader: &mut impl BufRead) -> Result<Option<SearchRecord>, CommitSearchFailure> {
    let mut fields: [String; 8] = Default::default();
    for (index, field) in fields.iter_mut().enumerate() {
        let mut bytes = Vec::new();
        let count = reader
            .read_until(0, &mut bytes)
            .map_err(|error| failure("COMMIT_SEARCH_READ_FAILED", error.to_string()))?;
        if count == 0 && index == 0 {
            return Ok(None);
        }
        if bytes.last() != Some(&0) {
            return Err(failure(
                "COMMIT_SEARCH_PARSE_FAILED",
                format!("field={index}"),
            ));
        }
        bytes.pop();
        *field = String::from_utf8_lossy(&bytes).into_owned();
    }
    let [
        hash,
        short_hash,
        author,
        author_email,
        date,
        parents,
        subject,
        message,
    ] = fields;
    Ok(Some(SearchRecord {
        hash,
        short_hash,
        author,
        author_email,
        date,
        parents,
        subject,
        message,
    }))
}

impl SearchRecord {
    fn matches(&self, query: &str) -> bool {
        [
            &self.hash,
            &self.short_hash,
            &self.author,
            &self.author_email,
            &self.message,
        ]
        .into_iter()
        .any(|value| value.to_lowercase().contains(query))
    }

    fn into_history_item(self) -> CommitHistoryItem {
        CommitHistoryItem {
            hash: self.hash,
            short_hash: self.short_hash,
            author: self.author,
            author_email: self.author_email,
            date: self.date,
            parent_hashes: self
                .parents
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            message: self.subject,
            ref_decorations: Vec::new(),
            signature_status: SignatureStatus::None,
            key_type: None,
        }
    }
}

fn enrich_matches(
    repo: Option<&gix::Repository>,
    decorations: &HashMap<String, Vec<super::types::CommitRefDecoration>>,
    commits: &mut [CommitHistoryItem],
) {
    for commit in commits {
        commit.ref_decorations = decorations.get(&commit.hash).cloned().unwrap_or_default();
        let Some(repo) = repo else {
            continue;
        };
        let Some(object) = gix::ObjectId::from_hex(commit.hash.as_bytes())
            .ok()
            .and_then(|id| repo.find_object(id).ok())
        else {
            continue;
        };
        let header_end = object
            .data
            .windows(2)
            .position(|bytes| bytes == b"\n\n")
            .unwrap_or(object.data.len());
        if let Some(signature) = object.data[..header_end]
            .split(|byte| *byte == b'\n')
            .find_map(|line| line.strip_prefix(b"gpgsig "))
        {
            commit.signature_status = SignatureStatus::Signed;
            commit.key_type = Some(
                if signature.starts_with(b"-----BEGIN SSH SIGNATURE-----") {
                    "ssh"
                } else {
                    "gpg"
                }
                .to_string(),
            );
        }
    }
}

fn failure(code: &str, details: impl Into<String>) -> CommitSearchFailure {
    CommitSearchFailure {
        code: code.to_string(),
        details: details.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::Path;
    use tempfile::TempDir;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(path)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args)
            .output()
            .expect("run fixture Git");
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn fixture(count: usize) -> TempDir {
        let dir = TempDir::new().expect("fixture directory");
        git(dir.path(), &["init", "-b", "main"]);
        fs::write(
            dir.path().join(".mailmap"),
            "Zoë Survey <resolved@example.test> Alias <old@example.test>\n",
        )
        .expect("write mailmap");
        let mut input = Vec::new();
        for index in 0..count {
            let body = if index == 0 {
                "Oldest body-only [literal].* \u{1e}\u{1f} CAFÉ"
            } else {
                "archive needle"
            };
            let message = format!("Survey record {index}\n\n{body}\n");
            writeln!(input, "commit refs/heads/main\nmark :{}\nauthor Alias <old@example.test> {} +0000\ncommitter Survey <survey@example.test> {} +0000\ndata {}", index + 1, 1700000000 + index, 1700100000 + index, message.len()).expect("write fast-import header");
            input.extend_from_slice(message.as_bytes());
            if index > 0 {
                writeln!(input, "from :{index}").expect("write parent");
            }
            input.push(b'\n');
        }
        input.extend_from_slice(b"done\n");
        let mut child = Command::new("git")
            .current_dir(dir.path())
            .args(["fast-import", "--quiet"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start fixture import");
        child
            .stdin
            .take()
            .expect("fixture stdin")
            .write_all(&input)
            .expect("write fixture import");
        let output = child.wait_with_output().expect("wait for import");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        dir
    }

    fn request(path: &Path, query: &str, id: &str) -> CommitSearchRequest {
        CommitSearchRequest {
            repo_path: path.to_string_lossy().into_owned(),
            query: query.to_string(),
            session_id: id.to_string(),
            scope: CommitLogScope::CurrentCheckout,
            topo_order: false,
        }
    }

    fn start(
        manager: &Arc<CommitSearchManager>,
        request: CommitSearchRequest,
        window: &str,
    ) -> mpsc::Receiver<CommitSearchEvent> {
        let (sender, receiver) = mpsc::channel();
        manager
            .start(
                window.to_string(),
                request,
                CommitDateMode::AuthorDate,
                move |event| sender.send(event).is_ok(),
            )
            .expect("start search");
        receiver
    }

    fn page(
        receiver: &mpsc::Receiver<CommitSearchEvent>,
    ) -> (Vec<CommitHistoryItem>, CommitSearchStatus, usize) {
        let mut commits = Vec::new();
        loop {
            let event = receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("receive search event");
            assert!(event.error.is_none(), "{:?}", event.error);
            commits.extend(event.commits);
            if event.status != CommitSearchStatus::Scanning {
                return (commits, event.status, event.scanned_count);
            }
        }
    }

    #[test]
    fn search_resumes_one_traversal_across_pages_without_duplicates() {
        let dir = fixture(241);
        let manager = Arc::new(CommitSearchManager::default());
        let receiver = start(
            &manager,
            request(dir.path(), "survey record", "pages"),
            "main",
        );
        let (mut commits, status, scanned) = page(&receiver);
        assert_eq!(
            (commits.len(), status, scanned),
            (100, CommitSearchStatus::Paused, 100)
        );
        let session = manager
            .sessions
            .lock()
            .expect("sessions")
            .get("main")
            .expect("session")
            .clone();
        let process_id = session
            .child
            .lock()
            .expect("child")
            .as_ref()
            .expect("running child")
            .id();
        manager
            .continue_search("main", "pages")
            .expect("continue page");
        let (second, status, scanned) = page(&receiver);
        assert_eq!(
            (second.len(), status, scanned),
            (100, CommitSearchStatus::Paused, 200)
        );
        assert_eq!(
            session
                .child
                .lock()
                .expect("child")
                .as_ref()
                .expect("same child")
                .id(),
            process_id
        );
        commits.extend(second);
        manager
            .continue_search("main", "pages")
            .expect("continue final page");
        let (last, status, scanned) = page(&receiver);
        assert_eq!(
            (last.len(), status, scanned),
            (41, CommitSearchStatus::Complete, 241)
        );
        commits.extend(last);
        let expected = git(dir.path(), &["log", "--format=%H"]);
        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.hash.as_str())
                .collect::<Vec<_>>(),
            expected.lines().collect::<Vec<_>>()
        );
    }

    #[test]
    fn searches_older_bodies_mailmapped_identity_hashes_and_literal_unicode() {
        let dir = fixture(140);
        let hash = git(dir.path(), &["rev-list", "--max-parents=0", "HEAD"]);
        let manager = Arc::new(CommitSearchManager::default());
        for query in [
            "body-only",
            "[literal].*",
            "\u{1e}\u{1f}",
            "CAFÉ",
            &hash,
            &hash[..12],
        ] {
            let receiver = start(&manager, request(dir.path(), query, query), "main");
            let (commits, status, scanned) = page(&receiver);
            assert_eq!(status, CommitSearchStatus::Complete, "{query}");
            assert_eq!(scanned, 140);
            assert_eq!(commits.len(), 1, "{query}");
            assert_eq!(commits[0].hash, hash);
            assert_eq!(commits[0].message, "Survey record 0");
            assert_eq!(commits[0].author, "Zoë Survey");
            assert_eq!(commits[0].author_email, "resolved@example.test");
        }
        for query in ["ZOË", "resolved@example.test"] {
            let receiver = start(&manager, request(dir.path(), query, query), "main");
            let (commits, status, _) = page(&receiver);
            assert_eq!(commits.len(), 100);
            assert_eq!(status, CommitSearchStatus::Paused);
            manager.cancel_window("main");
        }
    }

    #[test]
    fn respects_ref_scope_and_keeps_decorations_on_matching_commits() {
        let dir = fixture(3);
        let parent = git(dir.path(), &["rev-parse", "HEAD~1"]);
        git(dir.path(), &["branch", "other", &parent]);
        git(dir.path(), &["checkout", "other"]);
        git(
            dir.path(),
            &[
                "-c",
                "user.name=Survey",
                "-c",
                "user.email=survey@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "Branch-only signal",
            ],
        );
        let other = git(dir.path(), &["rev-parse", "HEAD"]);
        git(dir.path(), &["tag", "archive", &other]);
        git(
            dir.path(),
            &["update-ref", "refs/remotes/origin/other", &other],
        );
        git(dir.path(), &["checkout", "main"]);
        let manager = Arc::new(CommitSearchManager::default());
        let receiver = start(
            &manager,
            request(dir.path(), "branch-only", "current"),
            "main",
        );
        assert!(page(&receiver).0.is_empty());
        let mut all_refs = request(dir.path(), "branch-only", "all");
        all_refs.scope = CommitLogScope::AllRefs;
        let receiver = start(&manager, all_refs, "main");
        let (commits, status, _) = page(&receiver);
        assert_eq!(status, CommitSearchStatus::Complete);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, other);
        let names = commits[0]
            .ref_decorations
            .iter()
            .map(|decoration| decoration.name.as_str())
            .collect::<Vec<_>>();
        for name in ["other", "origin/other", "archive"] {
            assert!(names.contains(&name), "{names:?}");
        }
    }

    #[test]
    fn completes_empty_and_no_match_searches_and_reports_invalid_repositories() {
        let empty = fixture(0);
        let manager = Arc::new(CommitSearchManager::default());
        let receiver = start(&manager, request(empty.path(), "missing", "empty"), "main");
        let (commits, status, scanned) = page(&receiver);
        assert_eq!(
            (commits.len(), status, scanned),
            (0, CommitSearchStatus::Complete, 0)
        );
        let dir = fixture(10);
        let receiver = start(&manager, request(dir.path(), "missing", "no-match"), "main");
        assert_eq!(page(&receiver).2, 10);
        let invalid = TempDir::new().expect("invalid repository directory");
        let receiver = start(
            &manager,
            request(invalid.path(), "missing", "invalid"),
            "main",
        );
        loop {
            let event = receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("failure event");
            if event.status == CommitSearchStatus::Error {
                assert_eq!(
                    event.error.expect("error detail").code,
                    "COMMIT_SEARCH_GIT_FAILED"
                );
                break;
            }
        }
    }

    #[test]
    fn cancellation_cleans_up_paused_processes_and_is_scoped_to_window_and_session() {
        let dir = fixture(110);
        let manager = Arc::new(CommitSearchManager::default());
        let first = start(&manager, request(dir.path(), "record", "first"), "main");
        assert_eq!(page(&first).1, CommitSearchStatus::Paused);
        let session = manager
            .sessions
            .lock()
            .expect("sessions")
            .get("main")
            .expect("session")
            .clone();
        let other = start(&manager, request(dir.path(), "record", "other"), "second");
        assert_eq!(page(&other).1, CommitSearchStatus::Paused);
        manager.cancel("main", "outdated");
        assert!(!session.cancelled.load(Ordering::Acquire));
        manager.cancel("main", "first");
        let deadline = Instant::now() + Duration::from_secs(3);
        while session.child.lock().expect("child").is_some() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(session.child.lock().expect("child").is_none());
        assert!(
            manager
                .sessions
                .lock()
                .expect("sessions")
                .contains_key("second")
        );
        manager.cancel_window("second");
    }

    #[test]
    fn searches_shallow_history_and_honours_the_commit_date_mode() {
        let source = fixture(12);
        let destination = TempDir::new().expect("clone parent directory");
        let clone = destination.path().join("shallow");
        git(
            destination.path(),
            &[
                "clone",
                "--no-local",
                "--depth=5",
                source.path().to_str().expect("source path"),
                clone.to_str().expect("clone path"),
            ],
        );
        let manager = Arc::new(CommitSearchManager::default());
        let receiver = start(&manager, request(&clone, "record", "author"), "main");
        let (author_dates, status, scanned) = page(&receiver);
        assert_eq!(
            (author_dates.len(), status, scanned),
            (5, CommitSearchStatus::Complete, 5)
        );
        let (sender, receiver) = mpsc::channel();
        manager
            .start(
                "main".to_string(),
                request(&clone, "record", "committer"),
                CommitDateMode::CommitterDate,
                move |event| sender.send(event).is_ok(),
            )
            .expect("start committer-date search");
        let (committer_dates, _, _) = page(&receiver);
        assert_eq!(author_dates[0].hash, committer_dates[0].hash);
        assert_ne!(author_dates[0].date, committer_dates[0].date);
        assert_eq!(
            committer_dates[0].date,
            git(&clone, &["log", "-1", "--format=%cd", "--date=iso-strict"])
        );
    }

    #[test]
    fn keeps_merge_parents_and_topological_order_in_search_results() {
        let directory = fixture(3);
        let path = directory.path();
        git(path, &["config", "user.name", "Survey"]);
        git(path, &["config", "user.email", "survey@example.test"]);
        git(path, &["config", "commit.gpgsign", "false"]);
        git(path, &["checkout", "-b", "side", "HEAD~1"]);
        git(path, &["commit", "--allow-empty", "-m", "record side"]);
        git(path, &["checkout", "main"]);
        git(path, &["commit", "--allow-empty", "-m", "record main"]);
        git(path, &["merge", "--no-ff", "side", "-m", "record merge"]);
        let manager = Arc::new(CommitSearchManager::default());
        let mut search = request(path, "record", "merge");
        search.topo_order = true;
        let receiver = start(&manager, search, "main");
        let (commits, status, _) = page(&receiver);
        assert_eq!(status, CommitSearchStatus::Complete);
        assert_eq!(commits[0].parent_hashes.len(), 2);
        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.hash.as_str())
                .collect::<Vec<_>>(),
            git(path, &["log", "--topo-order", "--format=%H"])
                .lines()
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn detects_signature_presence_without_running_verifiers() {
        let directory = fixture(1);
        let path = directory.path();
        git(path, &["config", "log.showSignature", "true"]);
        git(path, &["config", "gpg.program", "gitmun-missing-verifier"]);
        git(
            path,
            &["config", "gpg.ssh.program", "gitmun-missing-verifier"],
        );
        let manager = Arc::new(CommitSearchManager::default());
        for (header, key_type) in [("PGP", "gpg"), ("SSH", "ssh")] {
            let parent = git(path, &["rev-parse", "HEAD"]);
            let tree = git(path, &["rev-parse", "HEAD^{tree}"]);
            let raw = format!(
                "tree {tree}\nparent {parent}\nauthor Survey <survey@example.test> 1700000000 +0000\ncommitter Survey <survey@example.test> 1700000000 +0000\ngpgsig -----BEGIN {header} SIGNATURE-----\n invalid signature\n -----END {header} SIGNATURE-----\n\nsigned presence {header}\n"
            );
            let mut child = Command::new("git")
                .current_dir(path)
                .args(["hash-object", "-t", "commit", "-w", "--stdin"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("write signed fixture object");
            child
                .stdin
                .take()
                .expect("object stdin")
                .write_all(raw.as_bytes())
                .expect("write signature header");
            let output = child.wait_with_output().expect("finish signed object");
            assert!(output.status.success());
            let hash = String::from_utf8(output.stdout).expect("object hash");
            git(path, &["update-ref", "HEAD", hash.trim()]);
            let receiver = start(
                &manager,
                request(path, &format!("signed presence {header}"), key_type),
                "main",
            );
            let (commits, status, _) = page(&receiver);
            assert_eq!(status, CommitSearchStatus::Complete);
            assert_eq!(commits.len(), 1);
            assert_eq!(commits[0].signature_status, SignatureStatus::Signed);
            assert_eq!(commits[0].key_type.as_deref(), Some(key_type));
        }
    }

    #[test]
    fn cancels_an_active_scan_and_reaps_it_when_the_channel_closes() {
        let directory = fixture(150);
        let manager = Arc::new(CommitSearchManager::default());
        let callback_manager = manager.clone();
        let (events, receiver) = mpsc::channel();
        let (sessions, inspected) = mpsc::channel();
        manager
            .start(
                "main".to_string(),
                request(directory.path(), "record", "active"),
                CommitDateMode::AuthorDate,
                move |event| {
                    if event.scanned_count == 0 {
                        let session = callback_manager
                            .sessions
                            .lock()
                            .expect("sessions")
                            .get("main")
                            .expect("active session")
                            .clone();
                        sessions.send(session).expect("inspect active session");
                    }
                    let scanned = event.scanned_count;
                    events.send(event).expect("forward event");
                    if scanned > 0 {
                        callback_manager.cancel("main", "active");
                    }
                    true
                },
            )
            .expect("start cancellable scan");
        let session = inspected
            .recv_timeout(Duration::from_secs(3))
            .expect("inspect session");
        loop {
            match receiver.recv_timeout(Duration::from_secs(3)) {
                Ok(event) => assert!(event.scanned_count <= PAGE_SIZE),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(error) => panic!("scan did not stop: {error}"),
            }
        }
        assert!(session.child.lock().expect("child").is_none());
        assert!(manager.sessions.lock().expect("sessions").is_empty());
    }

    #[test]
    fn rejects_truncated_records_and_preserves_multiline_messages() {
        let input = b"hash\0short\0author\0mail\0date\0parents\0subject\0subject\n\nbody\x1e\x1f\0";
        let record = read_record(&mut &input[..])
            .expect("read framed record")
            .expect("record");
        assert!(record.matches("body\u{1e}\u{1f}"));
        assert!(read_record(&mut &input[..input.len() - 1]).is_err());
    }
}
