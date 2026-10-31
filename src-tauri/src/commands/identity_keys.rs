use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::Output;

use serde::{Deserialize, Serialize};

use crate::git::types::IdentityScope;

const CONTEXT_ERROR: &str = "GITMUN_ERROR_IDENTITY_SIGNING_CONTEXT_FAILED";
const READ_ERROR: &str = "GITMUN_ERROR_SSH_KEY_READ_FAILED";
const TOO_LARGE: &str = "GITMUN_ERROR_SSH_KEY_TOO_LARGE";
const PRIVATE: &str = "GITMUN_ERROR_SSH_KEY_PRIVATE";
const INVALID: &str = "GITMUN_ERROR_SSH_KEY_INVALID";
const MULTIPLE: &str = "GITMUN_ERROR_SSH_KEY_MULTIPLE";
const MAX_KEY_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentitySigningContextRequest {
    pub repo_path: String,
    pub scope: IdentityScope,
    pub signing_format: Option<String>,
    #[serde(default)]
    pub clear_signing_format: bool,
}

#[derive(Debug, Serialize)]
pub struct IdentitySigningContext {
    pub format: String,
}

fn git_output(repo_path: &Path, arguments: &[&str]) -> Result<Output, String> {
    crate::git_command()
        .args(arguments)
        .current_dir(repo_path)
        .output()
        .map_err(|_| CONTEXT_ERROR.to_string())
}

