import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { buildStashDropPrompt, getEffectiveCommitAction, shouldForceWithLeaseAfterRebase } from "./ProjectView";

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

describe("getEffectiveCommitAction", () => {
  it("forces commit when commit and push is unavailable", () => {
    expect(getEffectiveCommitAction("commitAndPush", false)).toBe("commit");
  });

  it("keeps the selected action when commit and push is available", () => {
    expect(getEffectiveCommitAction("commitAndPush", true)).toBe("commitAndPush");
  });
});

describe("shouldForceWithLeaseAfterRebase", () => {
  it("forces the next push on the rebased branch", () => {
    expect(shouldForceWithLeaseAfterRebase("main", "main")).toBe(true);
  });

  it("does not force pushes on other branches", () => {
    expect(shouldForceWithLeaseAfterRebase("main", "feature")).toBe(false);
  });

  it("does not force pushes without a completed rebase", () => {
    expect(shouldForceWithLeaseAfterRebase(null, "main")).toBe(false);
  });
});
