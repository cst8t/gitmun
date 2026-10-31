use std::path::Path;

pub(crate) fn select_gpg_program(configured: Option<&str>) -> String {
    if let Some(validated) = configured.and_then(validate_gpg_program_path) {
        return validated;
    }

    #[cfg(windows)]
    if let Some(path) = crate::resolve_known_gpg_program_path() {
        return path.to_string_lossy().into_owned();
    }

    "gpg".to_string()
}

pub(crate) fn configured_gpg_program(repo_path: &str) -> String {
    let configured = crate::configured_git_command()
        .current_dir(repo_path)
        .args(["config", "--global", "--get", "gpg.program"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned());
    select_gpg_program(configured.as_deref())
}

/// Accepts command names and existing absolute files, but not relative paths.
pub(crate) fn validate_gpg_program_path(program: &str) -> Option<String> {
    let trimmed = program.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() || trimmed.contains('/') || trimmed.contains('\\') {
        return (path.is_absolute() && path.is_file()).then(|| trimmed.to_string());
    }
    Some(trimmed.to_string())
}
