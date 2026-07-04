import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { BranchInfo } from "../types";
import {
  buildPushRequestForCurrentBranch,
  buildStashDropPrompt,
  getEffectiveCommitAction,
  shouldForceWithLeaseAfterRebase,
} from "./ProjectView";

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

describe("buildPushRequestForCurrentBranch", () => {
  const trackedBranch: BranchInfo = {
    name: "0.8.2-develop",
    isCurrent: true,
    isRemote: false,
    upstream: "origin/0.9.0-develop",
    upstreamStatus: "tracked",
    ahead: 2,
    behind: 0,
  };

  it("pushes explicitly to the tracked upstream branch", () => {
    expect(buildPushRequestForCurrentBranch("/repo", trackedBranch, false, true)).toEqual({
      repoPath: "/repo",
      forceWithLease: false,
      pushFollowTags: true,
      remote: "origin",
      remoteBranch: "0.9.0-develop",
    });
  });

  it("falls back to the default push when the upstream is not parseable", () => {
    expect(buildPushRequestForCurrentBranch(
      "/repo",
      { ...trackedBranch, upstream: "upstream-without-branch" },
      true,
      false,
    )).toEqual({
      repoPath: "/repo",
      forceWithLease: true,
      pushFollowTags: false,
    });
  });
});
