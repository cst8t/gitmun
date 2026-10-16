// @vitest-environment jsdom
import {act, renderHook, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {useSubmoduleOperations} from "./useSubmoduleOperations";
import type {OperationResult, SubmoduleRemotePreview} from "../types";

vi.mock("react-i18next", () => ({useTranslation: () => ({t: (key: string) => key})}));
vi.mock("../utils/resultLog", () => ({appendResultLog: vi.fn()}));
vi.mock("../api/commands", () => ({
  submoduleInit: vi.fn(), submoduleUpdate: vi.fn(), submoduleSync: vi.fn(),
  submoduleFetch: vi.fn(), submodulePull: vi.fn(), submodulePrepareUpdate: vi.fn(), submoduleApplyUpdate: vi.fn(),
}));
import * as api from "../api/commands";

const operationResult: OperationResult = {message: "SUBMODULE_UPDATED", backendUsed: "git-cli"};
const preview: SubmoduleRemotePreview = {
  path: "dependencies/library", remote: "origin", branch: "main", currentCommit: "old", targetCommit: "new",
  indexCommit: "old", parentHeadCommit: "old", alreadyCheckedOut: false, willDetachHead: true,
  recursive: true, configurationToken: "configuration",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return {promise, resolve, reject};
}
function options() {
  return {
    repoPath: "/parent", refreshStatus: vi.fn().mockResolvedValue(undefined), showToast: vi.fn(),
    startOperation: vi.fn().mockReturnValue({id: 1, kind: "submodule", startedAt: 1}),
    finishOperation: vi.fn(), openRepository: vi.fn().mockResolvedValue(undefined),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.submoduleUpdate).mockResolvedValue(operationResult);
  vi.mocked(api.submodulePrepareUpdate).mockResolvedValue(preview);
  vi.mocked(api.submoduleApplyUpdate).mockResolvedValue(operationResult);
});

