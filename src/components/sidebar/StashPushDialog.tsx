import React, { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import type { FileDiff, FileStatusItem } from "../../types";
import { getDiff, listStashUntrackedPaths } from "../../api/commands";
import { buildFileTree, descendantFilePaths, visibleFileTreeRows, type FileTreeNode } from "../../utils/fileTree";
import { FileDiffView } from "../diff/FileDiffView";
import "./StashPushDialog.css";

type StashPushOptions = {
  message: string | null;
  includeUntracked: boolean;
  paths: string[];
};

type Props = {
  repoPath: string;
  stagedFiles: FileStatusItem[];
  unstagedFiles: FileStatusItem[];
  unversionedFiles: string[];
  onConfirm: (opts: StashPushOptions) => Promise<void>;
  onCancel: () => void;
};

function folderExpansion(nodes: FileTreeNode[], expanded: boolean): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const node of nodes) {
    if (node.type === "directory") {
      result[node.path] = expanded;
      Object.assign(result, folderExpansion(node.children, expanded));
    }
  }
  return result;
}

export function StashPushDialog({
  repoPath,
  stagedFiles,
  unstagedFiles,
  unversionedFiles,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation("sidebar");
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [untrackedPaths, setUntrackedPaths] = useState<string[] | null>(null);
  const [candidateError, setCandidateError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(
    () => new Set([...stagedFiles, ...unstagedFiles].map((file) => file.path)),
  );
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [treeView, setTreeView] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewStaged, setPreviewStaged] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [preview, setPreview] = useState<{ key: string | null; diff: FileDiff | null; loading: boolean; error: boolean }>({
    key: null,
    diff: null,
    loading: false,
    error: false,
  });
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    messageRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    listStashUntrackedPaths(repoPath)
      .then((paths) => {
        if (!cancelled) {
          setUntrackedPaths(previous => (
            previous?.length === paths.length && previous.every((path, index) => path === paths[index])
              ? previous
              : paths
          ));
          setCandidateError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setCandidateError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, unversionedFiles, retry]);

  // Compare status contents so unchanged refreshes keep the file rows stable.
  const stagedFilesKey = JSON.stringify(stagedFiles);
  const unstagedFilesKey = JSON.stringify(unstagedFiles);
  const stagedPaths = useMemo(() => new Set(stagedFiles.map(file => file.path)), [stagedFilesKey]);
  const unstagedPaths = useMemo(() => new Set(unstagedFiles.map(file => file.path)), [unstagedFilesKey]);
  const candidates = useMemo(() => {
    const files = new Map<string, FileStatusItem>();
    for (const file of [...stagedFiles, ...unstagedFiles]) {
      files.set(file.path, file);
    }
    if (includeUntracked && untrackedPaths) {
      for (const path of untrackedPaths) {
        if (!files.has(path)) files.set(path, { path, status: "?", additions: null, deletions: null });
      }
    }
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }, [stagedFilesKey, unstagedFilesKey, includeUntracked, untrackedPaths]);
  const availablePaths = useMemo(() => new Set(candidates.map(file => file.path)), [candidates]);
  const selectedPaths = useMemo(
    () => [...checkedPaths].filter((path) => availablePaths.has(path)),
    [checkedPaths, availablePaths],
  );

  useEffect(() => {
    setCheckedPaths((previous) => {
      const next = new Set([...previous].filter((path) => availablePaths.has(path)));
      return next.size === previous.size ? previous : next;
    });
    if (previewPath && !availablePaths.has(previewPath)) {
      setPreviewPath(null);
    }
  }, [availablePaths, previewPath]);

  const previewIsStaged = previewPath !== null && stagedPaths.has(previewPath) && (!unstagedPaths.has(previewPath) || previewStaged);
  const previewKey = previewPath ? JSON.stringify([repoPath, previewPath, previewIsStaged]) : null;
  const currentPreview = preview.key === previewKey ? preview : null;
  useEffect(() => {
    if (!previewPath) {
      setPreview({ key: null, diff: null, loading: false, error: false });
      return;
    }
    let cancelled = false;
    setPreview(previous => ({
      key: previewKey,
      diff: previous.key === previewKey ? previous.diff : null,
      loading: true,
      error: previous.key === previewKey ? previous.error : false,
    }));
    getDiff(repoPath, previewPath, previewIsStaged)
      .then((diff) => {
        if (!cancelled) setPreview({ key: previewKey, diff, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setPreview(previous => ({ ...previous, loading: false, error: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, previewPath, previewIsStaged, previewKey, stagedFiles, unstagedFiles, untrackedPaths, previewRetry]);

  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [busy]);

  const search = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => candidates.filter(
      (file) => file.path.toLocaleLowerCase().includes(search)
        && (!selectedOnly || checkedPaths.has(file.path)),
    ),
    [candidates, search, selectedOnly, checkedPaths],
  );
  const filteredPaths = new Set(filtered.map((file) => file.path));
  const hiddenSelected = selectedPaths.filter((path) => !filteredPaths.has(path)).length;
  const tree = useMemo(() => buildFileTree(filtered), [filtered]);
  const rows = useMemo(
    () => treeView
      ? visibleFileTreeRows(
        tree,
        search ? folderExpansion(tree, true) : expandedFolders,
        filtered.length,
        (path) => path,
      )
      : filtered.map((file, fileIndex) => ({
        type: "file" as const,
        depth: 0,
        fileIndex,
        node: {
          type: "file" as const,
          name: file.path.split("/").pop()!,
          path: file.path,
          file,
          additions: 0,
          deletions: 0,
        },
      })),
    [treeView, tree, search, expandedFolders, filtered],
  );

  function changeSelection(paths: string[], checked: boolean) {
    setCheckedPaths((previous) => {
      const next = new Set(previous);
      paths.forEach((path) => (checked ? next.add(path) : next.delete(path)));
      return next;
    });
  }

  function toggleUntracked(checked: boolean) {
    setIncludeUntracked(checked);
    changeSelection((untrackedPaths ?? []).filter(path => !stagedPaths.has(path) && !unstagedPaths.has(path)), checked);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busyRef.current) onCancel();
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]') ?? []).filter(element => !element.matches(":disabled") && element.tabIndex >= 0);
    if (!controls.length) {
      event.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current || selectedPaths.length === 0 || (includeUntracked && untrackedPaths === null)) return;
    busyRef.current = true;
    setBusy(true);
    setElapsed(0);
    setSubmitError(null);
    dialogRef.current?.focus();
    try {
      await onConfirm({ message: message.trim() || null, includeUntracked, paths: selectedPaths });
    } catch (error) {
      setSubmitError(String(error).includes("stash_selection_changed") ? t("stashPush.selectionChanged") : String(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function renderRow(index: number, row: typeof rows[number]) {
    const directory = row.type === "directory";
    const paths = directory ? descendantFilePaths(row.node) : [row.node.path];
    const checkedCount = paths.filter((path) => checkedPaths.has(path)).length;
    const path = row.node.path;
    return (
      <div
        className={`stash-push-dialog__row${previewPath === path && !directory ? " stash-push-dialog__row--active" : ""}`}
        style={{ paddingLeft: 8 + row.depth * 16 }}
        data-stash-row={index}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const nextIndex = Math.max(
            0,
            Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
          );
          const focusRow = () => dialogRef.current
            ?.querySelector(`[data-stash-row="${nextIndex}"]`)
            ?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus();
          if (rows.length > 200) {
            listRef.current?.scrollIntoView({ index: nextIndex, done: focusRow });
          } else {
            focusRow();
          }
        }}
      >
        <input
          type="checkbox"
          aria-label={t(directory ? "stashPush.includeFolder" : "stashPush.includePath", { path })}
          checked={checkedCount === paths.length}
          ref={(element) => {
            if (element) element.indeterminate = checkedCount > 0 && checkedCount < paths.length;
          }}
          onChange={(event) => changeSelection(paths, event.target.checked)}
          disabled={busy}
        />
        {directory ? (
          <button
            type="button"
            className="stash-push-dialog__path"
            aria-expanded={row.expanded}
            disabled={busy || !!search}
            onClick={() => setExpandedFolders((previous) => ({ ...previous, [path]: !row.expanded }))}
          >
            <span aria-hidden="true">{row.expanded ? "▾" : "▸"}</span>
            {row.node.name}
            <span className="stash-push-dialog__metadata">{paths.length}</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              className="stash-push-dialog__path"
                aria-label={path}
              title={path}
              aria-pressed={previewPath === path}
              disabled={busy}
              onClick={() => {
                setPreviewPath(path);
                setPreviewStaged(false);
                setPreviewRetry((value) => value + 1);
              }}
            >
              <span className="stash-push-dialog__filename">{row.node.name}</span>
              {!treeView && path.includes("/") && (
                <span className="stash-push-dialog__parent">
                  {path.slice(0, path.lastIndexOf("/"))}
                </span>
              )}
            </button>
            <span className="stash-push-dialog__badges">
              <span title={row.node.file.status}>{row.node.file.status.toUpperCase().slice(0, 1)}</span>
              {stagedPaths.has(path) && <span>{t("stashPush.staged")}</span>}
              {unstagedPaths.has(path) && <span>{t("stashPush.unstaged")}</span>}
              {!stagedPaths.has(path) && !unstagedPaths.has(path) && (
                <span>{t("stashPush.untracked")}</span>
              )}
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className="dialog-backdrop"
        onClick={() => {
          if (!busyRef.current) onCancel();
        }}
      />
      <div
        ref={dialogRef}
        className="dialog stash-push-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stash-push-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="stash-push-dialog__header">
          <div id="stash-push-title" className="dialog__title">{t("stashPush.title")}</div>
        </header>
        <form onSubmit={handleSubmit}>
          <div className="stash-push-dialog__options">
            <div className="dialog__field">
              <label className="dialog__label" htmlFor="stash-message">
                {t("stashPush.message")} <span>{t("stashPush.messageHint")}</span>
              </label>
              <input
                ref={messageRef}
                id="stash-message"
                className="dialog__input"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t("stashPush.messagePlaceholder")}
                disabled={busy}
              />
            </div>
            <label>
              <input
                type="checkbox"
                checked={includeUntracked}
                onChange={(event) => toggleUntracked(event.target.checked)}
                disabled={busy || untrackedPaths === null}
              />
              {t("stashPush.includeUntracked")}
            </label>
          </div>
          {candidateError && (
            <div role="alert" className="dialog__error">
              {t(untrackedPaths === null ? "stashPush.candidateError" : "stashPush.candidateRefreshError")}
              <button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
                {t("stashPush.retry")}
              </button>
            </div>
          )}
          <div className="stash-push-dialog__workspace">
            <section className="stash-push-dialog__browser" aria-label={t("stashPush.files")}>
              <div className="stash-push-dialog__toolbar">
                <input
                  type="search"
                  className="dialog__input"
                  aria-label={t("stashPush.search")}
                  placeholder={t("stashPush.search")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  disabled={busy}
                />
                <div className="stash-push-dialog__tools">
                  <button type="button" aria-pressed={!treeView} onClick={() => setTreeView(false)} disabled={busy}>
                    {t("stashPush.flatList")}
                  </button>
                  <button type="button" aria-pressed={treeView} onClick={() => setTreeView(true)} disabled={busy}>
                    {t("stashPush.tree")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={selectedOnly}
                    onClick={() => setSelectedOnly((value) => !value)}
                    disabled={busy}
                  >
                    {t("stashPush.selectedOnly")}
                  </button>
                </div>
                <div className="stash-push-dialog__tools">
                  <button
                    type="button"
                    disabled={busy || !filtered.length}
                    onClick={() => changeSelection(filtered.map((file) => file.path), true)}
                  >
                    {t(search || selectedOnly ? "stashPush.selectMatches" : "stashPush.selectAll")}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !filtered.length}
                    onClick={() => changeSelection(filtered.map((file) => file.path), false)}
                  >
                    {t(search || selectedOnly ? "stashPush.clearMatches" : "stashPush.clearAll")}
                  </button>
                  {treeView && !search && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setExpandedFolders(folderExpansion(tree, true))}
                      >
                        {t("stashPush.expandAll")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setExpandedFolders(folderExpansion(tree, false))}
                      >
                        {t("stashPush.collapseAll")}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="stash-push-dialog__files">
                {rows.length > 200 ? (
                  <Virtuoso
                    ref={listRef}
                    style={{ height: "100%" }}
                    data={rows}
                    computeItemKey={(_index, row) => `${row.type}:${row.node.path}`}
                    itemContent={renderRow}
                  />
                ) : rows.length ? (
                  rows.map((row, index) => (
                    <React.Fragment key={`${row.type}:${row.node.path}`}>
                      {renderRow(index, row)}
                    </React.Fragment>
                  ))
                ) : (
                  <p className="stash-push-dialog__placeholder">{t("stashPush.noMatches")}</p>
                )}
              </div>
            </section>
            <section className="stash-push-dialog__preview" aria-label={t("stashPush.preview")}>
              <div className="stash-push-dialog__preview-header">
                <span className="stash-push-dialog__full-path">{previewPath || t("stashPush.preview")}</span>
                {previewPath && stagedPaths.has(previewPath) && unstagedPaths.has(previewPath) && (
                  <>
                    <div
                      className="stash-push-dialog__tools"
                      role="tablist"
                      aria-label={t("stashPush.preview")}
                      onKeyDown={event => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        event.preventDefault();
                        setPreviewStaged(!previewIsStaged);
                        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[previewIsStaged ? 1 : 0]?.focus();
                      }}
                    >
                      <button
                        type="button"
                        role="tab"
                        disabled={busy}
                        id="stash-preview-staged"
                        aria-controls="stash-preview-panel"
                        tabIndex={previewIsStaged ? 0 : -1}
                        aria-selected={previewIsStaged}
                        onClick={() => setPreviewStaged(true)}
                      >
                        {t("stashPush.stagedChanges")}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        disabled={busy}
                        id="stash-preview-unstaged"
                        aria-controls="stash-preview-panel"
                        tabIndex={!previewIsStaged ? 0 : -1}
                        aria-selected={!previewIsStaged}
                        onClick={() => setPreviewStaged(false)}
                      >
                        {t("stashPush.unstagedChanges")}
                      </button>
                    </div>
                    <span className="stash-push-dialog__metadata">{t("stashPush.bothIncluded")}</span>
                  </>
                )}
              </div>
              <div
                id="stash-preview-panel"
                className="stash-push-dialog__diff"
                role={previewPath && stagedPaths.has(previewPath) && unstagedPaths.has(previewPath) ? "tabpanel" : undefined}
                aria-labelledby={previewPath && stagedPaths.has(previewPath) && unstagedPaths.has(previewPath) ? (previewIsStaged ? "stash-preview-staged" : "stash-preview-unstaged") : undefined}
                aria-live="polite"
              >
                {currentPreview?.error && <p role="alert" className="dialog__error">{t("stashPush.previewError")}</p>}
                {previewPath && (!currentPreview || (currentPreview.loading && !currentPreview.diff)) ? (
                  <p className="stash-push-dialog__placeholder">{t("stashPush.loadingPreview")}</p>
                ) : currentPreview?.diff ? (
                  <FileDiffView diff={currentPreview.diff} />
                ) : !currentPreview?.error ? (
                  <p className="stash-push-dialog__placeholder">{t("stashPush.choosePreview")}</p>
                ) : null}
              </div>
            </section>
          </div>
          <footer className="stash-push-dialog__footer">
            <div className="stash-push-dialog__summary" aria-live="polite">
              <span>{t("stashPush.selectionCount", { count: selectedPaths.length, total: candidates.length })}</span>
              {hiddenSelected > 0 && <span>{t("stashPush.hiddenCount", { count: hiddenSelected })}</span>}
              {busy && <span role="status">{t("stashPush.stashing", { seconds: elapsed })}</span>}
              {submitError && (
                <span role="alert" className="dialog__error">
                  {t("stashPush.submitError", { message: submitError })}
                </span>
              )}
            </div>
            <div className="dialog__actions">
              <button
                type="button"
                className="dialog__btn dialog__btn--cancel"
                onClick={onCancel}
                disabled={busy}
              >
                {t("stashPush.cancel")}
              </button>
              <button
                type="submit"
                className="dialog__btn dialog__btn--confirm"
                disabled={busy || selectedPaths.length === 0 || (includeUntracked && untrackedPaths === null)}
              >
                {t("stashPush.stashCount", { count: selectedPaths.length })}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </>
  );
}
