// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import type { FileStatusItem } from "../../types";
import "../../i18n";
import { StagingView } from "./StagingView";

vi.mock("../../api/commands", () => ({
  getNumstat: vi.fn(),
}));

const virtuosoSetVisibleRange = vi.hoisted(() => ({
  current: null as ((range: { startIndex: number; endIndex: number }) => void) | null,
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent, computeItemKey }: {
    data: Array<{ key: string }>;
    itemContent: (index: number, item: { key: string }) => React.ReactNode;
    computeItemKey?: (index: number, item: { key: string }) => React.Key;
  }) => {
    const [visibleRange, setVisibleRange] = React.useState({ startIndex: 0, endIndex: Math.min(data.length - 1, 19) });
    const visibleStart = Math.min(visibleRange.startIndex, Math.max(data.length - 1, 0));
    const visibleEnd = Math.min(visibleRange.endIndex, Math.max(data.length - 1, 0));
    const visibleItems = data.slice(visibleStart, visibleEnd + 1);
    virtuosoSetVisibleRange.current = setVisibleRange;

    React.useEffect(() => {
      setVisibleRange(current => ({
        startIndex: Math.min(current.startIndex, Math.max(data.length - 1, 0)),
        endIndex: Math.min(Math.max(current.endIndex, 19), Math.max(data.length - 1, 0)),
      }));
    }, [data.length]);

    return (
      <div data-testid="staging-virtuoso">
        {visibleItems.map((item, offset) => {
          const index = visibleStart + offset;
          return (
            <div key={computeItemKey?.(index, item) ?? item.key} data-testid={`staging-row-${index}`}>
              {itemContent(index, item)}
            </div>
          );
        })}
      </div>
    );
  },
}));

function file(path: string, additions = 0, deletions = 0): FileStatusItem {
  return {
    path,
    status: "modified",
    additions,
    deletions,
  };
}

function files(prefix: string, count: number): FileStatusItem[] {
  return Array.from({ length: count }, (_, index) => file(`${prefix}/file-${String(index + 1).padStart(3, "0")}.ts`));
}

