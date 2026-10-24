// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDiff, FileStatusItem } from "../../types";
import { getDiff, listStashUntrackedPaths } from "../../api/commands";
import "../../i18n";
import { StashPushDialog } from "./StashPushDialog";

vi.mock("../../api/commands", () => ({
  getDiff: vi.fn(),
  listStashUntrackedPaths: vi.fn(),
}));

const mockGetDiff = vi.mocked(getDiff);
const mockListStashUntrackedPaths = vi.mocked(listStashUntrackedPaths);

function file(path: string, status = "modified"): FileStatusItem {
  return { path, status, additions: 1, deletions: 0 };
}

function diff(path: string): FileDiff {
  return { filePath: path, hunks: [], isBinary: false, lineEnding: "lf" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof StashPushDialog>> = {}) {
  const onConfirm = vi.fn<(options: { message: string | null; includeUntracked: boolean; paths: string[] }) => Promise<void>>(async () => {});
  const props: React.ComponentProps<typeof StashPushDialog> = {
    repoPath: "/repo",
    stagedFiles: [],
    unstagedFiles: [file("src/alpha.ts"), file("src/beta.ts")],
    unversionedFiles: [],
    onConfirm,
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...render(<StashPushDialog {...props} />), onConfirm, props };
}

describe("StashPushDialog", () => {
  beforeEach(() => {
    mockGetDiff.mockReset();
    mockGetDiff.mockResolvedValue(diff("unused"));
    mockListStashUntrackedPaths.mockReset();
    mockListStashUntrackedPaths.mockResolvedValue([]);
  });

  it("searches paths and applies bulk selection only to matching files", async () => {
    const { onConfirm } = renderDialog();
    await screen.findByText("2 of 2 files selected");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), { target: { value: "beta" } });
    expect(screen.queryByRole("button", { name: "src/alpha.ts" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear matches" }));
    expect(screen.getByText("1 of 2 files selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select matches" }));

    fireEvent.click(screen.getByRole("button", { name: "Stash 2 files" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      message: null,
      includeUntracked: false,
      paths: ["src/alpha.ts", "src/beta.ts"],
    }));
  });

  it("keeps a deselection when refreshed candidates add a file", async () => {
    const view = renderDialog({ unstagedFiles: [file("src/alpha.ts")] });
    await screen.findByText("1 of 1 files selected");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include src/alpha.ts" }));
    expect(screen.getByRole("button", { name: "Stash 0 files" })).toBeDisabled();

    view.rerender(<StashPushDialog {...view.props} unstagedFiles={[file("src/alpha.ts"), file("src/new.ts")]} />);

    expect(screen.getByRole("checkbox", { name: "Include src/alpha.ts" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include src/new.ts" })).not.toBeChecked();
    expect(screen.getByText("0 of 2 files selected")).toBeInTheDocument();
  });

  it("selects listed untracked files only after include-untracked is enabled", async () => {
    mockListStashUntrackedPaths.mockResolvedValue(["notes/todo.md", "notes/ideas.md"]);
    const { onConfirm } = renderDialog({ unversionedFiles: ["notes"] });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Include untracked files" })).toBeEnabled());

    fireEvent.click(screen.getByRole("checkbox", { name: "Include untracked files" }));
    expect(screen.getByRole("checkbox", { name: "Include notes/todo.md" })).toBeChecked();
    expect(screen.getByText("4 of 4 files selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stash 4 files" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      message: null,
      includeUntracked: true,
      paths: expect.arrayContaining(["notes/ideas.md", "notes/todo.md", "src/alpha.ts", "src/beta.ts"]),
    }));
  });

  it("supports tree folder mixed selections", async () => {
    renderDialog({ unstagedFiles: [file("src/alpha.ts"), file("src/nested/beta.ts")] });
    await screen.findByText("2 of 2 files selected");
    fireEvent.click(screen.getByRole("button", { name: "Tree" }));
    const folder = await screen.findByRole("checkbox", { name: "Include folder src" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include src/alpha.ts" }));

    expect(folder).not.toBeChecked();
    expect((folder as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(folder);
    expect(screen.getByText("2 of 2 files selected")).toBeInTheDocument();
  });

  it("ignores a stale preview response after the selected file changes", async () => {
    const first = deferred<FileDiff>();
    const second = deferred<FileDiff>();
    mockGetDiff.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderDialog();
    await screen.findByText("2 of 2 files selected");

    fireEvent.click(screen.getByRole("button", { name: "src/alpha.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "src/beta.ts" }));
    second.resolve(diff("src/beta.ts"));
    await waitFor(() => expect(screen.getByLabelText("File preview")).toHaveTextContent("src/beta.ts"));
    first.resolve(diff("src/alpha.ts"));

    await waitFor(() => expect(screen.getByLabelText("File preview")).not.toHaveTextContent("src/alpha.ts"));
  });

  it("keeps the current diff mounted while background status updates refresh it", async () => {
    const pending = deferred<FileDiff>();
    const initial: FileDiff = { ...diff("src/alpha.ts"), hunks: [{
      header: "@@ -0,0 +1 @@",
      lines: [{ kind: "add", content: "original preview", oldLineNo: null, newLineNo: 1 }],
    }] };
    mockGetDiff.mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise);
    const view = renderDialog();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Include untracked files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "src/alpha.ts" }));
    const originalLine = await screen.findByText("original preview");
    const diffContainer = originalLine.closest(".stash-push-dialog__diff")!;
    diffContainer.scrollTop = 100;

    view.rerender(<StashPushDialog {...view.props}
      stagedFiles={[]}
      unstagedFiles={view.props.unstagedFiles.map(item => ({ ...item }))}
      unversionedFiles={[]}
    />);
    await waitFor(() => expect(mockGetDiff).toHaveBeenCalledTimes(2));
    expect(originalLine).toBeInTheDocument();
    expect(screen.queryByText("Loading preview…")).not.toBeInTheDocument();
    expect(diffContainer.scrollTop).toBe(100);

    pending.resolve({ ...initial, hunks: [{ ...initial.hunks[0], lines: [{ ...initial.hunks[0].lines[0], content: "updated preview" }] }] });
    const updatedLine = await screen.findByText("updated preview");
    expect(updatedLine.closest(".stash-push-dialog__diff")).toBe(diffContainer);
    expect(diffContainer.scrollTop).toBe(100);
  });

  it("renders binary and empty previews through the shared read-only diff view", async () => {
    mockGetDiff
      .mockResolvedValueOnce({ ...diff("src/alpha.ts"), isBinary: true })
      .mockResolvedValueOnce(diff("src/beta.ts"));
    renderDialog();
    await screen.findByText("2 of 2 files selected");

    fireEvent.click(screen.getByRole("button", { name: "src/alpha.ts" }));
    expect(await screen.findByText("Binary file changed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "src/beta.ts" }));
    expect(await screen.findByText("Empty file - no changes to display")).toBeInTheDocument();
  });

  it("retries a failed preview when the file is selected again", async () => {
    mockGetDiff.mockRejectedValueOnce(new Error("preview failed")).mockResolvedValueOnce(diff("src/alpha.ts"));
    renderDialog();
    await screen.findByText("2 of 2 files selected");

    fireEvent.click(screen.getByRole("button", { name: "src/alpha.ts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this preview");
    fireEvent.click(screen.getByRole("button", { name: "src/alpha.ts" }));

    await waitFor(() => expect(mockGetDiff).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Could not load this preview")).not.toBeInTheDocument();
  });

  it("auto-expands tree search results and restores collapsed folders when cleared", async () => {
    renderDialog({ unstagedFiles: [file("src/alpha.ts"), file("src/nested/beta.ts")] });
    await screen.findByText("2 of 2 files selected");
    fireEvent.click(screen.getByRole("button", { name: "Tree" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("button", { name: "src/alpha.ts" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), { target: { value: "beta" } });
    expect(await screen.findByRole("button", { name: "src/nested/beta.ts" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), { target: { value: "" } });

    expect(screen.queryByRole("button", { name: "src/alpha.ts" })).not.toBeInTheDocument();
  });

  it("removes vanished untracked candidates and leaves newly found ones unchecked", async () => {
    mockListStashUntrackedPaths
      .mockResolvedValueOnce(["notes/old.md"])
      .mockResolvedValueOnce(["drafts/new.md"]);
    const view = renderDialog({ unversionedFiles: ["notes"] });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Include untracked files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox", { name: "Include untracked files" }));
    expect(screen.getByRole("checkbox", { name: "Include notes/old.md" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include notes/old.md" }));

    view.rerender(<StashPushDialog {...view.props} unversionedFiles={["notes", "drafts"]} />);
    expect(await screen.findByRole("checkbox", { name: "Include drafts/new.md" })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Include notes/old.md" })).not.toBeInTheDocument();
  });

  it.each([false, true])("keeps controls, selections and focus stable during a background refresh with untracked files %s", async includeUntracked => {
    const candidatesPending = deferred<string[]>();
    const previewPending = deferred<FileDiff>();
    mockListStashUntrackedPaths.mockResolvedValueOnce(["notes/draft.md"]).mockReturnValueOnce(candidatesPending.promise);
    mockGetDiff.mockResolvedValueOnce(diff("src/alpha.ts")).mockReturnValueOnce(previewPending.promise);
    const view = renderDialog({ stagedFiles: [file("src/alpha.ts")] });
    const checkbox = screen.getByRole("checkbox", { name: "Include untracked files" });
    await waitFor(() => expect(checkbox).toBeEnabled());
    if (includeUntracked) fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole("textbox", { name: "Message (optional)" }), { target: { value: "Work in progress" } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "src/" } });
    fireEvent.click(screen.getByRole("button", { name: "Tree" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include src/beta.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Selected only" }));
    fireEvent.click(screen.getByRole("button", { name: "src/alpha.ts" }));
    await screen.findByText("Empty file - no changes to display");
    const files = view.container.querySelector(".stash-push-dialog__files")!;
    const preview = view.container.querySelector(".stash-push-dialog__diff")!;
    files.scrollTop = 40;
    preview.scrollTop = 80;
    checkbox.focus();
    const controls = Array.from(view.container.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"))
      .map(element => ({ element, disabled: element.disabled }));
    const selection = screen.getByText(includeUntracked ? "2 of 3 files selected" : "1 of 2 files selected");

    view.rerender(<StashPushDialog {...view.props}
      stagedFiles={view.props.stagedFiles.map(item => ({ ...item }))}
      unstagedFiles={view.props.unstagedFiles.map(item => ({ ...item }))}
      unversionedFiles={[]}
    />);
    await waitFor(() => expect(mockListStashUntrackedPaths).toHaveBeenCalledTimes(2));
    for (const { element, disabled } of controls) {
      expect(element).toBeInTheDocument();
      expect(element.disabled).toBe(disabled);
    }
    expect(checkbox).toHaveFocus();
    expect((checkbox as HTMLInputElement).checked).toBe(includeUntracked);
    expect(selection).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Work in progress");
    expect(screen.getByRole("searchbox")).toHaveValue("src/");
    expect(screen.getByRole("button", { name: "Tree" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Selected only" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tab", { name: "Unstaged changes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Loading preview…")).not.toBeInTheDocument();
    expect(files.scrollTop).toBe(40);
    expect(preview.scrollTop).toBe(80);

    await act(async () => {
      candidatesPending.resolve(["notes/draft.md"]);
      previewPending.resolve(diff("src/alpha.ts"));
    });
    expect(screen.getByRole("checkbox", { name: "Include untracked files" })).toBeEnabled();
    expect(checkbox).toHaveFocus();
    expect(files.scrollTop).toBe(40);
    expect(preview.scrollTop).toBe(80);
  });

  it("requires an initial candidate result before enabling untracked selection", async () => {
    const initialPending = deferred<string[]>();
    const retryPending = deferred<string[]>();
    mockListStashUntrackedPaths.mockReturnValueOnce(initialPending.promise).mockReturnValueOnce(retryPending.promise);
    renderDialog();
    const checkbox = screen.getByRole("checkbox", { name: "Include untracked files" });
    expect(checkbox).toBeDisabled();
    initialPending.reject(new Error("initial load failed"));
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Could not load untracked files");
    expect(checkbox).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockListStashUntrackedPaths).toHaveBeenCalledTimes(2));
    expect(error).toBeInTheDocument();
    expect(checkbox).toBeDisabled();
    retryPending.resolve(["notes/draft.md"]);
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps cached candidates usable and their error visible until a refresh succeeds", async () => {
    const retryPending = deferred<string[]>();
    mockListStashUntrackedPaths.mockResolvedValueOnce(["notes/draft.md"])
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockReturnValueOnce(retryPending.promise);
    const view = renderDialog();
    const checkbox = screen.getByRole("checkbox", { name: "Include untracked files" });
    await waitFor(() => expect(checkbox).toBeEnabled());
    fireEvent.click(checkbox);
    view.rerender(<StashPushDialog {...view.props} unversionedFiles={[]} />);
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Could not refresh untracked files");
    expect(checkbox).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stash 3 files" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockListStashUntrackedPaths).toHaveBeenCalledTimes(3));
    expect(error).toBeInTheDocument();
    expect(checkbox).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stash 3 files" })).toBeEnabled();
    retryPending.resolve(["notes/draft.md"]);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Include notes/draft.md" })).toBeChecked();
  });

  it("keeps a preview error visible while retrying a background refresh", async () => {
    const retryPending = deferred<FileDiff>();
    mockGetDiff.mockResolvedValueOnce(diff("src/alpha.ts"))
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockReturnValueOnce(retryPending.promise);
    const view = renderDialog();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Include untracked files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "src/alpha.ts" }));
    await screen.findByText("Empty file - no changes to display");
    view.rerender(<StashPushDialog {...view.props} unstagedFiles={[...view.props.unstagedFiles]} />);
    const error = await screen.findByRole("alert");
    view.rerender(<StashPushDialog {...view.props} unstagedFiles={[...view.props.unstagedFiles]} />);
    await waitFor(() => expect(mockGetDiff).toHaveBeenCalledTimes(3));
    expect(error).toBeInTheDocument();
    expect(screen.getByText("Empty file - no changes to display")).toBeInTheDocument();
    retryPending.resolve(diff("src/alpha.ts"));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("contains tab focus and ignores Escape while a stash is running", async () => {
    const pending = deferred<void>();
    const onConfirm = vi.fn<(options: { message: string | null; includeUntracked: boolean; paths: string[] }) => Promise<void>>(() => pending.promise);
    const onCancel = vi.fn();
    renderDialog({ onConfirm, onCancel });
    await screen.findByText("2 of 2 files selected");
    expect(screen.queryByRole("button", { name: "Close stash dialog" })).not.toBeInTheDocument();
    const message = screen.getByRole("textbox", { name: "Message (optional)" });
    const submit = screen.getByRole("button", { name: "Stash 2 files" });
    message.focus();
    fireEvent.keyDown(message, { key: "Tab", shiftKey: true });
    expect(submit).toHaveFocus();

    fireEvent.click(submit);
    await screen.findByRole("status");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    pending.resolve();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("deduplicates mixed files and switches preview stages without changing selection", async () => {
    const { onConfirm } = renderDialog({ stagedFiles: [file("src/alpha.ts")] });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Include untracked files" })).toBeEnabled());
    expect(screen.getAllByRole("checkbox", { name: "Include src/alpha.ts" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "src/alpha.ts" }));
    await waitFor(() => expect(mockGetDiff).toHaveBeenLastCalledWith("/repo", "src/alpha.ts", false));
    fireEvent.click(screen.getByRole("tab", { name: "Staged changes" }));
    await waitFor(() => expect(mockGetDiff).toHaveBeenLastCalledWith("/repo", "src/alpha.ts", true));
    fireEvent.click(screen.getByRole("button", { name: "Stash 2 files" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ paths: ["src/alpha.ts", "src/beta.ts"] })));
  });

  it("refreshes expanded candidates even when the same untracked directory remains", async () => {
    mockListStashUntrackedPaths.mockResolvedValueOnce(["notes/old.md"])
      .mockResolvedValueOnce(["notes/old.md", "notes/new.md"]);
    const view = renderDialog({ unversionedFiles: ["notes/"] });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Include untracked files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox", { name: "Include untracked files" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include notes/old.md" }));
    view.rerender(<StashPushDialog {...view.props} unversionedFiles={["notes/"]} />);
    expect(await screen.findByRole("checkbox", { name: "Include notes/new.md" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include notes/old.md" })).not.toBeChecked();
  });

  it("reviews selected files and reports hidden selections and empty searches", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Include untracked files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox", { name: "Include src/beta.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Selected only" }));
    expect(screen.queryByRole("button", { name: "src/beta.ts" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByText("No matching files.")).toBeInTheDocument();
    expect(screen.getByText("1 selected file hidden by filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear matches" })).toBeDisabled();
  });

  it("keeps the dialog open and permits retry after stash failure", async () => {
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error("stash failed"))
      .mockResolvedValueOnce(undefined);
    renderDialog({ onConfirm });
    await screen.findByText("2 of 2 files selected");

    fireEvent.click(screen.getByRole("button", { name: "Stash 2 files" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stash failed");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stash 2 files" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
  });
});