fn signing_context<F>(
    request: &IdentitySigningContextRequest,
    run: F,
) -> Result<IdentitySigningContext, String>
where
    F: Fn(&Path, &[&str]) -> Result<Output, String>,
{
    let repo_path = Path::new(&request.repo_path);
    let draft = if request.clear_signing_format {
        None
    } else {
        request
            .signing_format
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let mut direct_target = None;
    let direct_origins = if request.clear_signing_format || draft.is_some() {
        let scope = match request.scope {
            IdentityScope::Local => "--local",
            IdentityScope::Global => "--global",
        };
        let output = run(
            repo_path,
            &[
                "config",
                scope,
                "--no-includes",
                "--null",
                "--show-origin",
                "--list",
            ],
        )?;
        if !output.status.success()
            && !(matches!(request.scope, IdentityScope::Global)
                && output.status.code() == Some(128))
        {
            return Err(CONTEXT_ERROR.to_string());
        }
        let origins = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .enumerate()
            .filter_map(|(index, part)| (index % 2 == 0).then(|| part.to_vec()))
            .collect::<Vec<_>>();
        if matches!(request.scope, IdentityScope::Global) {
            let paths = run(repo_path, &["var", "GIT_CONFIG_GLOBAL"])?;
            if !paths.status.success() {
                return Err(CONTEXT_ERROR.to_string());
            }
            let paths =
                std::str::from_utf8(&paths.stdout).map_err(|_| CONTEXT_ERROR.to_string())?;
            let paths: Vec<_> = paths.lines().collect();
            let target = paths
                .iter()
                .rev()
                .find(|path| Path::new(path).exists())
                .or_else(|| paths.last())
                .ok_or_else(|| CONTEXT_ERROR.to_string())?;
            let target =
                std::fs::canonicalize(target).unwrap_or_else(|_| Path::new(target).to_path_buf());
            direct_target = Some(target.clone());
            origins
                .into_iter()
                .filter(|origin| {
                    origin
                        .strip_prefix(b"file:")
                        .and_then(|path| std::str::from_utf8(path).ok())
                        .is_some_and(|path| {
                            std::fs::canonicalize(path)
                                .unwrap_or_else(|_| Path::new(path).to_path_buf())
                                == target
                        })
                })
                .collect()
        } else {
            if draft.is_some() {
                let path = run(
                    repo_path,
                    &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                )?;
                if !path.status.success() {
                    return Err(CONTEXT_ERROR.to_string());
                }
                let path =
                    std::str::from_utf8(&path.stdout).map_err(|_| CONTEXT_ERROR.to_string())?;
                direct_target = Some(Path::new(path.trim_end()).join("config"));
            }
            origins
        }
    } else {
        Vec::new()
    };

    let output = run(
        repo_path,
        &[
            "config",
            "--includes",
            "--null",
            "--show-origin",
            "--show-scope",
            "--list",
        ],
    )?;
    if !output.status.success() {
        return Err(CONTEXT_ERROR.to_string());
    }
    let records: Vec<_> = output.stdout.split(|byte| *byte == 0).collect();
    let records: Vec<_> = records.chunks_exact(3).collect();
    let direct_scope: &[u8] = match request.scope {
        IdentityScope::Local => b"local",
        IdentityScope::Global => b"global",
    };
    let is_direct = |record: &&[&[u8]]| {
        record[0] == direct_scope && direct_origins.iter().any(|origin| origin == record[1])
    };
    let last_format = records
        .iter()
        .rposition(|record| is_direct(record) && record[2].starts_with(b"gpg.format\n"));
    let mut section_end = None;
    if draft.is_some() && last_format.is_none() {
        if let Some(path) = direct_target {
            let bytes = match std::fs::read(path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(_) => return Err(CONTEXT_ERROR.to_string()),
            };
            let config = gix::config::File::from_bytes_no_includes(
                &bytes,
                gix::config::file::Metadata::default(),
                Default::default(),
            )
            .map_err(|_| CONTEXT_ERROR.to_string())?;
            let mut values = 0;
            for section in config.sections() {
                values += section.value_names().count();
                if section.header().name().eq_ignore_ascii_case(b"gpg")
                    && section.header().subsection_name().is_none()
                {
                    section_end = Some(values);
                }
            }
        }
    }
    let insert_before = section_end.and_then(|position| {
        records
            .iter()
            .enumerate()
            .filter(|(_, record)| is_direct(record))
            .nth(position)
            .map(|(index, _)| index)
    });
    let preceding_scope = records.iter().rposition(|record| match request.scope {
        IdentityScope::Local => matches!(record[0], b"system" | b"global" | b"local"),
        IdentityScope::Global => matches!(record[0], b"system" | b"global"),
    });
    let insertion = last_format.or(preceding_scope);
    let mut format = None;
    if draft.is_some() && insertion.is_none() {
        format = draft.map(str::to_string);
    }
    for (index, record) in records.iter().enumerate() {
        let scope = record[0];
        if matches!(request.scope, IdentityScope::Global)
            && scope != b"system"
            && scope != b"global"
        {
            continue;
        }
        if insert_before == Some(index) {
            format = draft.map(str::to_string);
        }
        if let Some(value) = record[2].strip_prefix(b"gpg.format\n") {
            if !(is_direct(record) && (request.clear_signing_format || draft.is_some())) {
                format =
                    Some(String::from_utf8(value.to_vec()).map_err(|_| CONTEXT_ERROR.to_string())?);
            }
        }
        if insert_before.is_none() && insertion == Some(index) && draft.is_some() {
            format = draft.map(str::to_string);
        }
    }
    Ok(IdentitySigningContext {
        format: format.unwrap_or_else(|| "openpgp".to_string()),
    })
}

#[tauri::command]
pub async fn get_identity_signing_context(
    request: IdentitySigningContextRequest,
) -> Result<IdentitySigningContext, String> {
    tauri::async_runtime::spawn_blocking(move || signing_context(&request, git_output))
        .await
        .map_err(|_| CONTEXT_ERROR.to_string())?
}

fn read_public_key(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|_| READ_ERROR.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_KEY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_ERROR.to_string())?;
    if bytes.len() as u64 > MAX_KEY_BYTES {
        return Err(TOO_LARGE.to_string());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| INVALID.to_string())?;
    if text.contains("PRIVATE KEY-----") {
        return Err(PRIVATE.to_string());
    }
    let mut key = None;
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        if key.is_some() {
            return Err(MULTIPLE.to_string());
        }
        key = Some(ssh_key::PublicKey::from_openssh(line).map_err(|_| INVALID.to_string())?);
    }
    let key = key.ok_or_else(|| INVALID.to_string())?;
    Ok(format!(
        "key::{}",
        key.to_openssh().map_err(|_| INVALID.to_string())?
    ))
}

