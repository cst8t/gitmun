import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendResultLog,
  clearResultLog,
  getResultLogEntries,
  RESULT_LOG_STORAGE_KEY,
} from "./resultLog";

function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getResultLogEntries", () => {
  test("returns empty array when storage is empty", () => {
    expect(getResultLogEntries()).toEqual([]);
  });

  test("returns entries previously stored", () => {
    appendResultLog("info", "hello", "gix");
    const entries = getResultLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("hello");
    expect(entries[0].level).toBe("info");
    expect(entries[0].backend).toBe("gix");
  });

  test("returns empty array for corrupt JSON", () => {
    localStorage.setItem(RESULT_LOG_STORAGE_KEY, "not-json{{{");
    expect(getResultLogEntries()).toEqual([]);
  });

  test("returns empty array when stored value is not an array", () => {
    localStorage.setItem(RESULT_LOG_STORAGE_KEY, JSON.stringify({ foo: "bar" }));
    expect(getResultLogEntries()).toEqual([]);
  });

  test("filters out entries without a message field", () => {
    localStorage.setItem(
      RESULT_LOG_STORAGE_KEY,
      JSON.stringify([{ id: "1", ts: "2024-01-01T00:00:00Z", level: "info" }]),
    );
    expect(getResultLogEntries()).toHaveLength(0);
  });

  test("defaults unknown level to info", () => {
    localStorage.setItem(
      RESULT_LOG_STORAGE_KEY,
      JSON.stringify([{ message: "hi", level: "bogus" }]),
    );
    expect(getResultLogEntries()[0].level).toBe("info");
  });

  test("defaults unknown backend to unknown", () => {
    localStorage.setItem(
      RESULT_LOG_STORAGE_KEY,
      JSON.stringify([{ message: "hi", backend: "some-other" }]),
    );
    expect(getResultLogEntries()[0].backend).toBe("unknown");
  });

  test("preserves valid success and error levels", () => {
    localStorage.setItem(
      RESULT_LOG_STORAGE_KEY,
      JSON.stringify([
        { message: "a", level: "success" },
        { message: "b", level: "error" },
      ]),
    );
    const entries = getResultLogEntries();
    expect(entries[0].level).toBe("success");
    expect(entries[1].level).toBe("error");
  });
});

describe("appendResultLog", () => {
  test("prepends new entry to the front", () => {
    appendResultLog("info", "first", "gix");
    appendResultLog("error", "second", "git-cli");
    const entries = getResultLogEntries();
    expect(entries[0].message).toBe("second");
    expect(entries[1].message).toBe("first");
  });

  test("defaults backend to unknown when omitted", () => {
    appendResultLog("info", "no backend");
    expect(getResultLogEntries()[0].backend).toBe("unknown");
  });

  test("trims list to 500 entries", () => {
    for (let i = 0; i < 502; i++) {
      appendResultLog("info", `msg ${i}`);
    }
    expect(getResultLogEntries()).toHaveLength(500);
  });

  test("entry has a non-empty id and ISO timestamp", () => {
    appendResultLog("success", "test");
    const entry = getResultLogEntries()[0];
    expect(entry.id).toBeTruthy();
    expect(() => new Date(entry.ts).toISOString()).not.toThrow();
  });
});

describe("clearResultLog", () => {
  test("empties the log", () => {
    appendResultLog("info", "msg");
    clearResultLog();
    expect(getResultLogEntries()).toHaveLength(0);
  });

  test("is safe to call on an empty log", () => {
    expect(() => clearResultLog()).not.toThrow();
    expect(getResultLogEntries()).toHaveLength(0);
  });
});
