// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Titlebar } from "./Titlebar";
import type { BranchInfo } from "../types";

function makeBranch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name: "feature/demo",
    isCurrent: true,
    isRemote: false,
    upstream: null,
    upstreamStatus: "none",
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

function renderTitlebar(branches: BranchInfo[], pushLabel = "Push") {
  render(
    <Titlebar
      platform="windows"
      native={false}
      repoPath="/repo"
      currentBranch="feature/demo"
      branches={branches}
      identityInitials="GM"
      identityAvatarUrl={null}
      recentRepos={[]}
      searchQuery=""
      searchInputRef={{ current: null }}
      onSearchChange={vi.fn()}
      onAboutClick={vi.fn()}
      onSettingsClick={vi.fn()}
      onIdentityClick={vi.fn()}
      onCloneClick={vi.fn()}
      onInitRepoClick={vi.fn()}
      onOpenExistingClick={vi.fn()}
      onRepoSelect={vi.fn()}
      onFetch={vi.fn()}
      onPull={vi.fn()}
      onPush={vi.fn()}
      pushLabel={pushLabel}
      onStash={vi.fn()}
      remoteOp={null}
      identityOpen={false}
    />,
  );
}

describe("Titlebar", () => {
  it("shows Publish when the current branch has no upstream", () => {
    renderTitlebar([makeBranch()], "Publish");
    expect(screen.getByText("Publish")).toBeInTheDocument();
  });

  it("shows Push for tracked branches", () => {
    renderTitlebar([makeBranch({ upstream: "origin/feature/demo", upstreamStatus: "tracked" })], "Push");
    expect(screen.getByText("Push")).toBeInTheDocument();
  });
});
