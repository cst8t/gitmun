use crate::git::types::{LocalCopyDestinationMode, LocalCopyMode};
use crate::shell::{ContextAction, WindowRouting};
use clap::{Command as ClapCommand, CommandFactory, Parser, Subcommand, ValueEnum};
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
    pub window_options: Option<CloneWindowStartupOptions>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalCopyStartupOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_mode: Option<LocalCopyMode>,
    pub destination_mode: LocalCopyDestinationMode,
    #[serde(default, skip_serializing_if = "is_false")]
    pub start_copy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operationMode", content = "options", rename_all = "camelCase")]
pub enum CloneWindowStartupOptions {
    Clone(CloneStartupOptions),
    Copy(LocalCopyStartupOptions),
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
    #[command(hide = true)]
    Copy {
        #[arg(value_name = "SOURCE")]
        source: Option<String>,
        #[arg(value_name = "DESTINATION")]
        destination: Option<PathBuf>,
        #[arg(long, value_name = "DESTINATION", conflicts_with = "destination")]
        to: Option<PathBuf>,
        #[arg(long, value_enum, value_name = "MODE")]
        mode: Option<CliLocalCopyMode>,
        #[arg(long)]
        delete_existing: bool,
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

#[derive(Clone, Copy, Debug, ValueEnum)]
enum CliLocalCopyMode {
    FilesOnly,
    CompleteRepository,
}

impl From<CliLocalCopyMode> for LocalCopyMode {
    fn from(value: CliLocalCopyMode) -> Self {
        match value {
            CliLocalCopyMode::FilesOnly => LocalCopyMode::FilesOnly,
            CliLocalCopyMode::CompleteRepository => LocalCopyMode::CompleteRepository,
        }
    }
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
        Some(Command::Copy {
            source,
            destination,
            to,
            mode,
            delete_existing,
            start,
        }) => copy_action(
            source,
            destination.or(to),
            mode,
            delete_existing,
            start,
            routing,
        ),
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
    let full_command = Cli::command();
    let arguments = full_command.get_arguments().cloned().collect::<Vec<_>>();
    let subcommands = full_command
        .get_subcommands()
        .filter(|subcommand| subcommand.get_name() != "copy")
        .cloned()
        .collect::<Vec<_>>();
    let mut command = ClapCommand::new("gitmun")
        .version(env!("CARGO_PKG_VERSION"))
        .args(arguments)
        .subcommands(subcommands);
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
        window_options: None,
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

    let options = CloneStartupOptions {
        repo_url,
        destination: Some(path.clone()),
        start_clone,
    };

    CliOutcome::Launch(Some(ShellStartupAction {
        action: ContextAction::CloneRepo,
        path,
        routing,
        window_options: Some(CloneWindowStartupOptions::Clone(options)),
    }))
}

fn copy_action(
    source: Option<String>,
    destination: Option<PathBuf>,
    mode: Option<CliLocalCopyMode>,
    delete_existing: bool,
    start_copy: bool,
    routing: Option<WindowRouting>,
) -> CliOutcome {
    if start_copy && source.is_none() {
        return cli_error("SOURCE is required when --start is used");
    }
    if start_copy && destination.is_none() {
        return cli_error("DESTINATION is required when --start is used");
    }
    if start_copy && mode.is_none() {
        return cli_error("--mode is required when --start is used");
    }
    if delete_existing && !matches!(mode, Some(CliLocalCopyMode::FilesOnly)) {
        return cli_error("--delete-existing requires --mode files-only");
    }

    let source = source.map(normalise_copy_source);
    let destination = destination.map(|path| normalise_cli_path(&path));
    let path = destination
        .clone()
        .unwrap_or_else(|| current_dir_path().to_string_lossy().into_owned());
    let options = LocalCopyStartupOptions {
        source,
        destination,
        copy_mode: mode.map(LocalCopyMode::from),
        destination_mode: if delete_existing {
            LocalCopyDestinationMode::DeleteExisting
        } else {
            LocalCopyDestinationMode::DropOnTop
        },
        start_copy,
    };

    CliOutcome::Launch(Some(ShellStartupAction {
        action: ContextAction::LocalCopyRepo,
        path,
        routing,
        window_options: Some(CloneWindowStartupOptions::Copy(options)),
    }))
}

fn cli_error(message: &str) -> CliOutcome {
    CliOutcome::Error(format!("error: {message}\n"))
}

fn normalise_copy_source(source: String) -> String {
    let path = Path::new(&source);
    if path.exists() {
        normalise_cli_path(path)
    } else {
        source
    }
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
                window_options: None,
            }))
        );
    }

    #[test]
    fn parses_open_command() {
        let path = cwd_path("project");

        assert_eq!(
            parse(&["gitmun", "open", &path]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::OpenRepo,
                path,
                routing: None,
                window_options: None,
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
                window_options: Some(CloneWindowStartupOptions::Clone(CloneStartupOptions {
                    repo_url: None,
                    destination: Some(current_dir_path().to_string_lossy().into_owned()),
                    start_clone: false,
                })),
            }))
        );
    }

    #[test]
    fn parses_clone_repo_and_destination() {
        let destination = cwd_path("projects/repo");

        assert_eq!(
            parse(&[
                "gitmun",
                "clone",
                "git@github.com:owner/repo.git",
                &destination,
            ]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::CloneRepo,
                path: destination.clone(),
                routing: None,
                window_options: Some(CloneWindowStartupOptions::Clone(CloneStartupOptions {
                    repo_url: Some("git@github.com:owner/repo.git".to_string()),
                    destination: Some(destination),
                    start_clone: false,
                })),
            }))
        );
    }

    #[test]
    fn parses_clone_destination_option() {
        let destination = cwd_path("projects");

        assert_eq!(
            parse(&["gitmun", "clone", "--to", &destination]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::CloneRepo,
                path: destination.clone(),
                routing: None,
                window_options: Some(CloneWindowStartupOptions::Clone(CloneStartupOptions {
                    repo_url: None,
                    destination: Some(destination),
                    start_clone: false,
                })),
            }))
        );
    }

    #[test]
    fn parses_clone_start_flag() {
        assert_eq!(
            parse(&[
                "gitmun",
                "clone",
                "https://example.test/repo.git",
                "--start"
            ]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::CloneRepo,
                path: current_dir_path().to_string_lossy().into_owned(),
                routing: None,
                window_options: Some(CloneWindowStartupOptions::Clone(CloneStartupOptions {
                    repo_url: Some("https://example.test/repo.git".to_string()),
                    destination: Some(current_dir_path().to_string_lossy().into_owned()),
                    start_clone: true,
                })),
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
                window_options: None,
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
                window_options: None,
            }))
        );
    }

    #[test]
    fn parses_bare_copy() {
        assert_eq!(
            parse(&["gitmun", "copy"]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::LocalCopyRepo,
                path: current_dir_path().to_string_lossy().into_owned(),
                routing: None,
                window_options: Some(CloneWindowStartupOptions::Copy(LocalCopyStartupOptions {
                    source: None,
                    destination: None,
                    copy_mode: None,
                    destination_mode: LocalCopyDestinationMode::DropOnTop,
                    start_copy: false,
                },)),
            }))
        );
    }

    #[test]
    fn parses_copy_source_and_destination() {
        let destination = cwd_path("copies/repo");

        assert_eq!(
            parse(&[
                "gitmun",
                "copy",
                "https://example.test/repo.git",
                &destination,
                "--mode",
                "complete-repository",
            ]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::LocalCopyRepo,
                path: destination.clone(),
                routing: None,
                window_options: Some(CloneWindowStartupOptions::Copy(LocalCopyStartupOptions {
                    source: Some("https://example.test/repo.git".to_string()),
                    destination: Some(destination),
                    copy_mode: Some(LocalCopyMode::CompleteRepository),
                    destination_mode: LocalCopyDestinationMode::DropOnTop,
                    start_copy: false,
                },)),
            }))
        );
    }

    #[test]
    fn normalises_existing_copy_source_and_destination() {
        let destination = cwd_path("copies/repo");

        assert_eq!(
            parse(&[
                "gitmun",
                "copy",
                ".",
                "--to",
                "copies/repo",
                "--mode",
                "files-only",
            ]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::LocalCopyRepo,
                path: destination.clone(),
                routing: None,
                window_options: Some(CloneWindowStartupOptions::Copy(LocalCopyStartupOptions {
                    source: Some(cwd_path(".")),
                    destination: Some(destination),
                    copy_mode: Some(LocalCopyMode::FilesOnly),
                    destination_mode: LocalCopyDestinationMode::DropOnTop,
                    start_copy: false,
                },)),
            }))
        );
    }

    #[test]
    fn parses_started_delete_existing_copy() {
        let destination = cwd_path("copies/repo");

        assert_eq!(
            parse(&[
                "gitmun",
                "--reuse-window",
                "copy",
                "https://example.test/repo.git",
                &destination,
                "--mode",
                "files-only",
                "--delete-existing",
                "--start",
            ]),
            CliOutcome::Launch(Some(ShellStartupAction {
                action: ContextAction::LocalCopyRepo,
                path: destination.clone(),
                routing: Some(WindowRouting::ReuseWindow),
                window_options: Some(CloneWindowStartupOptions::Copy(LocalCopyStartupOptions {
                    source: Some("https://example.test/repo.git".to_string()),
                    destination: Some(destination),
                    copy_mode: Some(LocalCopyMode::FilesOnly),
                    destination_mode: LocalCopyDestinationMode::DeleteExisting,
                    start_copy: true,
                },)),
            }))
        );
    }

    #[test]
    fn copy_start_requires_source_destination_and_mode() {
        for (args, expected) in [
            (vec!["gitmun", "copy", "--start"], "SOURCE is required"),
            (
                vec!["gitmun", "copy", "source", "--start"],
                "DESTINATION is required",
            ),
            (
                vec!["gitmun", "copy", "source", "destination", "--start"],
                "--mode is required",
            ),
        ] {
            match parse(&args) {
                CliOutcome::Error(text) => assert!(text.contains(expected)),
                other => panic!("expected error outcome, got {other:?}"),
            }
        }
    }

    #[test]
    fn delete_existing_requires_files_only_mode() {
        for args in [
            vec!["gitmun", "copy", "--delete-existing"],
            vec![
                "gitmun",
                "copy",
                "--mode",
                "complete-repository",
                "--delete-existing",
            ],
        ] {
            match parse(&args) {
                CliOutcome::Error(text) => {
                    assert!(text.contains("--delete-existing requires --mode files-only"));
                }
                other => panic!("expected error outcome, got {other:?}"),
            }
        }
    }

    #[test]
    fn copy_rejects_two_destinations() {
        match parse(&[
            "gitmun",
            "copy",
            "source",
            "destination",
            "--to",
            "other-destination",
        ]) {
            CliOutcome::Error(text) => assert!(text.contains("cannot be used with")),
            other => panic!("expected error outcome, got {other:?}"),
        }
    }

    #[test]
    fn parses_copy_in_new_window() {
        match parse(&["gitmun", "--new-window", "copy"]) {
            CliOutcome::Launch(Some(action)) => {
                assert_eq!(action.routing, Some(WindowRouting::NewWindow));
                assert_eq!(action.action, ContextAction::LocalCopyRepo);
            }
            other => panic!("expected launch outcome, got {other:?}"),
        }
    }

    #[test]
    fn serialises_copy_window_options_for_the_frontend() {
        let options = CloneWindowStartupOptions::Copy(LocalCopyStartupOptions {
            source: Some("/source".to_string()),
            destination: Some("/destination".to_string()),
            copy_mode: Some(LocalCopyMode::FilesOnly),
            destination_mode: LocalCopyDestinationMode::DropOnTop,
            start_copy: true,
        });

        assert_eq!(
            serde_json::to_value(options).expect("serialise startup options"),
            serde_json::json!({
                "operationMode": "copy",
                "options": {
                    "source": "/source",
                    "destination": "/destination",
                    "copyMode": "filesOnly",
                    "destinationMode": "dropOnTop",
                    "startCopy": true
                }
            })
        );
    }

    #[test]
    fn help_prints_without_launching() {
        match parse(&["gitmun", "--help"]) {
            CliOutcome::Print(text) => {
                assert!(text.contains("Usage:"));
                assert!(!text.contains("\n  copy"));
            }
            other => panic!("expected print outcome, got {other:?}"),
        }
    }

    #[test]
    fn completions_print_without_launching() {
        match parse(&["gitmun", "completions", "bash"]) {
            CliOutcome::Print(text) => {
                assert!(text.contains("gitmun"));
                assert!(!text.contains("_copy"));
            }
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
