use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub enum GitError {
    InvalidInput(String),
    GitUnavailable,
    CommandFailed { command: String, stderr: String },
    IoError(String),
    GixError(String),
}

impl Display for GitError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(message) => write!(f, "Invalid input: {message}"),
            Self::GitUnavailable => write!(f, "Git executable was not found on PATH"),
            Self::CommandFailed { command, stderr } => {
                if stderr.is_empty() {
                    write!(f, "Git command failed: {command}")
                } else {
                    write!(f, "Git command failed: {command}\n{stderr}")
                }
            }
            Self::IoError(message) => write!(f, "I/O error: {message}"),
            Self::GixError(message) => write!(f, "gix error: {message}"),
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
