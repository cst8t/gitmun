import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { InterpretedGitError, PushResult } from "../types";
import { buildPushFailureDisplay, formatInterpretedGitError } from "./gitErrorDisplay";

const tGitAdvice = i18n.getFixedT("en", "gitAdvice");

function interpretedError(
  overrides: Partial<InterpretedGitError> = {},
): InterpretedGitError {
  return {
    category: "non-fast-forward",
    summary: "Push was rejected because the remote branch has new commits.",
    suggestedActions: ["fetch", "review", "integrate"],
    confidence: 0.95,
    backend: "git-cli",
    rawMessage: "! [rejected] main -> main (fetch first)",
    operation: "push",
    ...overrides,
  };
}

function pushResult(overrides: Partial<PushResult> = {}): PushResult {
  return {
    message: "Push failed",
    output: "! [rejected] main -> main (fetch first)",
    repoPath: "/repo",
    backendUsed: "git-cli",
    success: false,
    rejection: null,
    interpretedError: interpretedError(),
    ...overrides,
  };
}

describe("formatInterpretedGitError", () => {
  it("renders high-confidence summaries with localised action labels", () => {
    expect(formatInterpretedGitError(interpretedError(), tGitAdvice))
      .toBe("Push was rejected because the remote branch has new commits. Try: fetch, review Git output, integrate remote changes.");
  });

  it("uses soft generic advice for low-confidence Other errors", () => {
    expect(formatInterpretedGitError(interpretedError({
      category: "other",
      summary: "Git failed before the operation could complete.",
      suggestedActions: ["review", "retry"],
      confidence: 0.2,
    }), tGitAdvice))
      .toBe("Git failed before the operation could complete. Try: review Git output, retry.");
  });

  it("localises known interpreted summaries by category", () => {
    expect(formatInterpretedGitError(interpretedError({
      category: "unmerged-branch-delete",
      summary: "GITMUN_ERROR_UNMERGED_BRANCH_DELETE",
      suggestedActions: ["force-delete-branch"],
    }), tGitAdvice))
      .toBe("Branch is not fully merged locally. This can still happen after merging through a remote service such as GitHub pull requests or GitLab merge requests. Use Force Delete if you are sure you want to delete it. Try: force delete the branch.");
  });
});

describe("buildPushFailureDisplay", () => {
  it("does not return a toast message for dialog-handled push rejections", () => {
    const display = buildPushFailureDisplay(pushResult({
      rejection: {
        repoPath: "/repo",
        currentBranch: "main",
        upstreamBranch: "origin/main",
        kind: "non-fast-forward",
        message: "Push was rejected because the remote branch has new commits.",
        suggestedNextActions: ["fetch", "review", "integrate"],
      },
    }), tGitAdvice);

    expect(display.dialogRejection?.kind).toBe("non-fast-forward");
    expect(display.toastMessage).toBeNull();
    expect(display.logMessage).toBe("Push was rejected because the remote branch has new commits.");
    expect(display.logDetails).toContain("[rejected]");
  });

  it("uses interpreted toast text for non-dialog push failures", () => {
    const display = buildPushFailureDisplay(pushResult({
      interpretedError: interpretedError({
        category: "network",
        summary: "Git could not reach the remote.",
        suggestedActions: ["check-network", "retry"],
        rawMessage: "ssh: Could not resolve hostname example.invalid",
      }),
      rejection: {
        repoPath: "/repo",
        currentBranch: "main",
        upstreamBranch: "origin/main",
        kind: "network",
        message: "Git could not reach the remote.",
        suggestedNextActions: ["check-network", "retry"],
      },
    }), tGitAdvice);

    expect(display.dialogRejection).toBeNull();
    expect(display.toastMessage).toBe("Git could not reach the remote. Try: check the network connection, retry.");
    expect(display.logMessage).toBe("Git could not reach the remote.");
    expect(display.logDetails).toBe("ssh: Could not resolve hostname example.invalid");
  });
});
