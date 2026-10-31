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
