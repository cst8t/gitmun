// @vitest-environment jsdom
import {act, renderHook} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {useAutoFetch} from "./useAutoFetch";

describe("useAutoFetch", () => {
  afterEach(() => vi.useRealTimers());

  it("fetches immediately when the repository has no previous attempt", async () => {
    vi.useFakeTimers();
    const fetchRemote = vi.fn(async () => {});
    renderHook(() => useAutoFetch(5, true, "/repo", null, fetchRemote));

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchRemote).toHaveBeenCalledOnce();
  });

  it("waits only for the remaining interval", async () => {
    vi.useFakeTimers();
    const fetchRemote = vi.fn(async () => {});
    const lastFetchAttemptAt = Date.now() - (2 * 60_000);
    renderHook(() => useAutoFetch(5, true, "/repo", lastFetchAttemptAt, fetchRemote));

    await act(() => vi.advanceTimersByTimeAsync((3 * 60_000) - 1));
    expect(fetchRemote).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetchRemote).toHaveBeenCalledOnce();
  });

  it("fetches on focus when the repository became due while inactive", async () => {
    vi.useFakeTimers();
    const fetchRemote = vi.fn(async () => {});
    const lastFetchAttemptAt = Date.now();
    const {rerender} = renderHook(
      ({active}) => useAutoFetch(5, active, "/repo", lastFetchAttemptAt, fetchRemote),
      {initialProps: {active: true}},
    );

    await act(() => vi.advanceTimersByTimeAsync(2 * 60_000));
    rerender({active: false});
    await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    expect(fetchRemote).not.toHaveBeenCalled();

    rerender({active: true});
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchRemote).toHaveBeenCalledOnce();
  });

  it("does not overlap slow fetches", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const fetchRemote = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    renderHook(() => useAutoFetch(5, true, "/repo", null, fetchRemote));

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(fetchRemote).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(fetchRemote).toHaveBeenCalledTimes(2);
  });

  it("does nothing when disabled or inactive", async () => {
    vi.useFakeTimers();
    const fetchRemote = vi.fn(async () => {});
    const {rerender} = renderHook(
      ({active, intervalMinutes}) => useAutoFetch(intervalMinutes, active, "/repo", null, fetchRemote),
      {initialProps: {active: true, intervalMinutes: 0}},
    );
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(fetchRemote).not.toHaveBeenCalled();
    rerender({active: false, intervalMinutes: 5});
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(fetchRemote).not.toHaveBeenCalled();
    rerender({active: true, intervalMinutes: 5});
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchRemote).toHaveBeenCalledOnce();
  });

  it("keeps repository due times independent", async () => {
    vi.useFakeTimers();
    const fetchRemote = vi.fn(async () => {});
    const firstRepoAttemptAt = Date.now();
    const {rerender} = renderHook(
      ({repoPath, lastFetchAttemptAt}: {repoPath: string; lastFetchAttemptAt: number | null}) => useAutoFetch(
        5,
        true,
        repoPath,
        lastFetchAttemptAt,
        fetchRemote,
      ),
      {
        initialProps: {
          repoPath: "/first-repo",
          lastFetchAttemptAt: firstRepoAttemptAt as number | null,
        },
      },
    );

    await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    rerender({repoPath: "/second-repo", lastFetchAttemptAt: null});
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchRemote).toHaveBeenCalledOnce();

    rerender({repoPath: "/first-repo", lastFetchAttemptAt: firstRepoAttemptAt});
    await act(() => vi.advanceTimersByTimeAsync(60_000 - 1));
    expect(fetchRemote).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetchRemote).toHaveBeenCalledTimes(2);
  });
});
