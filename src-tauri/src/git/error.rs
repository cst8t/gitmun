use std::fmt::{Display, Formatter};

use super::error_interpretation::{interpret_cli_error, interpret_gix_error, InterpretedGitError};

#[derive(Debug)]
pub enum GitError {
    InvalidInput(String),
    GitUnavailable,
    CommandFailed {
        command: String,
        stderr: String,
        exit_code: Option<i32>,
    },
    IoError(String),
    GixError {
        message: String,
        interpreted: Option<InterpretedGitError>,
    },
}

impl Display for GitError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(message) => write!(f, "Invalid input: {message}"),
            Self::GitUnavailable => write!(f, "Git executable was not found on PATH"),
            Self::CommandFailed {
                command,
                stderr,
                exit_code,
            } => {
                let operation = command_operation(command);
                let interpreted = interpret_cli_error(operation.as_deref(), stderr, *exit_code);
                if stderr.is_empty() {
                    write!(f, "{}\nGit command failed: {command}", interpreted.summary)
                } else {
                    write!(
                        f,
                        "{}\nGit command failed: {command}\n{stderr}",
                        interpreted.summary
                    )
                }
            }
            Self::IoError(message) => write!(f, "I/O error: {message}"),
            Self::GixError {
                message,
                interpreted,
            } => {
                let fallback;
                let interpreted = match interpreted {
                    Some(interpreted) => interpreted,
                    None => {
                        fallback =
                            interpret_gix_error(None, &std::io::Error::other(message.clone()));
                        &fallback
                    }
                };
                write!(f, "{}\ngix error: {message}", interpreted.summary)
            }
        }
    }
}

fn command_operation(command: &str) -> Option<String> {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 2 || parts[0] != "git" {
        return None;
    }

    if parts[1] == "branch" {
        return match parts.get(2).copied() {
            Some("-d" | "--delete") => Some("delete-branch".to_string()),
            Some("-D") => Some("force-delete-branch".to_string()),
            _ => Some("branch".to_string()),
        };
    }

    Some(parts[1].to_string())
}

impl std::error::Error for GitError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_operation_detects_branch_delete() {
        assert_eq!(
            command_operation("git branch -d feature/test").as_deref(),
            Some("delete-branch")
        );
        assert_eq!(
            command_operation("git branch --delete feature/test").as_deref(),
            Some("delete-branch")
        );
        assert_eq!(
            command_operation("git branch -D feature/test").as_deref(),
            Some("force-delete-branch")
        );
    }

    #[test]
    fn display_interprets_unmerged_branch_delete() {
        let error = GitError::CommandFailed {
            command: "git branch -d feature/test".to_string(),
            stderr: "error: the branch 'feature/test' is not fully merged".to_string(),
            exit_code: Some(1),
        };
        let message = error.to_string();

        assert!(message.contains("GITMUN_ERROR_UNMERGED_BRANCH_DELETE"));
    }

    #[test]
    fn display_does_not_interpret_force_delete_as_unmerged_delete() {
        let error = GitError::CommandFailed {
            command: "git branch -D feature/test".to_string(),
            stderr: "error: the branch 'feature/test' is not fully merged".to_string(),
            exit_code: Some(1),
        };
        let message = error.to_string();

        assert!(!message.contains("GITMUN_ERROR_UNMERGED_BRANCH_DELETE"));
    }
}

impl From<std::io::Error> for GitError {
    fn from(value: std::io::Error) -> Self {
        if value.kind() == std::io::ErrorKind::NotFound {
            return Self::GitUnavailable;
        }

        Self::IoError(value.to_string())
    }
}

pub type GitResult<T> = Result<T, GitError>;
