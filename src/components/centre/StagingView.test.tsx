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

  it("renders and collapses compact folder chains using their full path", () => {
    renderStagingView({
      unstagedFiles: [
        file("marine-lab/reports/sonar/2026/atlantic/beam_profile.csv"),
      ],
    });

    expect(screen.getByText("marine-lab/reports/sonar/2026/atlantic")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Collapse marine-lab/reports/sonar/2026/atlantic"));

    expect(screen.queryByText("beam_profile.csv")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Expand marine-lab/reports/sonar/2026/atlantic")).toBeInTheDocument();
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

  it("selects every descendant from a compact folder row", () => {
    const onStageFiles = vi.fn();
    render(<StatefulStagingView
      unstagedFiles={[
        file("marine-lab/reports/sonar/2026/atlantic/beam_profile.csv"),
        file("marine-lab/reports/sonar/2026/atlantic/beam_summary.csv"),
      ]}
      onStageFiles={onStageFiles}
    />);

    fireEvent.click(screen.getByLabelText("Select files in marine-lab/reports/sonar/2026/atlantic"));
    fireEvent.click(screen.getByText("Stage Selected"));

    expect(onStageFiles).toHaveBeenCalledWith([
      "marine-lab/reports/sonar/2026/atlantic/beam_profile.csv",
      "marine-lab/reports/sonar/2026/atlantic/beam_summary.csv",
    ]);
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

  it("stripes visible files across directory boundaries without striping directories", () => {
    renderStagingView({
      unstagedFiles: [
        file("src/App.tsx"),
        file("src/index.ts"),
        file("utils/fileTree.ts"),
        file("README.md"),
      ],
      rowStriping: "Subtle",
    });

    expect(screen.getByText("src").closest(".staging__folder-row")).not.toHaveClass("staging__folder-row--striped-subtle");
    expect(screen.getByText("utils").closest(".staging__folder-row")).not.toHaveClass("staging__folder-row--striped-subtle");
    expect(screen.getByText("App.tsx").closest(".file-row")).not.toHaveClass("file-row--striped-subtle");
    expect(screen.getByText("index.ts").closest(".file-row")).toHaveClass("file-row--striped-subtle");
    expect(screen.getByText("fileTree.ts").closest(".file-row")).not.toHaveClass("file-row--striped-subtle");
    expect(screen.getByText("README.md").closest(".file-row")).toHaveClass("file-row--striped-subtle");
  });

  it("recalculates file striping when a folder is collapsed", () => {
    renderStagingView({
      unstagedFiles: [
        file("alpha/A.ts"),
        file("beta/B.ts"),
        file("README.md"),
      ],
      rowStriping: "Subtle",
    });

    expect(screen.getByText("B.ts").closest(".file-row")).toHaveClass("file-row--striped-subtle");
    expect(screen.getByText("README.md").closest(".file-row")).not.toHaveClass("file-row--striped-subtle");

    fireEvent.click(screen.getByLabelText("Collapse alpha"));

    expect(screen.getByText("B.ts").closest(".file-row")).not.toHaveClass("file-row--striped-subtle");
    expect(screen.getByText("README.md").closest(".file-row")).toHaveClass("file-row--striped-subtle");
  });

  it("restarts file striping for staged and unstaged sections", () => {
    renderStagingView({
      stagedFiles: [file("staged/A.ts"), file("staged/B.ts")],
      unstagedFiles: [file("unstaged/A.ts"), file("unstaged/B.ts")],
      rowStriping: "Strong",
    });

    const stagedSection = screen.getByText(/Staged . 2 files/).closest(".staging__section");
    const unstagedSection = screen.getByText(/Unstaged . 2 files/).closest(".staging__section");
    expect(stagedSection).not.toBeNull();
    expect(unstagedSection).not.toBeNull();

    expect(within(stagedSection as HTMLElement).getByText("A.ts").closest(".file-row")).not.toHaveClass("file-row--striped-strong");
    expect(within(stagedSection as HTMLElement).getByText("B.ts").closest(".file-row")).toHaveClass("file-row--striped-strong");
    expect(within(unstagedSection as HTMLElement).getByText("A.ts").closest(".file-row")).not.toHaveClass("file-row--striped-strong");
    expect(within(unstagedSection as HTMLElement).getByText("B.ts").closest(".file-row")).toHaveClass("file-row--striped-strong");
  });

  it("does not stripe files when row striping is off", () => {
    renderStagingView({
      unstagedFiles: [file("A.ts"), file("B.ts")],
      rowStriping: "Off",
    });

    expect(screen.getByText("A.ts").closest(".file-row")).not.toHaveClass("file-row--striped-subtle", "file-row--striped-strong");
    expect(screen.getByText("B.ts").closest(".file-row")).not.toHaveClass("file-row--striped-subtle", "file-row--striped-strong");
  });
});
