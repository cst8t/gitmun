import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearCommitMessageDraft,
  loadCommitMessageDraft,
  saveCommitMessageDraft,
} from "./commitMessageDraft";

const storage = new Map<string, string>();
const repoPath = "C:\\marine-lab\\reports";
const draftKey = `gitmun.commitMessageDraft.v1:${encodeURIComponent(repoPath)}`;

beforeEach(() => {
  storage.clear();
  vi.spyOn(Date, "now").mockReturnValue(42);
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("commit message drafts", () => {
  test("saves and loads a draft for a repo path", () => {
    saveCommitMessageDraft(repoPath, "Document sonar drift", "Add the Atlantic calibration notes.");

    expect(loadCommitMessageDraft(repoPath)).toEqual({
      subject: "Document sonar drift",
      body: "Add the Atlantic calibration notes.",
      updatedAt: 42,
    });
  });

  test("removes the stored draft when both fields are blank", () => {
    storage.set(draftKey, JSON.stringify({
      subject: "Review buoy telemetry",
      body: "Capture the missing tide-window context.",
      updatedAt: 1,
    }));

    saveCommitMessageDraft(repoPath, "  ", "\n");

    expect(storage.has(draftKey)).toBe(false);
  });

  test("ignores malformed stored drafts", () => {
    storage.set(draftKey, JSON.stringify({ subject: "Missing timestamp", body: "" }));

    expect(loadCommitMessageDraft(repoPath)).toBeNull();
  });

  test("clears a saved draft", () => {
    saveCommitMessageDraft(repoPath, "Document sonar drift", "");

    clearCommitMessageDraft(repoPath);

    expect(loadCommitMessageDraft(repoPath)).toBeNull();
  });
});
