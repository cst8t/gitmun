import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { buildStashDropPrompt } from "./ProjectView";

const t = i18n.getFixedT("en", "projectView");

describe("buildStashDropPrompt", () => {
  it("includes the stash index and message without brace syntax", () => {
    expect(buildStashDropPrompt({ index: 3, message: "WIP on main" }, t))
      .toBe("Drop stash 3 - WIP on main? This cannot be undone.");
  });

  it("falls back to the stash index when no message is present", () => {
    expect(buildStashDropPrompt({ index: 1, message: "   " }, t))
      .toBe("Drop stash 1? This cannot be undone.");
  });
});
