// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getIdentity, setIdentity } from "../api/commands";
import { useGitIdentity } from "./useGitIdentity";
import type { GitIdentity } from "../types";

vi.mock("../api/commands", () => ({
  getIdentity: vi.fn(),
  setIdentity: vi.fn(),
}));

const originalIdentity: GitIdentity = {
  name: "Local Identity", email: null, signingKey: null,
  signingFormat: null, sshKeyPath: null, commitSigningEnabled: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getIdentity).mockResolvedValue(originalIdentity);
  vi.mocked(setIdentity).mockResolvedValue({message: "", backendUsed: "git-cli"});
});

describe("useGitIdentity", () => {
  it("loads, saves and refreshes global identity without a repository", async () => {
    const {result} = renderHook(() => useGitIdentity(null, "Global"));
    await waitFor(() => expect(result.current.identity).toEqual(originalIdentity));
    expect(getIdentity).toHaveBeenCalledWith("", "Global");

    const updatedIdentity = {...originalIdentity, name: "Global Identity"};
    vi.mocked(getIdentity).mockResolvedValue(updatedIdentity);
    await act(async () => {
      await result.current.saveIdentity({name: updatedIdentity.name});
    });
    expect(setIdentity).toHaveBeenCalledWith({repoPath: "", scope: "Global", name: "Global Identity"});
    expect(result.current.identity).toEqual(updatedIdentity);

    vi.mocked(getIdentity).mockResolvedValue(originalIdentity);
    await act(async () => { await result.current.refreshIdentity(); });
    expect(result.current.identity).toEqual(originalIdentity);
  });

  it("does not load or save repository identity without a repository", async () => {
    const {result} = renderHook(() => useGitIdentity(null, "Local"));
    await act(async () => {
      await result.current.refreshIdentity();
      await result.current.saveIdentity({name: "Unavailable"});
    });
    expect(getIdentity).not.toHaveBeenCalled();
    expect(setIdentity).not.toHaveBeenCalled();
    expect(result.current.identity).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("clears repository loading when the repository closes and ignores its pending result", async () => {
    let completeLoad!: (identity: GitIdentity) => void;
    vi.mocked(getIdentity).mockImplementation(() => new Promise(resolve => { completeLoad = resolve; }));
    const {result, rerender} = renderHook(({repoPath}) => useGitIdentity(repoPath, "Local"), {
      initialProps: {repoPath: "/repository" as string | null},
    });
    expect(result.current.loading).toBe(true);
    rerender({repoPath: null});
    expect(result.current.loading).toBe(false);
    await act(async () => { completeLoad(originalIdentity); });
    expect(result.current.identity).toBeNull();
  });

  it("sends explicit removals and reloads the inherited signing state", async () => {
    const {result} = renderHook(() => useGitIdentity("/repository", "Local"));
    await waitFor(() => expect(result.current.identity).toEqual(originalIdentity));
    const clearedIdentity = {...originalIdentity, commitSigningEnabled: null};
    vi.mocked(getIdentity).mockResolvedValue(clearedIdentity);
    await act(async () => {
      await result.current.saveIdentity({clearFields: ["commitSigningEnabled"]});
    });
    expect(setIdentity).toHaveBeenCalledWith({repoPath: "/repository", scope: "Local", clearFields: ["commitSigningEnabled"]});
    expect(result.current.identity).toEqual(clearedIdentity);
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it("reloads partial writes after failure and preserves the save error", async () => {
    const {result} = renderHook(() => useGitIdentity("/repository", "Local"));
    await waitFor(() => expect(result.current.identity).toEqual(originalIdentity));
    const partialIdentity = {...originalIdentity, name: null};
    vi.mocked(getIdentity).mockResolvedValue(partialIdentity);
    const saveError = new Error("GITMUN_ERROR_IDENTITY_SAVE_FAILED");
    vi.mocked(setIdentity).mockRejectedValue(saveError);
    await act(async () => {
      await expect(result.current.saveIdentity({clearFields: ["name", "commitSigningEnabled"]})).rejects.toBe(saveError);
    });
    expect(result.current.identity).toEqual(partialIdentity);
    expect(result.current.error).toContain("GITMUN_ERROR_IDENTITY_SAVE_FAILED");
    expect(result.current.saving).toBe(false);
  });

  it("retains the save failure when reloading also fails", async () => {
    const {result} = renderHook(() => useGitIdentity("/repository", "Local"));
    await waitFor(() => expect(result.current.identity).toEqual(originalIdentity));
    vi.mocked(getIdentity).mockRejectedValue(new Error("Reload failed"));
    const saveError = new Error("GITMUN_ERROR_IDENTITY_SAVE_FAILED");
    vi.mocked(setIdentity).mockRejectedValue(saveError);
    await act(async () => {
      await expect(result.current.saveIdentity({name: "Changed"})).rejects.toBe(saveError);
    });
    expect(result.current.error).toContain("GITMUN_ERROR_IDENTITY_SAVE_FAILED");
    expect(result.current.identity).toEqual(originalIdentity);
    expect(result.current.saving).toBe(false);
  });
});
