import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { BranchInfo, OperationResult } from "../types";
import {
  buildPushRequestForCurrentBranch,
  buildStashDropPrompt,
  getEffectiveCommitAction,
  importPatchWithRecovery,
  isPatchConflictResult,
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

function operationResult(message: string): OperationResult {
  return {
    message,
    backendUsed: "git-cli",
    output: null,
    repoPath: "/repo",
  };
}

function patchImportDeps(overrides: Partial<Parameters<typeof importPatchWithRecovery>[2]> = {}) {
  return {
    checkPatchFile: vi.fn(async () => operationResult("Patch file can be applied")),
    importPatchFile: vi.fn(async () => operationResult("Applied patch file")),
    confirmThreeWayApply: vi.fn(async () => false),
    formatFailureMessage: (message: string) => `Import patch failed: ${message}`,
    formatResultMessage: (message: string) => message,
    appendLog: vi.fn(),
    onApplied: vi.fn(async () => {}),
    onConflicts: vi.fn(async () => {}),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("importPatchWithRecovery", () => {
  it("keeps the normal import success path unchanged", async () => {
    const deps = patchImportDeps();

    const outcome = await importPatchWithRecovery("/repo", "/tmp/change.patch", deps);

    expect(outcome).toBe("applied");
    expect(deps.checkPatchFile).toHaveBeenCalledWith({ repoPath: "/repo", patchPath: "/tmp/change.patch" });
    expect(deps.importPatchFile).toHaveBeenCalledWith({ repoPath: "/repo", patchPath: "/tmp/change.patch" });
    expect(deps.confirmThreeWayApply).not.toHaveBeenCalled();
    expect(deps.onApplied).toHaveBeenCalledWith(operationResult("Applied patch file"));
    expect(deps.appendLog).toHaveBeenCalledWith("success", "Applied patch file", "git-cli");
  });

  it("prompts for 3-way retry after normal apply failure", async () => {
    const deps = patchImportDeps({
      checkPatchFile: vi.fn(async () => {
        throw new Error("patch does not apply");
      }),
    });

    const outcome = await importPatchWithRecovery("/repo", "/tmp/change.patch", deps);

    expect(outcome).toBe("cancelled");
    expect(deps.confirmThreeWayApply).toHaveBeenCalledWith("Error: patch does not apply");
    expect(deps.importPatchFile).not.toHaveBeenCalled();
    expect(deps.appendLog).toHaveBeenCalledWith(
      "error",
      "Import patch failed: Error: patch does not apply",
      "unknown",
    );
  });

  it("retries with the 3-way flag when the user confirms", async () => {
    const deps = patchImportDeps({
      checkPatchFile: vi.fn(async () => {
        throw new Error("patch does not apply");
      }),
      confirmThreeWayApply: vi.fn(async () => true),
    });

    const outcome = await importPatchWithRecovery("/repo", "/tmp/change.patch", deps);

    expect(outcome).toBe("applied");
    expect(deps.importPatchFile).toHaveBeenCalledWith({
      repoPath: "/repo",
      patchPath: "/tmp/change.patch",
      threeWay: true,
    });
    expect(deps.onApplied).toHaveBeenCalledWith(operationResult("Applied patch file"));
  });

  it("routes 3-way conflict results to the conflict workflow", async () => {
    const conflictResult = operationResult("GITMUN_PATCH_IMPORT_CONFLICTS");
    const deps = patchImportDeps({
      checkPatchFile: vi.fn(async () => {
        throw new Error("patch does not apply");
      }),
      confirmThreeWayApply: vi.fn(async () => true),
      importPatchFile: vi.fn(async () => conflictResult),
    });

    const outcome = await importPatchWithRecovery("/repo", "/tmp/change.patch", deps);

    expect(outcome).toBe("conflicts");
    expect(deps.onConflicts).toHaveBeenCalledWith(conflictResult);
    expect(deps.onApplied).not.toHaveBeenCalled();
    expect(deps.appendLog).toHaveBeenLastCalledWith("info", conflictResult.message, "git-cli");
  });
});

describe("isPatchConflictResult", () => {
  it("detects patch conflict operation results", () => {
    expect(isPatchConflictResult(operationResult("GITMUN_PATCH_IMPORT_CONFLICTS"))).toBe(true);
    expect(isPatchConflictResult(operationResult("Applied patch file"))).toBe(false);
  });
});
