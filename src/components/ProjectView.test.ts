import { describe, expect, it } from "vitest";
import { buildStashDropPrompt } from "./ProjectView";

describe("buildStashDropPrompt", () => {
  it("includes the stash index and message without brace syntax", () => {
    expect(buildStashDropPrompt({ index: 3, message: "WIP on main" }))
      .toBe("Drop stash 3 - WIP on main? This cannot be undone.");
  });

  it("falls back to the stash index when no message is present", () => {
    expect(buildStashDropPrompt({ index: 1, message: "   " }))
      .toBe("Drop stash 1? This cannot be undone.");
  });
});
