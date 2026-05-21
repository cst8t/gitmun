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
                let operation = command.split_whitespace().nth(1);
                let interpreted = interpret_cli_error(operation, stderr, *exit_code);
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

impl std::error::Error for GitError {}

impl From<std::io::Error> for GitError {
    fn from(value: std::io::Error) -> Self {
        if value.kind() == std::io::ErrorKind::NotFound {
            return Self::GitUnavailable;
        }

        Self::IoError(value.to_string())
    }
}

pub type GitResult<T> = Result<T, GitError>;
