// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCommitSearch } from "./useCommitSearch";
import type { CommitHistoryItem, CommitSearchEvent, CommitSearchRequest } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage = (_event: CommitSearchEvent) => {}; } }));
vi.mock("../api/commands", () => ({
  startCommitSearch: vi.fn(),
  continueCommitSearch: vi.fn(),
  cancelCommitSearch: vi.fn(),
}));

import { cancelCommitSearch, continueCommitSearch, startCommitSearch } from "../api/commands";

const sessions: { request: CommitSearchRequest; emit: (event: CommitSearchEvent) => void }[] = [];

function commit(hash: string): CommitHistoryItem {
  return { hash, shortHash: hash, message: hash, author: "Survey Team", authorEmail: "survey@example.test", date: "2026-10-01T00:00:00Z", parentHashes: [], refDecorations: [], signatureStatus: "none", keyType: null };
}

async function debounce() {
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

function emit(status: CommitSearchEvent["status"], commits: CommitHistoryItem[] = [], scannedCount = 100, sessionIndex = sessions.length - 1) {
  const session = sessions[sessionIndex];
  act(() => { session.emit({ sessionId: session.request.sessionId, status, commits, scannedCount }); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessions.length = 0;
  vi.mocked(startCommitSearch).mockImplementation(async (request, channel) => {
    sessions.push({ request, emit: event => channel.onmessage(event) });
  });
  vi.mocked(continueCommitSearch).mockResolvedValue();
  vi.mocked(cancelCommitSearch).mockResolvedValue();
});

afterEach(() => { vi.useRealTimers(); });

describe("useCommitSearch", () => {
  test("debounces for 300 ms and trims the query", async () => {
    const { result, rerender } = renderHook(({ query }) => useCommitSearch("/survey", query, "currentCheckout", false, "AuthorDate"), { initialProps: { query: " field " } });
    expect(result.current.active).toBe(true);
    expect(result.current.status).toBe("scanning");
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(startCommitSearch).not.toHaveBeenCalled();
    rerender({ query: " field notes " });
    await debounce();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].request.query).toBe("field notes");
  });

  test("does not start searches for whitespace or absent repositories", async () => {
    const initialProps: { repo: string | null; query: string } = { repo: "/survey", query: " \t " };
    const { result, rerender } = renderHook(({ repo, query }) => useCommitSearch(repo, query, "currentCheckout", false, "AuthorDate"), { initialProps });
    await debounce();
    expect(result.current.active).toBe(false);
    rerender({ repo: null, query: "notes" });
    await debounce();
    expect(startCommitSearch).not.toHaveBeenCalled();
  });

  test("appends progressive matches and resumes the same session only once", async () => {
    const { result } = renderHook(() => useCommitSearch("/survey", "notes", "allRefs", true, "AuthorDate"));
    await debounce();
    emit("scanning", [commit("older")], 240);
    expect(result.current.commits.map(item => item.hash)).toEqual(["older"]);
    expect(result.current.scannedCount).toBe(240);
    emit("paused", [commit("oldest")], 900);
    act(() => { result.current.loadMore(); result.current.loadMore(); });
    expect(continueCommitSearch).toHaveBeenCalledExactlyOnceWith(sessions[0].request.sessionId);
    expect(result.current.status).toBe("scanning");
    emit("complete", [commit("last")], 1100);
    expect(result.current.commits.map(item => item.hash)).toEqual(["older", "oldest", "last"]);
    expect(startCommitSearch).toHaveBeenCalledTimes(1);
    expect(sessions[0].request).toMatchObject({ scope: "allRefs", topoOrder: true });
  });

  test("cancels immediately on a new query and rejects old session events", async () => {
    const { result, rerender } = renderHook(({ query }) => useCommitSearch("/survey", query, "currentCheckout", false, "AuthorDate"), { initialProps: { query: "old" } });
    await debounce();
    emit("paused", [commit("old-match")]);
    rerender({ query: "new" });
    expect(cancelCommitSearch).toHaveBeenCalledWith(sessions[0].request.sessionId);
    expect(result.current.commits).toEqual([]);
    emit("complete", [commit("late")], 200, 0);
    expect(result.current.commits).toEqual([]);
    await debounce();
    emit("complete", [commit("new-match")]);
    emit("complete", [commit("late-again")], 300, 0);
    expect(result.current.commits.map(item => item.hash)).toEqual(["new-match"]);
  });

  test("clearing and unmounting cancel workers and pending debounce", async () => {
    const { result, rerender, unmount } = renderHook(({ query }) => useCommitSearch("/survey", query, "currentCheckout", false, "AuthorDate"), { initialProps: { query: "notes" } });
    await debounce();
    rerender({ query: " " });
    expect(result.current.active).toBe(false);
    expect(cancelCommitSearch).toHaveBeenCalledWith(sessions[0].request.sessionId);
    rerender({ query: "another" });
    unmount();
    await debounce();
    expect(startCommitSearch).toHaveBeenCalledTimes(1);
  });

  test("restarts on repository, scope, ordering and relevant setting changes", async () => {
    const initialProps = { repo: "/survey", scope: "currentCheckout" as const as "currentCheckout" | "allRefs", topo: false, settings: "AuthorDate" };
    const { rerender } = renderHook(({ repo, scope, topo, settings }) => useCommitSearch(repo, "notes", scope, topo, settings), { initialProps });
    await debounce();
    for (const props of [
      { ...initialProps, repo: "/reports" },
      { ...initialProps, scope: "allRefs" as const },
      { ...initialProps, topo: true },
      { ...initialProps, settings: "CommitterDate" },
    ]) {
      rerender(props);
      await debounce();
    }
    expect(startCommitSearch).toHaveBeenCalledTimes(5);
    expect(cancelCommitSearch).toHaveBeenCalledTimes(4);
  });

  test("coalesces refreshes while scanning and restarts at a page boundary", async () => {
    const { result } = renderHook(() => useCommitSearch("/survey", "notes", "currentCheckout", false, "AuthorDate"));
    await debounce();
    act(() => { result.current.refresh(); result.current.refresh(); result.current.refresh(); });
    emit("scanning", [commit("partial")], 500);
    expect(startCommitSearch).toHaveBeenCalledTimes(1);
    emit("paused", [], 1000);
    await debounce();
    expect(startCommitSearch).toHaveBeenCalledTimes(2);
    expect(result.current.commits).toEqual([]);
    emit("complete", [commit("fresh")]);
    expect(result.current.commits.map(item => item.hash)).toEqual(["fresh"]);
  });

  test("retains partial matches on failure and restarts explicitly", async () => {
    const { result } = renderHook(() => useCommitSearch("/survey", "notes", "currentCheckout", false, "AuthorDate"));
    await debounce();
    emit("scanning", [commit("partial")]);
    act(() => { sessions[0].emit({ sessionId: sessions[0].request.sessionId, commits: [], scannedCount: 120, status: "error", error: { code: "read_failed", details: "unexpected EOF" } }); });
    expect(result.current.error).toEqual({ code: "read_failed", details: "unexpected EOF" });
    expect(result.current.commits.map(item => item.hash)).toEqual(["partial"]);
    act(() => { result.current.restart(); });
    await debounce();
    expect(startCommitSearch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.commits).toEqual([]);
  });

  test("retains matches if continuing fails", async () => {
    vi.mocked(continueCommitSearch).mockRejectedValue({ code: "session_missing", details: "closed" });
    const { result } = renderHook(() => useCommitSearch("/survey", "notes", "currentCheckout", false, "AuthorDate"));
    await debounce();
    emit("paused", [commit("kept")]);
    await act(async () => { result.current.loadMore(); });
    expect(result.current.status).toBe("error");
    expect(result.current.commits[0].hash).toBe("kept");
    expect(result.current.error?.code).toBe("session_missing");
  });

  test("reports start failures and cancels a start that finishes after unmount", async () => {
    vi.mocked(startCommitSearch).mockRejectedValueOnce({ code: "spawn_failed", details: "missing executable" });
    const first = renderHook(() => useCommitSearch("/survey", "notes", "currentCheckout", false, "AuthorDate"));
    await debounce();
    expect(first.result.current.error?.code).toBe("spawn_failed");
    first.unmount();
    let finishStart!: () => void;
    vi.mocked(startCommitSearch).mockImplementationOnce(() => new Promise(resolve => { finishStart = resolve; }));
    const second = renderHook(() => useCommitSearch("/survey", "other", "currentCheckout", false, "AuthorDate"));
    await debounce();
    const sessionId = vi.mocked(startCommitSearch).mock.calls[1][0].sessionId;
    second.unmount();
    await act(async () => { finishStart(); });
    expect(vi.mocked(cancelCommitSearch).mock.calls.filter(([id]) => id === sessionId)).toHaveLength(2);
  });
});