const untrackedDirectory = { path: "assets", kind: "directory" as const };

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
    stagingOperation: null,
    inlineOperation: null,
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
        file("game/assets/graphics/100/en/symbols/wheel_pip.png"),
      ],
    });

    expect(screen.getByText("game/assets/graphics/100/en/symbols")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Collapse game/assets/graphics/100/en/symbols"));

    expect(screen.queryByText("wheel_pip.png")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Expand game/assets/graphics/100/en/symbols")).toBeInTheDocument();
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

  it("disables bulk staging actions while staging is running", () => {
    renderStagingView({
      unstagedFiles: [file("src/App.tsx")],
      selectedUnstaged: { "src/App.tsx": true },
      stagingOperation: { kind: "stage", count: 1 },
    });

    expect(screen.getByText("Stage Selected")).toBeDisabled();
    expect(screen.getByText("Stage All")).toBeDisabled();
    expect(screen.getByLabelText("Deselect files in src")).toBeDisabled();
  });

  it("renders an untracked directory row with directory copy", () => {
    renderStagingView({
      unversionedFiles: ["assets"],
      unversionedItems: [untrackedDirectory],
    });

    expect(screen.getByText("assets")).toBeInTheDocument();
    expect(screen.getByText("Untracked directory")).toBeInTheDocument();
    expect(screen.queryByLabelText("Expand assets")).not.toBeInTheDocument();
  });

  it("stages a selected untracked directory path", () => {
    const onStageFiles = vi.fn();
    render(<StatefulStagingView
      unversionedFiles={["assets"]}
      unversionedItems={[untrackedDirectory]}
      onStageFiles={onStageFiles}
    />);

    fireEvent.click(screen.getByLabelText("Select files in assets"));
    fireEvent.click(screen.getByText("Stage Selected"));

    expect(onStageFiles).toHaveBeenCalledWith(["assets"]);
  });

  it("disables untracked directory selection while staging is running", () => {
    renderStagingView({
      unversionedFiles: ["assets"],
      unversionedItems: [untrackedDirectory],
      stagingOperation: { kind: "stage", count: 1 },
    });

    expect(screen.getByLabelText("Select files in assets")).toBeDisabled();
    expect(screen.getByText("Stage All")).toBeDisabled();
  });

  it("selects every descendant from a compact folder row", () => {
    const onStageFiles = vi.fn();
    render(<StatefulStagingView
      unstagedFiles={[
        file("game/assets/graphics/100/en/symbols/wheel_pip.png"),
        file("game/assets/graphics/100/en/symbols/wheel_logo.png"),
      ]}
      onStageFiles={onStageFiles}
    />);

    fireEvent.click(screen.getByLabelText("Select files in game/assets/graphics/100/en/symbols"));
    fireEvent.click(screen.getByText("Stage Selected"));

    expect(onStageFiles).toHaveBeenCalledWith([
      "game/assets/graphics/100/en/symbols/wheel_pip.png",
      "game/assets/graphics/100/en/symbols/wheel_logo.png",
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

    fireEvent.click(screen.getAllByLabelText("Collapse src")[0]);

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

    const aRows = screen.getAllByText("A.ts").map(row => row.closest(".file-row"));
    const bRows = screen.getAllByText("B.ts").map(row => row.closest(".file-row"));

    expect(aRows[0]).not.toHaveClass("file-row--striped-strong");
    expect(bRows[0]).toHaveClass("file-row--striped-strong");
    expect(aRows[1]).not.toHaveClass("file-row--striped-strong");
    expect(bRows[1]).toHaveClass("file-row--striped-strong");
  });

  it("does not stripe files when row striping is off", () => {
    renderStagingView({
      unstagedFiles: [file("A.ts"), file("B.ts")],
      rowStriping: "Off",
    });

    expect(screen.getByText("A.ts").closest(".file-row")).not.toHaveClass("file-row--striped-subtle", "file-row--striped-strong");
    expect(screen.getByText("B.ts").closest(".file-row")).not.toHaveClass("file-row--striped-subtle", "file-row--striped-strong");
  });

  it("keeps folder rows expanded below the large-section threshold", () => {
    renderStagingView({
      unstagedFiles: files("src", 20),
    });

    expect(screen.getByLabelText("Collapse src")).toBeInTheDocument();
    expect(screen.getByText("file-001.ts")).toBeInTheDocument();
  });

  it("collapses top-level folders by default above the large-section threshold", () => {
    renderStagingView({
      unstagedFiles: files("bulk", 501),
    });

    expect(screen.getByLabelText("Expand bulk")).toBeInTheDocument();
    expect(screen.queryByText("file-001.ts")).not.toBeInTheDocument();
  });

  it("allows manual expansion to override large-list folder defaults", () => {
    renderStagingView({
      unstagedFiles: files("bulk", 501),
    });

    fireEvent.click(screen.getByLabelText("Expand bulk"));

    expect(screen.getByLabelText("Collapse bulk")).toBeInTheDocument();
    expect(screen.getByText("file-001.ts")).toBeInTheDocument();
  });

  it("selects every descendant from a collapsed large folder row", () => {
    const onStageFiles = vi.fn();
    render(<StatefulStagingView
      unstagedFiles={files("bulk", 501)}
      onStageFiles={onStageFiles}
    />);

    fireEvent.click(screen.getByLabelText("Select files in bulk"));
    fireEvent.click(screen.getByText("Stage Selected"));

    expect(onStageFiles).toHaveBeenCalledWith(files("bulk", 501).map(f => f.path));
  });

  it("virtualises large root-level file lists without hiding later rows", () => {
    renderStagingView({
      unstagedFiles: Array.from({ length: 600 }, (_, index) => file(`root-${String(index + 1).padStart(3, "0")}.ts`)),
    });

    expect(screen.getByTestId("staging-virtuoso")).toBeInTheDocument();
    expect(screen.getByText("root-001.ts")).toBeInTheDocument();
    expect(screen.queryByText("root-600.ts")).not.toBeInTheDocument();

    act(() => {
      virtuosoSetVisibleRange.current?.({ startIndex: 580, endIndex: 603 });
    });

    expect(screen.getByText("root-600.ts")).toBeInTheDocument();
  });
});
