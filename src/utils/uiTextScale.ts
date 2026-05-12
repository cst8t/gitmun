import type { UiTextScale } from "../types";

export const UI_TEXT_SCALE_VALUES = [0.9, 1, 1.1, 1.2, 1.3] as const satisfies readonly UiTextScale[];

export function normaliseUiTextScale(value: unknown): UiTextScale {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;

  return UI_TEXT_SCALE_VALUES.find(scale => scale === numeric) ?? 1;
}

export function applyUiTextScale(value: unknown, root: HTMLElement = document.documentElement): UiTextScale {
  const scale = normaliseUiTextScale(value);
  root.style.setProperty("--text-scale", String(scale));
  return scale;
}
