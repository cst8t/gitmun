use std::path::Path;

use crate::git::types::Settings;

const TEMPLATE: &str = include_str!("../config.example.toml");

/// Load settings from config.toml, migrating from config.json if needed.
///
/// Returns `(Settings, should_persist)`. `should_persist` is `true` when
/// config.toml needs to be written (first launch or failed migration).
pub fn load_or_migrate(toml_path: &Path, json_path: &Path) -> (Settings, bool) {
    if toml_path.exists() {
        match std::fs::read_to_string(toml_path) {
            Ok(text) => match toml::from_str::<Settings>(&text) {
                Ok(settings) => return (settings, false),
                Err(_) => {
                    // Malformed TOML - use defaults but don't overwrite the file.
                }
            },
            Err(_) => {}
        }
        return (Settings::default(), false);
    }

    if json_path.exists() {
        let settings = std::fs::read_to_string(json_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .unwrap_or_default();

        let created = create_from_template(toml_path, &settings).is_ok();
        return (settings, !created);
    }

    let settings = Settings::default();
    let created = create_from_template(toml_path, &settings).is_ok();
    (settings, !created)
}

/// Create config.toml from the template with the given settings values.
pub fn create_from_template(toml_path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = toml_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut doc: toml_edit::DocumentMut = TEMPLATE
        .parse()
        .map_err(|e| format!("Failed to parse template: {e}"))?;

    apply_settings_to_doc(&mut doc, settings);
    std::fs::write(toml_path, doc.to_string()).map_err(|e| e.to_string())
}

/// Update an existing config.toml with current settings while preserving
/// comments. If the file does not exist, creates it from the template.
pub fn persist(toml_path: &Path, settings: &Settings) -> Result<(), String> {
    if !toml_path.exists() {
        return create_from_template(toml_path, settings);
    }

    let text = std::fs::read_to_string(toml_path).map_err(|e| e.to_string())?;
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e| format!("Failed to parse config.toml: {e}"))?;

    apply_settings_to_doc(&mut doc, settings);

    if let Some(parent) = toml_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(toml_path, doc.to_string()).map_err(|e| e.to_string())
}

/// Apply `Settings` values to a `toml_edit::DocumentMut`, preserving existing
/// comments and inserting missing keys from the template with their comments.
fn apply_settings_to_doc(doc: &mut toml_edit::DocumentMut, settings: &Settings) {
    let fresh_toml = toml::to_string_pretty(settings).unwrap_or_default();
    let Ok(fresh_doc) = fresh_toml.parse::<toml_edit::DocumentMut>() else {
        return;
    };
    let Ok(template_doc) = TEMPLATE.parse::<toml_edit::DocumentMut>() else {
        return;
    };

    let table = doc.as_table_mut();
    let fresh_table = fresh_doc.as_table();
    let template_table = template_doc.as_table();

    for (key, fresh_item) in fresh_table.iter() {
        let Some(new_val) = fresh_item.as_value() else {
            continue;
        };

        if let Some((_keymut, item)) = table.get_key_value_mut(key) {
            if let Some(v) = item.as_value_mut() {
                *v = new_val.clone();
            } else {
                *item = toml_edit::value(new_val.clone());
            }
            continue;
        }

        if let Some((template_key, template_item)) = template_table.get_key_value(key) {
            let mut new_item = template_item.clone();
            if let Some(v) = new_item.as_value_mut() {
                *v = new_val.clone();
            }
            table.insert_formatted(template_key, new_item);
        } else {
            table.insert(key, toml_edit::value(new_val.clone()));
        }
    }
}

