// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Titlebar } from "./Titlebar";
import type { BranchInfo } from "../types";
import "../i18n";

vi.mock("../api/commands", () => ({
  getRepoOpenLocations: vi.fn(async () => [
    { kind: "fileExplorer", label: "Explorer App", fallbackLabel: "File Manager", iconDataUrl: null },
    { kind: "terminal", label: "Terminal App", fallbackLabel: "Terminal", iconDataUrl: null },
    { kind: "gitBash", label: "Git Bash", fallbackLabel: "Git Bash", iconDataUrl: null },
  ]),
}));

import * as api from "../api/commands";

const writeText = vi.fn(async () => {});

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

function renderTitlebar(
  branches: BranchInfo[],
  pushLabel = "Push",
  repoPath: string | null = "/repo",
  onOpenRepoLocation = vi.fn(),
  patchHandlers: {
    onImportPatch?: () => void;
    onExportPatch?: (scope: "staged" | "unstaged" | "all" | "selected") => void;
    selectedPatchExportEnabled?: boolean;
    onReset?: (mode: "mixed" | "hard") => void;
    currentBranch?: string;
    repoDisplayName?: string | null;
  } = {},
) {
  const onImportPatch = patchHandlers.onImportPatch ?? vi.fn();
  const onExportPatch = patchHandlers.onExportPatch ?? vi.fn();
  render(
    <Titlebar
      platform="windows"
      native={false}
      repoPath={repoPath}
      repoDisplayName={patchHandlers.repoDisplayName ?? null}
      currentBranch={repoPath ? patchHandlers.currentBranch ?? "feature/demo" : null}
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
      onOpenRepoLocation={onOpenRepoLocation}
      onFetch={vi.fn()}
      onPull={vi.fn()}
      onPush={vi.fn()}
      pushLabel={pushLabel}
      onStash={vi.fn()}
      onReset={patchHandlers.onReset ?? vi.fn()}
      onImportPatch={onImportPatch}
      onExportPatch={onExportPatch}
      selectedPatchExportEnabled={patchHandlers.selectedPatchExportEnabled ?? false}
      remoteOp={null}
      identityOpen={false}
    />,
  );
}

function setRenderedWidth(element: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: clientWidth });
}

