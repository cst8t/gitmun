use crate::git::types::ThemeMode;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{Manager, Theme, window::Color};

const LIGHT_THEME: &str = include_str!("../themes/light.toml");
const DARK_THEME: &str = include_str!("../themes/dark.toml");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeBundle {
    pub light: ThemeDefinition,
    pub dark: ThemeDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDefinition {
    pub name: String,
    pub mode: String,
    pub background: BackgroundTokens,
    pub border: BorderTokens,
    pub text: TextTokens,
    pub accent: AccentTokens,
    pub semantic: SemanticTokens,
    pub diff: DiffTokens,
    pub shadow: ShadowTokens,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTokens {
    pub base: String,
    pub surface: String,
    pub elevated: String,
    pub hover: String,
    pub subtle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderTokens {
    pub default: String,
    pub subtle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextTokens {
    pub primary: String,
    pub secondary_strong: String,
    pub secondary: String,
    pub muted: String,
    pub on_accent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccentTokens {
    pub default: String,
    pub hover: String,
    pub dim: String,
    pub selection_bg: String,
    pub selection_border: String,
    pub focus_ring: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTokens {
    pub green: String,
    pub green_dim: String,
    pub red: String,
    pub red_dim: String,
    pub yellow: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffTokens {
    pub add_bg: String,
    pub add_text: String,
    pub add_border: String,
    pub del_bg: String,
    pub del_text: String,
    pub del_border: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowTokens {
    pub popover: String,
    pub dialog: String,
}

pub fn load_or_create_theme_bundle(app: &tauri::AppHandle) -> ThemeBundle {
    let themes_dir = themes_dir(app);
    let light = load_or_create_theme(
        &themes_dir.join("light.toml"),
        LIGHT_THEME,
        fallback_light_theme(),
        "light",
    );
    let dark = load_or_create_theme(
        &themes_dir.join("dark.toml"),
        DARK_THEME,
        fallback_dark_theme(),
        "dark",
    );
    ThemeBundle { light, dark }
}

pub fn background_colour_for_theme_mode(
    app: &tauri::AppHandle,
    theme_mode: &ThemeMode,
    system_theme: Theme,
) -> Color {
    let bundle = load_or_create_theme_bundle(app);
    let theme = match theme_mode {
        ThemeMode::Light => &bundle.light,
        ThemeMode::Dark => &bundle.dark,
        ThemeMode::System => match system_theme {
            Theme::Light => &bundle.light,
            _ => &bundle.dark,
        },
    };

    parse_hex_colour(&theme.background.base).unwrap_or(match theme.mode.as_str() {
        "light" => Color(236, 239, 243, 255),
        _ => Color(15, 17, 23, 255),
    })
}

pub fn css_variables_for_theme_name(app: &tauri::AppHandle, theme_name: &str) -> String {
    let bundle = load_or_create_theme_bundle(app);
    let theme = if theme_name == "light" {
        &bundle.light
    } else {
        &bundle.dark
    };
    css_variables(theme)
}

pub fn background_value_for_theme_name(app: &tauri::AppHandle, theme_name: &str) -> String {
    let bundle = load_or_create_theme_bundle(app);
    if theme_name == "light" {
        bundle.light.background.base
    } else {
        bundle.dark.background.base
    }
}

pub fn css_variables(theme: &ThemeDefinition) -> String {
    [
        ("--bg", &theme.background.base),
        ("--bg-surface", &theme.background.surface),
        ("--bg-elevated", &theme.background.elevated),
        ("--bg-hover", &theme.background.hover),
        ("--bg-subtle", &theme.background.subtle),
        ("--border", &theme.border.default),
        ("--border-subtle", &theme.border.subtle),
        ("--text-primary", &theme.text.primary),
        ("--text-secondary-strong", &theme.text.secondary_strong),
        ("--text-secondary", &theme.text.secondary),
        ("--text-muted", &theme.text.muted),
        ("--accent", &theme.accent.default),
        ("--accent-hover", &theme.accent.hover),
        ("--accent-dim", &theme.accent.dim),
        ("--selection-bg", &theme.accent.selection_bg),
        ("--selection-border", &theme.accent.selection_border),
        ("--focus-ring", &theme.accent.focus_ring),
        ("--text-on-accent", &theme.text.on_accent),
        ("--green", &theme.semantic.green),
        ("--green-dim", &theme.semantic.green_dim),
        ("--red", &theme.semantic.red),
        ("--red-dim", &theme.semantic.red_dim),
        ("--yellow", &theme.semantic.yellow),
        ("--diff-add-bg", &theme.diff.add_bg),
        ("--diff-add-text", &theme.diff.add_text),
        ("--diff-add-border", &theme.diff.add_border),
        ("--diff-del-bg", &theme.diff.del_bg),
        ("--diff-del-text", &theme.diff.del_text),
        ("--diff-del-border", &theme.diff.del_border),
        ("--shadow-popover", &theme.shadow.popover),
        ("--shadow-dialog", &theme.shadow.dialog),
    ]
    .into_iter()
    .map(|(key, value)| format!("{key}:{value};"))
    .collect::<Vec<_>>()
    .join("")
}

fn themes_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("gitmun"))
        .join("themes")
}

fn load_or_create_theme(
    path: &Path,
    bundled: &str,
    fallback: ThemeDefinition,
    expected_mode: &str,
) -> ThemeDefinition {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, bundled);
        return fallback;
    }

    match std::fs::read_to_string(path) {
        Ok(contents) => match parse_theme(&contents, expected_mode) {
            Ok(theme) => theme,
            Err(error) => {
                eprintln!(
                    "Failed to load theme {}: {error}. Using built-in fallback.",
                    path.display()
                );
                fallback
            }
        },
        Err(error) => {
            eprintln!(
                "Failed to read theme {}: {error}. Using built-in fallback.",
                path.display()
            );
            fallback
        }
    }
}

fn parse_theme(contents: &str, expected_mode: &str) -> Result<ThemeDefinition, String> {
    let theme: ThemeDefinition = toml::from_str(contents).map_err(|e| e.to_string())?;
    validate_theme(&theme, expected_mode)?;
    Ok(theme)
}

fn fallback_light_theme() -> ThemeDefinition {
    toml::from_str(LIGHT_THEME).expect("bundled light theme must be valid")
}

fn fallback_dark_theme() -> ThemeDefinition {
    toml::from_str(DARK_THEME).expect("bundled dark theme must be valid")
}

fn validate_theme(theme: &ThemeDefinition, expected_mode: &str) -> Result<(), String> {
    if theme.mode != expected_mode {
        return Err(format!("Theme mode must be {expected_mode}"));
    }

    for value in [
        &theme.background.base,
        &theme.background.surface,
        &theme.background.elevated,
        &theme.background.hover,
        &theme.background.subtle,
        &theme.border.default,
        &theme.border.subtle,
        &theme.text.primary,
        &theme.text.secondary_strong,
        &theme.text.secondary,
        &theme.text.muted,
        &theme.text.on_accent,
        &theme.accent.default,
        &theme.accent.hover,
        &theme.accent.dim,
        &theme.accent.selection_bg,
        &theme.accent.selection_border,
        &theme.accent.focus_ring,
        &theme.semantic.green,
        &theme.semantic.green_dim,
        &theme.semantic.red,
        &theme.semantic.red_dim,
        &theme.semantic.yellow,
        &theme.diff.add_bg,
        &theme.diff.add_text,
        &theme.diff.add_border,
        &theme.diff.del_bg,
        &theme.diff.del_text,
        &theme.diff.del_border,
    ] {
        if !is_css_colour(value) {
            return Err(format!("Invalid colour value: {value}"));
        }
    }

    for value in [&theme.shadow.popover, &theme.shadow.dialog] {
        if !is_css_shadow(value) {
            return Err(format!("Invalid shadow value: {value}"));
        }
    }

    Ok(())
}

fn is_css_colour(value: &str) -> bool {
    let trimmed = value.trim();
    is_hex_colour(trimmed) || is_rgb_colour(trimmed, "rgb") || is_rgb_colour(trimmed, "rgba")
}

fn is_hex_colour(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_rgb_colour(value: &str, function_name: &str) -> bool {
    let prefix = format!("{function_name}(");
    let Some(args) = value
        .strip_prefix(&prefix)
        .and_then(|value| value.strip_suffix(')'))
    else {
        return false;
    };

    let parts = args.split(',').map(|part| part.trim()).collect::<Vec<_>>();
    let expected_len = if function_name == "rgba" { 4 } else { 3 };
    if parts.len() != expected_len {
        return false;
    }

    let colour_channels_valid = parts.iter().take(3).all(|part| part.parse::<u8>().is_ok());
    if !colour_channels_valid {
        return false;
    }

    if function_name == "rgba" {
        parts[3]
            .parse::<f32>()
            .is_ok_and(|alpha| (0.0..=1.0).contains(&alpha))
    } else {
        true
    }
}

fn is_css_shadow(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && !trimmed.contains(';')
        && !trimmed.contains('{')
        && !trimmed.contains('}')
        && !trimmed.contains('"')
        && !trimmed.contains('\'')
        && trimmed.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || c.is_ascii_whitespace()
                || matches!(c, '#' | '(' | ')' | ',' | '.' | '%' | '-')
        })
}

fn parse_hex_colour(value: &str) -> Option<Color> {
    let hex = value.trim().strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }

    let red = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let green = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let blue = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some(Color(red, green, blue, 255))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_themes_are_valid() {
        parse_theme(LIGHT_THEME, "light").unwrap();
        parse_theme(DARK_THEME, "dark").unwrap();
    }

    #[test]
    fn rejects_css_injection_in_colour() {
        let mut theme = fallback_light_theme();
        theme.background.base = "red; display: none".to_string();
        assert!(validate_theme(&theme, "light").is_err());
    }

    #[test]
    fn rejects_css_injection_in_shadow() {
        let mut theme = fallback_light_theme();
        theme.shadow.dialog = "0 0 0 red; display:none".to_string();
        assert!(validate_theme(&theme, "light").is_err());
    }
}