/// Read the `linuxGraphicsMode` value from a TOML config file.
/// Used before Tauri starts to apply WebKit workarounds on Linux.
pub fn read_linux_graphics_mode_from_toml(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: toml::Value = toml::from_str(&text).ok()?;
    value
        .get("linuxGraphicsMode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(path: &Path, contents: &str) {
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn load_toml_populates_settings() {
        let dir = TempDir::new().unwrap();
        let toml_path = dir.path().join("config.toml");
        let json_path = dir.path().join("config.json");

        let contents = "backendMode = \"GitCliOnly\"\nshowResultLog = true\nthemeMode = \"Dark\"\nleftPaneWidth = 300\nrightPaneWidth = 420\n";
        write_file(&toml_path, contents);

        let (settings, should_persist) = load_or_migrate(&toml_path, &json_path);
        assert!(!should_persist);
        assert_eq!(
            settings.backend_mode,
            crate::git::types::BackendMode::GitCliOnly
        );
        assert!(settings.show_result_log);
        assert_eq!(settings.theme_mode, crate::git::types::ThemeMode::Dark);
    }

    #[test]
    fn load_toml_uses_defaults_for_missing_keys() {
        let dir = TempDir::new().unwrap();
        let toml_path = dir.path().join("config.toml");
        let json_path = dir.path().join("config.json");

        write_file(&toml_path, "showResultLog = true\n");

        let (settings, should_persist) = load_or_migrate(&toml_path, &json_path);
        assert!(!should_persist);
        assert!(settings.show_result_log);
        assert_eq!(
            settings.backend_mode,
            crate::git::types::BackendMode::Default
        );
        assert_eq!(settings.left_pane_width, 300);
        assert_eq!(settings.right_pane_width, 420);
    }

    #[test]
    fn malformed_toml_uses_defaults_and_does_not_overwrite() {
        let dir = TempDir::new().unwrap();
        let toml_path = dir.path().join("config.toml");
        let json_path = dir.path().join("config.json");

        let original = "# user's carefully edited file\nbroken = [\n";
        write_file(&toml_path, original);

        let (settings, should_persist) = load_or_migrate(&toml_path, &json_path);
        assert!(!should_persist);

        assert_eq!(
            settings.backend_mode,
            crate::git::types::BackendMode::Default
        );
        assert!(!settings.show_result_log);

        let after = std::fs::read_to_string(&toml_path).unwrap();
        assert_eq!(after, original);
    }

    #[test]
    fn json_migration_creates_toml() {
        let dir = TempDir::new().unwrap();
        let toml_path = dir.path().join("config.toml");
        let json_path = dir.path().join("config.json");

        write_file(
            &json_path,
            r#"{"backendMode": "GitCliOnly", "showResultLog": true, "themeMode": "System", "leftPaneWidth": 300, "rightPaneWidth": 420}"#,
        );

        let (settings, _) = load_or_migrate(&toml_path, &json_path);
        assert_eq!(
            settings.backend_mode,
            crate::git::types::BackendMode::GitCliOnly
        );
        assert!(settings.show_result_log);

        let toml_text = std::fs::read_to_string(&toml_path).unwrap();
        assert!(toml_text.contains("# Backend used for Git operations"));
        assert!(toml_text.contains("backendMode = \"GitCliOnly\""));
        assert!(toml_text.contains("# Whether to show the result log"));
        assert!(toml_text.contains("showResultLog = true"));
    }

    #[test]
    fn fresh_install_creates_toml_with_defaults() {
        let dir = TempDir::new().unwrap();
        let toml_path = dir.path().join("config.toml");
        let json_path = dir.path().join("config.json");

        let (settings, _) = load_or_migrate(&toml_path, &json_path);
        assert_eq!(
            settings.backend_mode,
            crate::git::types::BackendMode::Default
        );

        let toml_text = std::fs::read_to_string(&toml_path).unwrap();
        assert!(toml_text.contains("# Backend used for Git operations"));
        assert!(toml_text.contains("backendMode = \"Default\""));
    }

    #[test]
    fn persist_preserves_user_comments() {
        let dir = TempDir::new().unwrap();
        let toml_path = dir.path().join("config.toml");

        let original = "# my custom comment above\nbackendMode = \"Default\"\n# another comment\nshowResultLog = false\n";
        write_file(&toml_path, original);

        let mut settings = Settings::default();
        settings.show_result_log = true;

        persist(&toml_path, &settings).unwrap();

        let updated = std::fs::read_to_string(&toml_path).unwrap();
        assert!(
            updated.contains("# my custom comment above"),
            "custom comment preserved"
        );
        assert!(
            updated.contains("# another comment"),
            "other comment preserved"
        );
        assert!(updated.contains("showResultLog = true"), "value updated");
    }

    #[test]
    fn persist_adds_missing_template_key_with_comment() {
        let dir = TempDir::new().unwrap();
        let toml_path = dir.path().join("config.toml");

        write_file(
            &toml_path,
            "backendMode = \"Default\"\nshowResultLog = false\n",
        );

        persist(&toml_path, &Settings::default()).unwrap();

        let updated = std::fs::read_to_string(&toml_path).unwrap();
        assert!(
            updated.contains("backendMode = \"Default\""),
            "existing key kept its original format"
        );
        assert!(
            updated.contains("showResultLog = false"),
            "existing key kept its original format"
        );
        assert!(
            updated.contains("# UI theme mode"),
            "missing key gained its template comment"
        );
        assert!(updated.contains("themeMode = \"System\""));
        assert!(
            updated.contains("# Graphics mode for Linux"),
            "missing key gained its template comment"
        );
        assert!(updated.contains("linuxGraphicsMode = \"Auto\""));
    }
}
