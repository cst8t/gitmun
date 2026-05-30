use crate::shell::{ContextAction, WindowRouting};
use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use clap_complete::{Shell, generate};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStartupAction {
    pub action: ContextAction,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing: Option<WindowRouting>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub start_clone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloneStartupOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub start_clone: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, PartialEq)]
pub enum CliOutcome {
    Launch(Option<ShellStartupAction>),
    Print(String),
    Error(String),
}

#[derive(Parser, Debug)]
#[command(
    name = "gitmun",
    version,
    about = "Launch Gitmun from the command line",
    disable_help_subcommand = true
)]
struct Cli {
    #[arg(long, global = true, conflicts_with = "reuse_window")]
    new_window: bool,
    #[arg(long, global = true, conflicts_with = "new_window")]
    reuse_window: bool,
    #[arg(value_name = "PATH")]
    path: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    Open {
        #[arg(value_name = "PATH")]
        path: PathBuf,
    },
    Clone {
        #[arg(value_name = "REPO")]
        repo: Option<String>,
        #[arg(value_name = "DESTINATION")]
        destination: Option<PathBuf>,
        #[arg(long, value_name = "DESTINATION", conflicts_with = "destination")]
        to: Option<PathBuf>,
        #[arg(long)]
        start: bool,
    },
    Init {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    #[command(hide = true)]
    Initialise {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    Completions {
        shell: CompletionShell,
    },
}

#[derive(Clone, Debug, ValueEnum)]
enum CompletionShell {
    Bash,
    Zsh,
    Fish,
    Powershell,
}

impl From<CompletionShell> for Shell {
    fn from(value: CompletionShell) -> Self {
        match value {
            CompletionShell::Bash => Shell::Bash,
            CompletionShell::Zsh => Shell::Zsh,
            CompletionShell::Fish => Shell::Fish,
            CompletionShell::Powershell => Shell::PowerShell,
        }
    }
}

pub fn parse_cli(args: impl IntoIterator<Item = OsString>) -> CliOutcome {
    let args = args.into_iter().collect::<Vec<_>>();
    let cli = match Cli::try_parse_from(&args) {
        Ok(cli) => cli,
        Err(error) => {
            let text = error.to_string();
            return if error.use_stderr() {
                CliOutcome::Error(text)
            } else {
                CliOutcome::Print(text)
            };
        }
    };

    let routing = routing_for(&cli);
    match cli.command {
        Some(Command::Open { path }) => launch_action(ContextAction::OpenRepo, path, routing),
        Some(Command::Clone {
            repo,
            destination,
            to,
            start,
        }) => clone_action(repo, destination.or(to), start, routing),
        Some(Command::Init { path }) | Some(Command::Initialise { path }) => launch_action(
            ContextAction::InitialiseRepo,
            path.unwrap_or_else(current_dir_path),
            routing,
        ),
        Some(Command::Completions { shell }) => completion_script(shell),
        None => {
            if let Some(path) = cli.path {
                launch_action(ContextAction::OpenRepo, path, routing)
            } else {
                CliOutcome::Launch(None)
            }
        }
    }
}

fn routing_for(cli: &Cli) -> Option<WindowRouting> {
    if cli.new_window {
        Some(WindowRouting::NewWindow)
    } else if cli.reuse_window {
        Some(WindowRouting::ReuseWindow)
    } else {
        None
    }
}

fn completion_script(shell: CompletionShell) -> CliOutcome {
    let mut command = Cli::command();
    let mut output = Vec::new();
    generate(Shell::from(shell), &mut command, "gitmun", &mut output);
    CliOutcome::Print(String::from_utf8_lossy(&output).into_owned())
}

fn launch_action(
    action: ContextAction,
    path: PathBuf,
    routing: Option<WindowRouting>,
) -> CliOutcome {
    CliOutcome::Launch(Some(ShellStartupAction {
        action,
        path: normalise_cli_path(&path),
        routing,
        repo_url: None,
        destination: None,
        start_clone: false,
    }))
}

fn clone_action(
    repo_url: Option<String>,
    destination: Option<PathBuf>,
    start_clone: bool,
    routing: Option<WindowRouting>,
) -> CliOutcome {
    let destination = destination.map(|path| normalise_cli_path(&path));
    let path = destination
        .clone()
        .unwrap_or_else(|| current_dir_path().to_string_lossy().into_owned());

    CliOutcome::Launch(Some(ShellStartupAction {
        action: ContextAction::CloneRepo,
        path,
        routing,
        repo_url,
        destination,
        start_clone,
    }))
}

fn current_dir_path() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn normalise_cli_path(path: &Path) -> String {
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        current_dir_path().join(path)
    };
    resolved.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> CliOutcome {
        parse_cli(args.iter().map(OsString::from))
    }

    fn cwd_path(path: &str) -> String {
        current_dir_path().join(path).to_string_lossy().into_owned()
    }

    #[test]
    fn parses_bare_launch() {
        assert_eq!(parse(&["gitmun"]), CliOutcome::Launch(None));
    }

    #[test]
    fn parses_positional_path_as_open_repo() {
        assert_eq!(
            parse(&["gitmun", "."]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::OpenRepo,
                path: cwd_path("."),
                routing: None,
                repo_url: None,
                destination: None,
                start_clone: false,
            }))
        );
    }

    #[test]
    fn parses_open_command() {
        assert_eq!(
            parse(&["gitmun", "open", "/home/user/project"]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::OpenRepo,
                path: "/home/user/project".to_string(),
                routing: None,
                repo_url: None,
                destination: None,
                start_clone: false,
            }))
        );
    }

    #[test]
    fn parses_clone_defaulting_to_current_dir() {
        assert_eq!(
            parse(&["gitmun", "clone"]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::CloneRepo,
                path: current_dir_path().to_string_lossy().into_owned(),
                routing: None,
                repo_url: None,
                destination: None,
                start_clone: false,
            }))
        );
    }

    #[test]
    fn parses_clone_repo_and_destination() {
        assert_eq!(
            parse(&[
                "gitmun",
                "clone",
                "git@github.com:owner/repo.git",
                "/home/user/projects/repo"
            ]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::CloneRepo,
                path: "/home/user/projects/repo".to_string(),
                routing: None,
                repo_url: Some("git@github.com:owner/repo.git".to_string()),
                destination: Some("/home/user/projects/repo".to_string()),
                start_clone: false,
            }))
        );
    }

    #[test]
    fn parses_clone_destination_option() {
        assert_eq!(
            parse(&["gitmun", "clone", "--to", "/home/user/projects"]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::CloneRepo,
                path: "/home/user/projects".to_string(),
                routing: None,
                repo_url: None,
                destination: Some("/home/user/projects".to_string()),
                start_clone: false,
            }))
        );
    }

    #[test]
    fn parses_clone_start_flag() {
        assert_eq!(
            parse(&["gitmun", "clone", "https://example.test/repo.git", "--start"]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::CloneRepo,
                path: current_dir_path().to_string_lossy().into_owned(),
                routing: None,
                repo_url: Some("https://example.test/repo.git".to_string()),
                destination: None,
                start_clone: true,
            }))
        );
    }

    #[test]
    fn parses_init_defaulting_to_current_dir() {
        assert_eq!(
            parse(&["gitmun", "init"]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::InitialiseRepo,
                path: current_dir_path().to_string_lossy().into_owned(),
                routing: None,
                repo_url: None,
                destination: None,
                start_clone: false,
            }))
        );
    }

    #[test]
    fn parses_window_routing() {
        assert_eq!(
            parse(&["gitmun", "--reuse-window", "open", "."]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::OpenRepo,
                path: cwd_path("."),
                routing: Some(WindowRouting::ReuseWindow),
                repo_url: None,
                destination: None,
                start_clone: false,
            }))
        );
    }

    #[test]
    fn help_prints_without_launching() {
        match parse(&["gitmun", "--help"]) {
            CliOutcome::Print(text) => assert!(text.contains("Usage:")),
            other => panic!("expected print outcome, got {other:?}"),
        }
    }

    #[test]
    fn completions_print_without_launching() {
        match parse(&["gitmun", "completions", "bash"]) {
            CliOutcome::Print(text) => assert!(text.contains("gitmun")),
            other => panic!("expected print outcome, got {other:?}"),
        }
    }

    #[test]
    fn unknown_flag_errors_without_launching() {
        match parse(&["gitmun", "--unknown"]) {
            CliOutcome::Error(text) => assert!(text.contains("--unknown")),
            other => panic!("expected error outcome, got {other:?}"),
        }
    }
}