#[tauri::command]
pub async fn import_ssh_public_key(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_public_key(Path::new(&path)))
        .await
        .map_err(|_| READ_ERROR.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test@example.test";

    #[test]
    fn imports_one_public_key_and_rejects_private_or_invalid_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("key.pub");
        fs::write(&path, format!("# a comment\r\n\r\n{KEY}\r\n")).unwrap();
        assert_eq!(read_public_key(&path).unwrap(), format!("key::{KEY}"));
        fs::write(&path, format!("{KEY}\n{KEY}\n")).unwrap();
        assert_eq!(read_public_key(&path).unwrap_err(), MULTIPLE);
        fs::write(&path, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n").unwrap();
        assert_eq!(read_public_key(&path).unwrap_err(), PRIVATE);
        fs::write(&path, "ssh-ed25519 invalid\n").unwrap();
        assert_eq!(read_public_key(&path).unwrap_err(), INVALID);
        fs::write(&path, [0xff]).unwrap();
        assert_eq!(read_public_key(&path).unwrap_err(), INVALID);
        fs::write(&path, vec![b'a'; MAX_KEY_BYTES as usize + 1]).unwrap();
        assert_eq!(read_public_key(&path).unwrap_err(), TOO_LARGE);
        assert_eq!(
            read_public_key(&directory.path().join("missing")).unwrap_err(),
            READ_ERROR
        );
    }

    #[test]
    fn imports_ecdsa_and_security_key_public_keys() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("key.pub");
        for key in [
            "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc= user@example.com",
            "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAICFo/k5LU8863u66YC9eUO2170QduohPURkQnbLa/dczAAAABHNzaDo= user@example.com",
            "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBNdo6XfhTK080uz5UbGyOcNMo+R3nPXMBxurwH2M1bDtQYbDT6qBE7EdQGkcy/EJDXbzT0KlU9rROjcX+JsgtGAAAAAEc3NoOg== user@example.com",
        ] {
            fs::write(&path, key).unwrap();
            assert_eq!(read_public_key(&path).unwrap(), format!("key::{key}"));
        }
    }

    #[test]
    fn resolves_includes_worktree_and_draft_without_writing_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo");
        fs::create_dir(&repo).unwrap();
        assert!(
            Command::new("git")
                .args(["init", "-q"])
                .current_dir(&repo)
                .env(
                    "GIT_CONFIG_GLOBAL",
                    if cfg!(windows) { "NUL" } else { "/dev/null" }
                )
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", directory.path())
                .env_remove("GIT_CONFIG_COUNT")
                .status()
                .unwrap()
                .success()
        );
        let system = directory.path().join("system");
        let global = directory.path().join("global");
        let included = directory.path().join("included");
        fs::write(&system, "[gpg]\n\tformat = x509\n").unwrap();
        fs::write(&included, "[gpg]\n\tformat = ssh\n").unwrap();
        fs::write(
            &global,
            "[gpg]\n\tformat = openpgp\n[include]\n\tpath = included\n",
        )
        .unwrap();
        let local = repo.join(".git/config");
        let local_config = format!(
            "{}\n[gpg]\n\tformat = local-format\n[extensions]\n\tworktreeConfig = true\n",
            fs::read_to_string(&local).unwrap()
        );
        fs::write(&local, &local_config).unwrap();
        let worktree = repo.join(".git/config.worktree");
        fs::write(&worktree, "[gpg]\n\tformat = worktree-format\n").unwrap();
        let run = |path: &Path, arguments: &[&str]| {
            Command::new("git")
                .current_dir(path)
                .args(arguments)
                .env("GIT_CONFIG_SYSTEM", &system)
                .env("GIT_CONFIG_GLOBAL", &global)
                .env("GIT_CONFIG_NOSYSTEM", "0")
                .env("HOME", directory.path())
                .env("XDG_CONFIG_HOME", directory.path())
                .env_remove("GIT_CONFIG_COUNT")
                .output()
                .map_err(|_| CONTEXT_ERROR.to_string())
        };
        let mut request = IdentitySigningContextRequest {
            repo_path: repo.to_string_lossy().into_owned(),
            scope: IdentityScope::Local,
            signing_format: None,
            clear_signing_format: true,
        };
        assert_eq!(
            signing_context(&request, &run).unwrap().format,
            "worktree-format"
        );
        request.clear_signing_format = false;
        request.signing_format = Some("draft".into());
        assert_eq!(
            signing_context(&request, &run).unwrap().format,
            "worktree-format"
        );
        fs::write(&worktree, "").unwrap();
        assert_eq!(signing_context(&request, &run).unwrap().format, "draft");
        request.clear_signing_format = true;
        assert_eq!(signing_context(&request, &run).unwrap().format, "ssh");
        request.scope = IdentityScope::Global;
        assert_eq!(signing_context(&request, &run).unwrap().format, "ssh");
        request.clear_signing_format = false;
        assert_eq!(signing_context(&request, &run).unwrap().format, "ssh");
        assert_eq!(fs::read_to_string(local).unwrap(), local_config);
        assert!(
            fs::read_to_string(global)
                .unwrap()
                .contains("format = openpgp")
        );
    }
    #[test]
    fn global_clear_preserves_xdg_configuration_when_the_home_file_is_empty() {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let xdg = directory.path().join("xdg/git");
        fs::create_dir_all(&xdg).unwrap();
        fs::write(xdg.join("config"), "[gpg]\nformat = ssh\n").unwrap();
        fs::write(directory.path().join(".gitconfig"), "").unwrap();
        let run = |path: &Path, arguments: &[&str]| {
            Command::new("git")
                .current_dir(path)
                .args(arguments)
                .env_remove("GIT_CONFIG_GLOBAL")
                .env_remove("GIT_CONFIG_COUNT")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", directory.path())
                .env("XDG_CONFIG_HOME", directory.path().join("xdg"))
                .output()
                .map_err(|_| CONTEXT_ERROR.to_string())
        };
        assert!(run(&repo, &["init", "-q"]).unwrap().status.success());
        let mut request = IdentitySigningContextRequest {
            repo_path: repo.to_string_lossy().into_owned(),
            scope: IdentityScope::Global,
            signing_format: None,
            clear_signing_format: true,
        };
        assert_eq!(signing_context(&request, &run).unwrap().format, "ssh");
        request.clear_signing_format = false;
        request.signing_format = Some("openpgp".into());
        assert_eq!(signing_context(&request, &run).unwrap().format, "openpgp");
        assert_eq!(
            fs::read_to_string(directory.path().join(".gitconfig")).unwrap(),
            ""
        );
        assert_eq!(
            fs::read_to_string(xdg.join("config")).unwrap(),
            "[gpg]\nformat = ssh\n"
        );
    }
    #[test]
    fn staged_format_matches_git_with_empty_sections_and_includes() {
        let directory = tempfile::tempdir().unwrap();
        let run = |path: &Path, arguments: &[&str]| {
            Command::new("git")
                .current_dir(path)
                .args(arguments)
                .env(
                    "GIT_CONFIG_GLOBAL",
                    if cfg!(windows) { "NUL" } else { "/dev/null" },
                )
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env_remove("GIT_CONFIG_COUNT")
                .output()
                .map_err(|_| CONTEXT_ERROR.to_string())
        };
        assert!(
            run(directory.path(), &["init", "-q"])
                .unwrap()
                .status
                .success()
        );
        fs::write(
            directory.path().join(".git/included"),
            "[gpg]\nformat = ssh\n",
        )
        .unwrap();
        let config_path = directory.path().join(".git/config");
        let original = fs::read_to_string(&config_path).unwrap();
        for config in [
            "[gpg]\n[include]\npath = included\n",
            "[include]\npath = included\n[gpg]\n",
            "[gpg]\nprogram = gpg\n[include]\npath = included\n",
            "[gpg \"ssh\"]\nprogram = ssh-keygen\n[include]\npath = included\n",
            "[gpg]\nprogram = gpg\n[include]\npath = included\n[gpg]\nother = value\n",
            "[gpg]\nformat = old\n[include]\npath = included\n[gpg]\nother = value\n",
        ] {
            let contents = format!("{original}\n{config}");
            fs::write(&config_path, &contents).unwrap();
            let request = IdentitySigningContextRequest {
                repo_path: directory.path().to_string_lossy().into_owned(),
                scope: IdentityScope::Local,
                signing_format: Some("openpgp".into()),
                clear_signing_format: false,
            };
            let predicted = signing_context(&request, &run).unwrap().format;
            assert_eq!(fs::read_to_string(&config_path).unwrap(), contents);
            assert!(
                run(
                    directory.path(),
                    &["config", "--local", "gpg.format", "openpgp"]
                )
                .unwrap()
                .status
                .success()
            );
            let effective = run(directory.path(), &["config", "--get", "gpg.format"]).unwrap();
            assert_eq!(
                predicted,
                String::from_utf8(effective.stdout).unwrap().trim(),
                "{config}"
            );
        }
    }
}
