// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyUiTextScale, normaliseUiTextScale } from "./uiTextScale";

describe("uiTextScale", () => {
  it("normalises supported numeric values", () => {
    expect(normaliseUiTextScale(0.9)).toBe(0.9);
    expect(normaliseUiTextScale("1.2")).toBe(1.2);
  });

  it("falls back to default for unsupported values", () => {
    expect(normaliseUiTextScale(1.25)).toBe(1);
    expect(normaliseUiTextScale("large")).toBe(1);
    expect(normaliseUiTextScale(null)).toBe(1);
  });

  it("applies the CSS variable to the root element", () => {
    const root = document.createElement("div");

    expect(applyUiTextScale(1.3, root)).toBe(1.3);
    expect(root.style.getPropertyValue("--text-scale")).toBe("1.3");

    expect(applyUiTextScale("bad", root)).toBe(1);
    expect(root.style.getPropertyValue("--text-scale")).toBe("1");
  });
});
