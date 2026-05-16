import { invoke } from "@tauri-apps/api/core";
import type { ThemeBundle, ThemeDefinition, ThemeMode } from "../types";

export type ResolvedTheme = "light" | "dark";

const DEFAULT_UI_FONT = "'Inter', sans-serif";
const DEFAULT_MONO_FONT = "'JetBrains Mono', monospace";

export async function resolveThemeMode(mode: ThemeMode): Promise<ResolvedTheme> {
    if (mode === "Light") return "light";
    if (mode === "Dark") return "dark";
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    try {
        const hint = await invoke<string>("get_system_theme_hint");
        return hint === "dark" ? "dark" : "light";
    } catch {
        return "dark";
    }
}

export async function applyThemeMode(mode: ThemeMode): Promise<ResolvedTheme> {
    const resolved = await resolveThemeMode(mode);
    try {
        const bundle = await invoke<ThemeBundle>("get_theme_bundle");
        applyThemeDefinition(resolved === "light" ? bundle.light : bundle.dark);
    } catch {
        // tokens.css carries built-in fallback values.
    }
    document.documentElement.dataset.theme = resolved;
    return resolved;
}

function applyThemeDefinition(theme: ThemeDefinition) {
    const root = document.documentElement;
    const values: Array<[string, string]> = [
        ["--font-ui", resolveThemeValue(theme.font.uiFamily, DEFAULT_UI_FONT)],
        ["--font-mono", resolveThemeValue(theme.font.monoFamily, DEFAULT_MONO_FONT)],
        ["--font-weight-regular", resolveThemeValue(theme.font.regularWeight, "400")],
        ["--font-weight-medium", resolveThemeValue(theme.font.mediumWeight, "500")],
        ["--font-weight-semibold", resolveThemeValue(theme.font.semiboldWeight, "600")],
        ["--font-weight-bold", resolveThemeValue(theme.font.boldWeight, "700")],
        ["--bg", theme.background.base],
        ["--bg-surface", theme.background.surface],
        ["--bg-elevated", theme.background.elevated],
        ["--bg-hover", theme.background.hover],
        ["--bg-subtle", theme.background.subtle],
        ["--row-alternate-bg", theme.background.rowAlternate],
        ["--row-alternate-strong-bg", theme.background.rowAlternateStrong],
        ["--border", theme.border.default],
        ["--border-subtle", theme.border.subtle],
        ["--text-primary", theme.text.primary],
        ["--text-secondary-strong", theme.text.secondaryStrong],
        ["--text-secondary", theme.text.secondary],
        ["--text-muted", theme.text.muted],
        ["--accent", theme.accent.default],
        ["--accent-hover", theme.accent.hover],
        ["--accent-dim", theme.accent.dim],
        ["--selection-bg", theme.accent.selectionBg],
        ["--selection-border", theme.accent.selectionBorder],
        ["--focus-ring", theme.accent.focusRing],
        ["--text-on-accent", theme.text.onAccent],
        ["--green", theme.semantic.green],
        ["--green-dim", theme.semantic.greenDim],
        ["--red", theme.semantic.red],
        ["--red-dim", theme.semantic.redDim],
        ["--yellow", theme.semantic.yellow],
        ["--diff-add-bg", theme.diff.addBg],
        ["--diff-add-text", theme.diff.addText],
        ["--diff-add-border", theme.diff.addBorder],
        ["--diff-del-bg", theme.diff.delBg],
        ["--diff-del-text", theme.diff.delText],
        ["--diff-del-border", theme.diff.delBorder],
        ["--shadow-popover", theme.shadow.popover],
        ["--shadow-dialog", theme.shadow.dialog],
    ];

    for (const [key, value] of values) {
        root.style.setProperty(key, value);
    }
}

function resolveThemeValue(value: string, defaultValue: string): string {
    return value.trim() === "default" ? defaultValue : value;
}
