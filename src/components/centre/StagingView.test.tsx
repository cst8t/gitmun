// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import type { FileStatusItem } from "../../types";
import "../../i18n";
import { StagingView } from "./StagingView";

vi.mock("../../api/commands", () => ({
  getNumstat: vi.fn(),
}));

function file(path: string, additions = 0, deletions = 0): FileStatusItem {
  return {
    path,
    status: "modified",
    additions,
    deletions,
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof StagingView>> = {}): React.ComponentProps<typeof StagingView> {
  return {
    repoPath: "/repo",
    stagedFiles: [],
    unstagedFiles: [],
    unversionedFiles: [],
    submodules: [],
    conflictedFiles: [],
    mergeInProgress: false,
    mergeMessage: null,
    rebaseInProgress: false,
    cherryPickInProgress: false,
    selectedFile: null,
    selectedSubmodulePath: null,
    selectedUnstaged: {},
    selectedStaged: {},
    onSelectedUnstagedChange: vi.fn(),
    onSelectedStagedChange: vi.fn(),
    onFileSelect: vi.fn(),
    onSubmoduleSelect: vi.fn(),
    onSubmoduleInit: vi.fn(),
    onSubmoduleUpdate: vi.fn(),
    onSubmoduleSync: vi.fn(),
    onSubmoduleFetch: vi.fn(),
    onSubmodulePull: vi.fn(),
    onSubmoduleOpen: vi.fn(),
    onStageFile: vi.fn(),
    onStageFiles: vi.fn(),
    onUnstageFile: vi.fn(),
    onUnstageFiles: vi.fn(),
    onDiscardFile: vi.fn(),
    onDiscardFiles: vi.fn(),
    onDiscardAll: vi.fn(),
    onExternalDiff: vi.fn(),
    onStageAll: vi.fn(),
    onUnstageAll: vi.fn(),
    selectedCommitAction: "commit",
    commitMessageRecommendedLength: 72,
    allowCommitAndPush: true,
    onSelectCommitAction: vi.fn(),
    onCommit: vi.fn(),
    onConflictAcceptTheirs: vi.fn(),
    onConflictAcceptOurs: vi.fn(),
    onOpenMergeTool: vi.fn(),
    isCommitting: false,
    lastCommitMessage: "",
    rowStriping: "Off",
    ...overrides,
  };
}

function renderStagingView(overrides: Partial<React.ComponentProps<typeof StagingView>> = {}) {
  return render(<StagingView {...baseProps(overrides)} />);
}

function StatefulStagingView(props: Partial<React.ComponentProps<typeof StagingView>>) {
  const [selectedUnstaged, setSelectedUnstaged] = React.useState(props.selectedUnstaged ?? {});
  const [selectedStaged, setSelectedStaged] = React.useState(props.selectedStaged ?? {});

  return (
    <StagingView
      {...baseProps(props)}
      selectedUnstaged={selectedUnstaged}
      selectedStaged={selectedStaged}
      onSelectedUnstagedChange={setSelectedUnstaged}
      onSelectedStagedChange={setSelectedStaged}
    />
  );
}

describe("StagingView file tree", () => {
  it("renders common folders as expanded collapsible rows", () => {
    renderStagingView({
      unstagedFiles: [
        file("src/App.tsx", 3, 1),
        file("src/index.ts", 2, 0),
      ],
    });

    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByLabelText("Collapse src")).toBeInTheDocument();
    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("+5")).toBeInTheDocument();
    expect(screen.getAllByText("-1").length).toBeGreaterThan(0);
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("index.ts")).toBeInTheDocument();
  });

  it("collapsing a folder hides descendant file rows", () => {
    renderStagingView({
      unstagedFiles: [
        file("src/App.tsx"),
        file("README.md"),
      ],
    });

    fireEvent.click(screen.getByLabelText("Collapse src"));

    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByLabelText("Expand src")).toBeInTheDocument();
  });

  it("folder checkbox selects descendants for bulk actions", () => {
    const onStageFiles = vi.fn();
    render(<StatefulStagingView
      unstagedFiles={[
        file("src/App.tsx"),
        file("src/components/Button.tsx"),
      ]}
      onStageFiles={onStageFiles}
    />);

    fireEvent.click(screen.getByLabelText("Select files in src"));
    fireEvent.click(screen.getByText("Stage Selected"));

    expect(onStageFiles).toHaveBeenCalledWith(["src/App.tsx", "src/components/Button.tsx"]);
  });

  it("shows an indeterminate folder checkbox when some descendants are selected", () => {
    render(<StatefulStagingView
      unstagedFiles={[
        file("src/App.tsx"),
        file("src/components/Button.tsx"),
      ]}
      selectedUnstaged={{ "src/App.tsx": true }}
    />);

    const folderCheck = screen.getByLabelText("Select files in src") as HTMLInputElement;

    expect(folderCheck.checked).toBe(false);
    expect(folderCheck.indeterminate).toBe(true);
  });

  it("keeps file click and double-click handlers on the full path", () => {
    const onFileSelect = vi.fn();
    const onExternalDiff = vi.fn();
    renderStagingView({
      unstagedFiles: [file("src/App.tsx")],
      onFileSelect,
      onExternalDiff,
    });

    fireEvent.click(screen.getByText("App.tsx"));
    fireEvent.doubleClick(screen.getByText("App.tsx"));

    expect(onFileSelect).toHaveBeenCalledWith("src/App.tsx", false);
    expect(onExternalDiff).toHaveBeenCalledWith("src/App.tsx", false);
  });

  it("keeps staged and unstaged folder expansion independent", () => {
    renderStagingView({
      stagedFiles: [file("src/Staged.tsx")],
      unstagedFiles: [file("src/Unstaged.tsx")],
    });

    const stagedSection = screen.getByText(/Staged . 1 file/).closest(".staging__section");
    expect(stagedSection).not.toBeNull();

    fireEvent.click(within(stagedSection as HTMLElement).getByLabelText("Collapse src"));

    expect(screen.queryByText("Staged.tsx")).not.toBeInTheDocument();
    expect(screen.getByText("Unstaged.tsx")).toBeInTheDocument();
  });
});
