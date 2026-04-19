use crate::shell::ContextAction;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStartupAction {
    pub action: ContextAction,
    pub path: String,
}

pub fn parse_shell_action(args: &[String]) -> Option<ShellStartupAction> {
    let mut iter = args.iter();

    iter.next()?;

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--open" => {
                if let Some(path) = iter.next() {
                    return Some(ShellStartupAction {
                        action: ContextAction::OpenRepo,
                        path: path.clone(),
                    });
                }
            }
            "--clone-here" => {
                if let Some(path) = iter.next() {
                    return Some(ShellStartupAction {
                        action: ContextAction::CloneHere,
                        path: path.clone(),
                    });
                }
            }
            s if s.starts_with("--open=") => {
                if let Some(path) = s.strip_prefix("--open=") {
                    return Some(ShellStartupAction {
                        action: ContextAction::OpenRepo,
                        path: path.to_string(),
                    });
                }
            }
            s if s.starts_with("--clone-here=") => {
                if let Some(path) = s.strip_prefix("--clone-here=") {
                    return Some(ShellStartupAction {
                        action: ContextAction::CloneHere,
                        path: path.to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_open_short() {
        let args = vec![
            "/usr/bin/gitmun".to_string(),
            "--open".to_string(),
            "/home/user/project".to_string(),
        ];
        let result = parse_shell_action(&args);
        assert_eq!(
            result,
            Some(ShellStartupAction {
                action: ContextAction::OpenRepo,
                path: "/home/user/project".to_string(),
            })
        );
    }

    #[test]
    fn test_parse_clone_here_short() {
        let args = vec![
            "/usr/bin/gitmun".to_string(),
            "--clone-here".to_string(),
            "/home/user/dir".to_string(),
        ];
        let result = parse_shell_action(&args);
        assert_eq!(
            result,
            Some(ShellStartupAction {
                action: ContextAction::CloneHere,
                path: "/home/user/dir".to_string(),
            })
        );
    }

    #[test]
    fn test_parse_open_equals() {
        let args = vec![
            "/usr/bin/gitmun".to_string(),
            "--open=/home/user/project".to_string(),
        ];
        let result = parse_shell_action(&args);
        assert_eq!(
            result,
            Some(ShellStartupAction {
                action: ContextAction::OpenRepo,
                path: "/home/user/project".to_string(),
            })
        );
    }

    #[test]
    fn test_parse_no_args() {
        let args = vec!["/usr/bin/gitmun".to_string()];
        let result = parse_shell_action(&args);
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_unknown_flag() {
        let args = vec![
            "/usr/bin/gitmun".to_string(),
            "--unknown".to_string(),
        ];
        let result = parse_shell_action(&args);
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_open_without_path() {
        let args = vec![
            "/usr/bin/gitmun".to_string(),
            "--open".to_string(),
        ];
        let result = parse_shell_action(&args);
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_windows_path() {
        let args = vec![
            r"C:\Program Files\Gitmun\gitmun.exe".to_string(),
            "--open".to_string(),
            r"D:\Projects\my-repo".to_string(),
        ];
        let result = parse_shell_action(&args);
        assert_eq!(
            result,
            Some(ShellStartupAction {
                action: ContextAction::OpenRepo,
                path: r"D:\Projects\my-repo".to_string(),
            })
        );
    }
}