describe("submodule operation feedback", () => {
  it("reports immediate progress and blocks duplicate clicks until refresh finishes", async () => {
    const pending = deferred<OperationResult>();
    const refresh = deferred<void>();
    vi.mocked(api.submoduleUpdate).mockReturnValue(pending.promise);
    const settings = options();
    settings.refreshStatus.mockReturnValue(refresh.promise);
    const {result} = renderHook(() => useSubmoduleOperations(settings));
    let completed!: Promise<unknown>;
    act(() => {
      completed = result.current.perform(preview.path, "checkout");
      void result.current.perform(preview.path, "checkout");
    });
    expect(api.submoduleUpdate).toHaveBeenCalledTimes(1);
    expect(result.current.states[preview.path].phase).toBe("running");
    expect(result.current.busy).toBe(true);
    await act(async () => { pending.resolve(operationResult); });
    expect(result.current.states[preview.path].phase).toBe("refreshing");
    expect(settings.finishOperation).not.toHaveBeenCalled();
    await act(async () => { refresh.resolve(); await completed; });
    expect(result.current.states[preview.path].phase).toBe("success");
    expect(settings.finishOperation).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(false);
  });

  it("refreshes after failure and retains diagnostic feedback", async () => {
    vi.mocked(api.submoduleUpdate).mockRejectedValue({code: "SUBMODULE_DIRTY", details: "nested repository has changes"});
    const settings = options();
    const {result} = renderHook(() => useSubmoduleOperations(settings));
    await act(async () => { await result.current.perform(preview.path, "checkout"); });
    expect(settings.refreshStatus).toHaveBeenCalledOnce();
    expect(result.current.states[preview.path]).toMatchObject({phase: "error", error: "nested repository has changes"});
    expect(settings.showToast).toHaveBeenCalledWith("submoduleFeedback.errors.SUBMODULE_DIRTY", "error");
  });

  it("distinguishes status refresh failure from operation failure", async () => {
    const settings = options();
    settings.refreshStatus.mockRejectedValue(new Error("status unavailable"));
    const {result} = renderHook(() => useSubmoduleOperations(settings));
    await act(async () => { await result.current.perform(preview.path, "checkout"); });
    expect(result.current.states[preview.path]).toMatchObject({phase: "error", message: "submoduleFeedback.refreshFailed"});
    expect(settings.finishOperation).toHaveBeenCalledOnce();
  });

  it("previews without applying and applies the exact previewed commit", async () => {
    const {result} = renderHook(() => useSubmoduleOperations(options()));
    await act(async () => { await result.current.prepare(preview.path); });
    expect(api.submoduleApplyUpdate).not.toHaveBeenCalled();
    expect(result.current.preview).toEqual(preview);
    await act(async () => { await result.current.apply(preview.path, false); });
    expect(api.submoduleApplyUpdate).toHaveBeenCalledWith(expect.objectContaining({
      targetCommit: "new", currentCommit: "old", indexCommit: "old", parentHeadCommit: "old", recursive: false, configurationToken: "configuration",
    }));
    expect(result.current.preview).toBeNull();
  });

  it("closes an already-current preview and reports the backend outcome after applying", async () => {
    vi.mocked(api.submodulePrepareUpdate).mockResolvedValue({...preview, currentCommit: "new", alreadyCheckedOut: true});
    vi.mocked(api.submoduleApplyUpdate).mockResolvedValue({...operationResult, message: "alreadyAtRemoteCommit"});
    const settings = options();
    const {result} = renderHook(() => useSubmoduleOperations(settings));
    await act(async () => { await result.current.prepare(preview.path); });
    await act(async () => { await result.current.apply(preview.path, true); });

    expect(api.submoduleApplyUpdate).toHaveBeenCalledWith(expect.objectContaining({currentCommit: "new", targetCommit: "new", recursive: true}));
    expect(result.current.preview).toBeNull();
    expect(settings.refreshStatus).toHaveBeenCalledTimes(2);
    expect(settings.showToast).toHaveBeenLastCalledWith("submoduleFeedback.outcomes.alreadyAtRemoteCommit", "success");
  });

  it("waits for repository navigation and surfaces navigation failures", async () => {
    const navigation = deferred<void>();
    const settings = options();
    settings.openRepository.mockReturnValue(navigation.promise);
    const {result} = renderHook(() => useSubmoduleOperations(settings));
    let completed!: Promise<unknown>;
    act(() => { completed = result.current.open(preview.path); });
    expect(result.current.states[preview.path].phase).toBe("running");
    expect(settings.openRepository).toHaveBeenCalledWith("/parent/dependencies/library");
    await act(async () => { navigation.reject(new Error("unavailable")); await completed; });
    expect(result.current.states[preview.path].phase).toBe("error");
    expect(settings.refreshStatus).not.toHaveBeenCalled();
  });

  it("does not publish an old repository preview into a new repository", async () => {
    const pending = deferred<SubmoduleRemotePreview>();
    vi.mocked(api.submodulePrepareUpdate).mockReturnValue(pending.promise);
    const settings = options();
    const {result, rerender} = renderHook(({repoPath}) => useSubmoduleOperations({...settings, repoPath}), {initialProps: {repoPath: "/parent"}});
    let completed!: Promise<void>;
    act(() => { completed = result.current.prepare(preview.path); });
    rerender({repoPath: "/other"});
    await act(async () => { pending.resolve(preview); await completed; });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.preview).toBeNull();
    expect(result.current.states).toEqual({});
  });

  it.each([
    ["initialise", "submoduleInit"],
    ["checkout", "submoduleUpdate"],
    ["sync", "submoduleSync"],
    ["fetch", "submoduleFetch"],
    ["pull", "submodulePull"],
  ] as const)("runs %s once with the appropriate nested-submodule setting", async (action, command) => {
    const settings = options();
    const {result} = renderHook(() => useSubmoduleOperations(settings));

    await act(async () => { await result.current.perform(preview.path, action); });

    expect(vi.mocked(api[command])).toHaveBeenCalledWith({
      repoPath: "/parent",
      path: preview.path,
      recursive: action === "pull" ? false : true,
    });
    expect(result.current.states[preview.path]).toMatchObject({phase: "success", action});
  });

  it("keeps a no-op outcome beside the initiating control before clearing it", async () => {
    vi.useFakeTimers();
    vi.mocked(api.submoduleFetch).mockResolvedValue({...operationResult, message: "noNewCommitsFetched"});
    const {result} = renderHook(() => useSubmoduleOperations(options()));

    await act(async () => { await result.current.perform(preview.path, "fetch"); });

    expect(result.current.states[preview.path]).toMatchObject({
      phase: "success",
      message: "submoduleFeedback.outcomes.noNewCommitsFetched",
    });
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(result.current.states[preview.path]).toBeUndefined();
    vi.useRealTimers();
  });
});