describe("Titlebar", () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(api.getRepoOpenLocations).mockResolvedValue([
      { kind: "fileExplorer", label: "Explorer App", fallbackLabel: "File Manager", iconDataUrl: null },
      { kind: "terminal", label: "Terminal App", fallbackLabel: "Terminal", iconDataUrl: null },
      { kind: "gitBash", label: "Git Bash", fallbackLabel: "Git Bash", iconDataUrl: null },
    ]);
  });

  it("shows Publish when the current branch has no upstream", () => {
    renderTitlebar([makeBranch()], "Publish");
    expect(screen.getByText("Publish")).toBeInTheDocument();
  });

  it("shows Push for tracked branches", () => {
    renderTitlebar([makeBranch({ upstream: "origin/feature/demo", upstreamStatus: "tracked" })], "Push");
    expect(screen.getByText("Push")).toBeInTheDocument();
  });

  it("shows a disclosure with the full branch name when the branch label is truncated", () => {
    const longBranch = "feature/this-is-a-very-long-branch-name-that-should-not-crowd-toolbar-actions";
    renderTitlebar([makeBranch({ name: longBranch })], "Push", "/repo", vi.fn(), { currentBranch: longBranch });

    const branchName = screen.getByText(longBranch);
    setRenderedWidth(branchName, 320, 120);
    fireEvent.mouseEnter(branchName.closest(".titlebar__branch-pill")!);

    const disclosure = screen.getByRole("tooltip");
    expect(within(disclosure).getByText("Branch")).toBeInTheDocument();
    expect(within(disclosure).getByText(longBranch)).toBeInTheDocument();
  });

  it("does not show a redundant branch disclosure when the branch label fits", () => {
    renderTitlebar([makeBranch()]);

    const branchName = screen.getByText("feature/demo");
    setRenderedWidth(branchName, 100, 120);
    fireEvent.mouseEnter(branchName.closest(".titlebar__branch-pill")!);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("copies the repository path from the titlebar", async () => {
    renderTitlebar([makeBranch()], "Push", "/home/conor/GitmunProjects/gitmun");

    expect(screen.getByText("gitmun")).toBeInTheDocument();
    expect(screen.queryByText("/home/conor/GitmunProjects/")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Copy repository path"));

    expect(writeText).toHaveBeenCalledWith("/home/conor/GitmunProjects/gitmun");
    await screen.findByText("Copied");
  });

  it("shows the full project name and repository path when the project label is truncated", () => {
    const projectName = "Project Atlas With A Long Display Name";
    renderTitlebar([makeBranch()], "Push", "/home/conor/GitmunProjects/gitmun", vi.fn(), {
      repoDisplayName: projectName,
    });

    const repoName = screen.getByText(projectName);
    setRenderedWidth(repoName, 320, 120);
    fireEvent.mouseEnter(screen.getByLabelText("Copy repository path"));

    const disclosure = screen.getByRole("tooltip");
    expect(within(disclosure).getByText("Project")).toBeInTheDocument();
    expect(within(disclosure).getByText(projectName)).toBeInTheDocument();
    expect(within(disclosure).getByText("Repository path")).toBeInTheDocument();
    expect(within(disclosure).getByText("/home/conor/GitmunProjects/gitmun")).toBeInTheDocument();
  });

  it("keeps the project copy affordance without repeating the project name when the label fits", () => {
    renderTitlebar([makeBranch()], "Push", "/home/conor/GitmunProjects/gitmun", vi.fn(), {
      repoDisplayName: "Project Atlas",
    });

    const repoName = screen.getByText("Project Atlas");
    setRenderedWidth(repoName, 100, 140);
    fireEvent.mouseEnter(screen.getByLabelText("Copy repository path"));

    const disclosure = screen.getByRole("tooltip");
    expect(within(disclosure).queryByText("Project")).not.toBeInTheDocument();
    expect(within(disclosure).queryByText("Project Atlas")).not.toBeInTheDocument();
    expect(within(disclosure).queryByText("Repository path")).not.toBeInTheDocument();
    expect(within(disclosure).queryByText("/home/conor/GitmunProjects/gitmun")).not.toBeInTheDocument();
    expect(within(disclosure).getByText("Click to copy path")).toBeInTheDocument();
  });

  it("hides the project copy hint when showing copied feedback", async () => {
    renderTitlebar([makeBranch()], "Push", "/home/conor/GitmunProjects/gitmun");

    const repoName = screen.getByText("gitmun");
    setRenderedWidth(repoName, 60, 100);
    const repoButton = screen.getByLabelText("Copy repository path");

    fireEvent.mouseEnter(repoButton);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Click to copy path");

    fireEvent.click(repoButton);

    await screen.findByText("Copied");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the repository display name when one is set", async () => {
    renderTitlebar([makeBranch()], "Push", "/home/conor/GitmunProjects/gitmun", vi.fn(), {
      repoDisplayName: "Project Atlas",
    });

    expect(screen.getByText("Project Atlas")).toBeInTheDocument();
    expect(screen.queryByText("gitmun")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Copy repository path"));

    expect(writeText).toHaveBeenCalledWith("/home/conor/GitmunProjects/gitmun");
  });

  it("shows copied feedback after copying the repository path", async () => {
    renderTitlebar([makeBranch()], "Push", "/home/conor/GitmunProjects/gitmun");

    fireEvent.click(screen.getByLabelText("Copy repository path"));

    await waitFor(() => {
      expect(screen.getByText("Copied")).toHaveClass("titlebar__repo-copied--visible");
    });
  });

  it("disables Open in when no repository is open", () => {
    renderTitlebar([], "Push", null);

    const button = screen.getByText("Open in...").closest(".titlebar__icon-btn");
    expect(button).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByText("Open in..."));
    expect(screen.queryByText("Explorer App")).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal App")).not.toBeInTheDocument();
  });

  it("shows file manager and terminal entries when a repository is open", async () => {
    renderTitlebar([makeBranch()]);

    fireEvent.click(screen.getByText("Open in..."));

    expect(await screen.findByText("Explorer App")).toBeInTheDocument();
    expect(screen.getByText("Terminal App")).toBeInTheDocument();
    expect(screen.getByText("Git Bash")).toBeInTheDocument();
  });

  it("calls the open handler with the selected location", async () => {
    const onOpenRepoLocation = vi.fn();
    renderTitlebar([makeBranch()], "Push", "/repo", onOpenRepoLocation);

    fireEvent.click(screen.getByText("Open in..."));
    fireEvent.click(await screen.findByText("Explorer App"));
    expect(onOpenRepoLocation).toHaveBeenCalledWith("fileExplorer");

    fireEvent.click(screen.getByText("Open in..."));
    fireEvent.click(await screen.findByText("Terminal App"));
    expect(onOpenRepoLocation).toHaveBeenCalledWith("terminal");

    fireEvent.click(screen.getByText("Open in..."));
    fireEvent.click(await screen.findByText("Git Bash"));
    expect(onOpenRepoLocation).toHaveBeenCalledWith("gitBash");
  });

  it("renders fallback labels when native labels are empty", async () => {
    vi.mocked(api.getRepoOpenLocations).mockResolvedValue([
      { kind: "fileExplorer", label: "", fallbackLabel: "File Manager", iconDataUrl: null },
      { kind: "terminal", label: "", fallbackLabel: "Terminal", iconDataUrl: null },
      { kind: "gitBash", label: "", fallbackLabel: "Git Bash", iconDataUrl: null },
    ]);

    renderTitlebar([makeBranch()]);
    fireEvent.click(screen.getByText("Open in..."));

    await waitFor(() => {
      expect(screen.getByText("File Manager")).toBeInTheDocument();
      expect(screen.getByText("Terminal")).toBeInTheDocument();
      expect(screen.getByText("Git Bash")).toBeInTheDocument();
    });
  });

  it("shows patch file actions when a repository is open", () => {
    renderTitlebar([makeBranch()]);

    fireEvent.click(screen.getByText("More"));

    expect(screen.getByText("Patch files")).toBeInTheDocument();
    expect(screen.getByText("Import patch...")).toBeInTheDocument();
    expect(screen.getByText("Export patch")).toBeInTheDocument();
    expect(screen.getByText("Export staged patch...")).toBeInTheDocument();
    expect(screen.getByText("Export unstaged patch...")).toBeInTheDocument();
    expect(screen.getByText("Export all changes patch...")).toBeInTheDocument();
  });

  it("shows reset actions when a repository is open", () => {
    renderTitlebar([makeBranch()]);

    fireEvent.click(screen.getByText("More"));

    expect(screen.getByText("Reset")).toBeInTheDocument();
    expect(screen.getByText("Unstage all changes...")).toBeInTheDocument();
    expect(screen.getByText("Discard tracked changes...")).toBeInTheDocument();
  });

  it("calls reset with mixed mode from the more menu", () => {
    const onReset = vi.fn();
    renderTitlebar([makeBranch()], "Push", "/repo", vi.fn(), { onReset });

    fireEvent.click(screen.getByText("More"));
    fireEvent.click(screen.getByText("Unstage all changes..."));

    expect(onReset).toHaveBeenCalledWith("mixed");
  });

  it("calls reset with hard mode from the more menu", () => {
    const onReset = vi.fn();
    renderTitlebar([makeBranch()], "Push", "/repo", vi.fn(), { onReset });

    fireEvent.click(screen.getByText("More"));
    fireEvent.click(screen.getByText("Discard tracked changes..."));

    expect(onReset).toHaveBeenCalledWith("hard");
  });

  it("does not show reset actions when no repository is open", () => {
    renderTitlebar([], "Push", null);

    fireEvent.click(screen.getByText("More"));

    expect(screen.queryByText("Reset")).not.toBeInTheDocument();
    expect(screen.queryByText("Unstage all changes...")).not.toBeInTheDocument();
    expect(screen.queryByText("Discard tracked changes...")).not.toBeInTheDocument();
  });

  it("disables selected patch export until files are checked", () => {
    renderTitlebar([makeBranch()]);

    fireEvent.click(screen.getByText("More"));

    expect(screen.getByText("Export selected patch...").closest(".titlebar__open-menu-item"))
      .toHaveAttribute("aria-disabled", "true");
  });

  it("enables selected patch export when files are checked", () => {
    const onExportPatch = vi.fn();
    renderTitlebar([makeBranch()], "Push", "/repo", vi.fn(), {
      onExportPatch,
      selectedPatchExportEnabled: true,
    });

    fireEvent.click(screen.getByText("More"));
    fireEvent.click(screen.getByText("Export selected patch..."));

    expect(onExportPatch).toHaveBeenCalledWith("selected");
  });

  it("calls export handlers from the export patch submenu", () => {
    const onExportPatch = vi.fn();
    renderTitlebar([makeBranch()], "Push", "/repo", vi.fn(), { onExportPatch });

    fireEvent.click(screen.getByText("More"));
    fireEvent.click(screen.getByText("Export staged patch..."));

    expect(onExportPatch).toHaveBeenCalledWith("staged");
  });
});
