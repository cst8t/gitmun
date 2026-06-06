// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  } = {},
) {
  const onImportPatch = patchHandlers.onImportPatch ?? vi.fn();
  const onExportPatch = patchHandlers.onExportPatch ?? vi.fn();
  render(
    <Titlebar
      platform="windows"
      native={false}
      repoPath={repoPath}
      currentBranch={repoPath ? "feature/demo" : null}
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

  it("copies the repository path from the titlebar", async () => {
    renderTitlebar([makeBranch()], "Push", "/home/conor/GitmunProjects/gitmun");

    fireEvent.click(screen.getByLabelText("Copy repository path"));

    expect(writeText).toHaveBeenCalledWith("/home/conor/GitmunProjects/gitmun");
    await screen.findByText("Copied");
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
