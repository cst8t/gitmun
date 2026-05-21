use std::any::type_name;
use std::error::Error;

use serde::Serialize;

/// Turns Git errors into short explanations and next-step action IDs.
///
/// When adding a new case, put the clearest match before looser matches, choose
/// the closest shared category, and add any new action IDs in `advice_for`.
/// Use higher confidence for exact Git messages, medium confidence for broad
/// gix error families, and low confidence for plain text guesses. Unknown
/// errors should stay as `Other` and keep the raw Git message.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitErrorCategory {
    Auth,
    Network,
    NonFastForward,
    NoUpstream,
    UpstreamMissing,
    ConflictInProgress,
    IndexLock,
    RepoState,
    InvalidInput,
    ToolUnavailable,
    Permission,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitBackendSource {
    GitCli,
    Gix,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterpretedGitError {
    pub category: GitErrorCategory,
    pub summary: String,
    pub suggested_actions: Vec<String>,
    pub confidence: f32,
    pub backend: GitBackendSource,
    pub raw_message: String,
    pub operation: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct Advice {
    summary: &'static str,
    actions: &'static [&'static str],
}

fn advice_for(category: GitErrorCategory, operation: Option<&str>) -> Advice {
    match (category, operation) {
        (GitErrorCategory::NonFastForward, Some("push")) => Advice {
            summary: "Push was rejected because the remote branch has new commits.",
            actions: &["fetch", "review", "integrate"],
        },
        (GitErrorCategory::NonFastForward, _) => Advice {
            summary: "The remote branch has new commits that are not present locally.",
            actions: &["fetch", "review", "integrate"],
        },
        (GitErrorCategory::NoUpstream, Some("push")) => Advice {
            summary: "This branch does not have an upstream yet.",
            actions: &["set-upstream"],
        },
        (GitErrorCategory::NoUpstream, _) => Advice {
            summary: "This branch does not have an upstream configured.",
            actions: &["set-upstream"],
        },
        (GitErrorCategory::UpstreamMissing, _) => Advice {
            summary: "The configured upstream branch is missing or no longer matches this branch.",
            actions: &["fetch", "repair-upstream"],
        },
        (GitErrorCategory::Auth, _) => Advice {
            summary: "Git could not authenticate with the remote.",
            actions: &["fix-auth-ssh", "fix-auth-https", "retry"],
        },
        (GitErrorCategory::Network, _) => Advice {
            summary: "Git could not reach the remote.",
            actions: &["check-network", "retry"],
        },
        (GitErrorCategory::ConflictInProgress, _) => Advice {
            summary: "A merge, rebase, cherry-pick, or revert needs attention first.",
            actions: &["resolve-conflicts", "continue-sequencer", "abort-sequencer"],
        },
        (GitErrorCategory::IndexLock, _) => Advice {
            summary: "Git could not lock the repository index.",
            actions: &["unlock-index", "retry"],
        },
        (GitErrorCategory::RepoState, _) => Advice {
            summary: "The repository state blocks this operation.",
            actions: &["review"],
        },
        (GitErrorCategory::InvalidInput, _) => Advice {
            summary: "Git rejected the supplied input.",
            actions: &["review"],
        },
        (GitErrorCategory::ToolUnavailable, _) => Advice {
            summary: "The Git executable or a required Git tool is unavailable.",
            actions: &["open-settings-git-executable"],
        },
        (GitErrorCategory::Permission, _) => Advice {
            summary: "Git does not have permission to read or write a required path.",
            actions: &["review", "retry"],
        },
        (GitErrorCategory::Other, _) => Advice {
            summary: "Git failed before the operation could complete.",
            actions: &["review", "retry"],
        },
    }
}

fn build_interpretation(
    category: GitErrorCategory,
    backend: GitBackendSource,
    operation: Option<&str>,
    raw_message: &str,
    confidence: f32,
) -> InterpretedGitError {
    let advice = advice_for(category, operation);
    InterpretedGitError {
        category,
        summary: advice.summary.to_string(),
        suggested_actions: advice
            .actions
            .iter()
            .map(|action| action.to_string())
            .collect(),
        confidence: confidence.clamp(0.0, 1.0),
        backend,
        raw_message: raw_message.to_string(),
        operation: operation.map(str::to_string),
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn classify_message(message: &str) -> (GitErrorCategory, f32) {
    let lower = message.to_ascii_lowercase();

    if contains_any(
        &lower,
        &[
            "non-fast-forward",
            "fetch first",
            "tip of your current branch is behind",
        ],
    ) || (lower.contains("[rejected]") && lower.contains("push"))
    {
        return (GitErrorCategory::NonFastForward, 0.95);
    }

    if lower.contains("no upstream branch") {
        return (GitErrorCategory::NoUpstream, 0.95);
    }

    if contains_any(
        &lower,
        &[
            "upstream branch of your current branch does not match",
            "has no such ref was fetched",
            "couldn't find remote ref",
            "could not find remote ref",
            "upstream is gone",
            "remote ref does not exist",
        ],
    ) || (lower.contains("remote branch")
        && contains_any(&lower, &["not found", "does not exist", "missing"]))
    {
        return (GitErrorCategory::UpstreamMissing, 0.9);
    }

    if contains_any(
        &lower,
        &[
            "authentication failed",
            "could not read from remote repository",
            "permission denied (publickey)",
            "permission to ",
            "repository not found",
            "terminal prompts disabled",
            "could not read username",
            "could not read password",
            "invalid username or password",
        ],
    ) {
        return (GitErrorCategory::Auth, 0.9);
    }

    if contains_any(
        &lower,
        &[
            "could not resolve host",
            "failed to connect",
            "connection timed out",
            "network is unreachable",
            "connection reset",
            "operation timed out",
            "unable to access",
            "couldn't connect to server",
        ],
    ) {
        return (GitErrorCategory::Network, 0.85);
    }

    if contains_any(
        &lower,
        &[
            "you have unmerged paths",
            "fix conflicts and then commit the result",
            "resolve all conflicts manually",
            "merge is in progress",
            "rebase in progress",
            "cherry-pick is already in progress",
            "revert is already in progress",
            "you need to resolve your current index first",
        ],
    ) {
        return (GitErrorCategory::ConflictInProgress, 0.9);
    }

    if contains_any(
        &lower,
        &[
            "index.lock",
            "unable to create",
            "could not lock config file",
            "cannot lock ref",
            "failed to lock",
            "lock file already exists",
        ],
    ) {
        return (GitErrorCategory::IndexLock, 0.85);
    }

    if contains_any(
        &lower,
        &[
            "not a git repository",
            "bad revision",
            "ambiguous argument",
            "needed a single revision",
            "your local changes would be overwritten",
            "please commit your changes or stash them",
        ],
    ) {
        return (GitErrorCategory::RepoState, 0.75);
    }

    if contains_any(
        &lower,
        &[
            "permission denied",
            "access is denied",
            "read-only file system",
            "operation not permitted",
        ],
    ) {
        return (GitErrorCategory::Permission, 0.75);
    }

    (GitErrorCategory::Other, 0.2)
}

pub fn interpret_cli_error(
    operation: Option<&str>,
    stderr: &str,
    exit_code: Option<i32>,
) -> InterpretedGitError {
    let raw_message = match exit_code {
        Some(code) if stderr.trim().is_empty() => format!("Git exited with status {code}."),
        Some(code) => format!("{stderr}\n(exit status {code})"),
        None => stderr.to_string(),
    };
    let (category, confidence) = classify_message(stderr);
    build_interpretation(
        category,
        GitBackendSource::GitCli,
        operation,
        raw_message.trim(),
        confidence,
    )
}

pub fn interpret_gix_error<E>(operation: Option<&str>, err: &E) -> InterpretedGitError
where
    E: Error + 'static + ?Sized,
{
    let error_type = type_name::<E>();
    let message = err.to_string();
    let lower_type = error_type.to_ascii_lowercase();

    let typed = if contains_any(&lower_type, &["transport", "connect", "protocol"]) {
        Some((GitErrorCategory::Network, 0.8))
    } else if contains_any(&lower_type, &["auth", "credential"]) {
        Some((GitErrorCategory::Auth, 0.8))
    } else if contains_any(&lower_type, &["lock", "transaction"]) {
        Some((GitErrorCategory::IndexLock, 0.8))
    } else if contains_any(&lower_type, &["config"]) {
        Some((GitErrorCategory::RepoState, 0.7))
    } else if contains_any(&lower_type, &["reference", "object", "revision", "commit"]) {
        Some((GitErrorCategory::RepoState, 0.7))
    } else {
        None
    };

    let (category, confidence) = typed.unwrap_or_else(|| {
        let (category, confidence) = classify_message(&message);
        (category, (confidence - 0.15).max(0.1))
    });

    build_interpretation(
        category,
        GitBackendSource::Gix,
        operation,
        &message,
        confidence,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct FakeTransportError;

    impl std::fmt::Display for FakeTransportError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "handshake failed")
        }
    }

    impl Error for FakeTransportError {}

    #[test]
    fn cli_non_fast_forward_wins_before_broader_rejected_text() {
        let interpreted = interpret_cli_error(
            Some("push"),
            "! [rejected] main -> main (fetch first)\nfatal: authentication failed",
            Some(1),
        );

        assert_eq!(interpreted.category, GitErrorCategory::NonFastForward);
        assert_eq!(
            interpreted.suggested_actions,
            vec!["fetch", "review", "integrate"]
        );
        assert!(interpreted.confidence >= 0.9);
    }

    #[test]
    fn cli_no_upstream_maps_to_set_upstream_action() {
        let interpreted = interpret_cli_error(
            Some("push"),
            "fatal: The current branch feature has no upstream branch.",
            Some(128),
        );

        assert_eq!(interpreted.category, GitErrorCategory::NoUpstream);
        assert_eq!(interpreted.suggested_actions, vec!["set-upstream"]);
    }

    #[test]
    fn cli_auth_and_network_are_distinct() {
        let auth = interpret_cli_error(
            Some("fetch"),
            "Permission denied (publickey). Could not read from remote repository.",
            Some(128),
        );
        let network = interpret_cli_error(
            Some("fetch"),
            "fatal: unable to access 'https://example.test/repo.git/': Could not resolve host: example.test",
            Some(128),
        );

        assert_eq!(auth.category, GitErrorCategory::Auth);
        assert_eq!(network.category, GitErrorCategory::Network);
    }

    #[test]
    fn cli_conflict_state_maps_to_sequencer_actions() {
        let interpreted = interpret_cli_error(
            Some("pull"),
            "error: you have unmerged paths\nfix conflicts and then commit the result",
            Some(1),
        );

        assert_eq!(interpreted.category, GitErrorCategory::ConflictInProgress);
        assert!(
            interpreted
                .suggested_actions
                .contains(&"resolve-conflicts".to_string())
        );
    }

    #[test]
    fn cli_index_lock_maps_to_unlock_action() {
        let interpreted = interpret_cli_error(
            Some("commit"),
            "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            Some(128),
        );

        assert_eq!(interpreted.category, GitErrorCategory::IndexLock);
        assert!(
            interpreted
                .suggested_actions
                .contains(&"unlock-index".to_string())
        );
    }

    #[test]
    fn cli_unknown_falls_back_to_other_with_low_confidence() {
        let interpreted =
            interpret_cli_error(Some("status"), "fatal: unexpected frobnication", Some(2));

        assert_eq!(interpreted.category, GitErrorCategory::Other);
        assert!(interpreted.confidence < 0.5);
    }

    #[test]
    fn gix_typed_transport_family_maps_to_network() {
        let err = FakeTransportError;
        let interpreted = interpret_gix_error(Some("fetch"), &err);

        assert_eq!(interpreted.category, GitErrorCategory::Network);
        assert_eq!(interpreted.backend, GitBackendSource::Gix);
    }

    #[test]
    fn gix_opaque_message_uses_lower_confidence_heuristics() {
        let err = std::io::Error::other("could not lock config file");
        let interpreted = interpret_gix_error(Some("commit"), &err);

        assert_eq!(interpreted.category, GitErrorCategory::IndexLock);
        assert!(interpreted.confidence < 0.85);
    }
}
