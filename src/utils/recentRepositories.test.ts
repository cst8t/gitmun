import {describe, expect, it, vi} from "vitest";
import {
  RECENT_REPOSITORIES_STORAGE_KEY,
  addRecentRepository,
  loadRecentRepositories,
  normaliseRecentRepositories,
  removeRecentRepository,
  saveRecentRepositories,
} from "./recentRepositories";

describe("recent repositories", () => {
  it("inserts new paths at the front", () => {
    expect(addRecentRepository(["/repos/two", "/repos/one"], "/repos/three"))
      .toEqual(["/repos/three", "/repos/two", "/repos/one"]);
  });

  it("moves an existing path to the front without duplicating it", () => {
    expect(addRecentRepository(["/repos/three", "/repos/two", "/repos/one"], "/repos/two"))
      .toEqual(["/repos/two", "/repos/three", "/repos/one"]);
  });

  it("keeps only ten unique paths", () => {
    const paths = Array.from({length: 12}, (_, index) => `/repos/${index}`);

    expect(normaliseRecentRepositories([...paths, "/repos/2"])).toEqual(paths.slice(0, 10));
  });

  it("removes only the selected path", () => {
    expect(removeRecentRepository(["/repos/three", "/repos/two", "/repos/one"], "/repos/two"))
      .toEqual(["/repos/three", "/repos/one"]);
  });

  it("loads and normalises persisted history", () => {
    const getItem = vi.fn((key: string) => key === RECENT_REPOSITORIES_STORAGE_KEY
      ? JSON.stringify(["/repos/two", "/repos/two", "/repos/one"])
      : null);

    expect(loadRecentRepositories({getItem})).toEqual(["/repos/two", "/repos/one"]);
  });

  it("normalises and persists history", () => {
    const setItem = vi.fn();

    const saved = saveRecentRepositories(
      {setItem},
      ["/repos/two", "/repos/two", "/repos/one"],
    );

    expect(saved).toEqual(["/repos/two", "/repos/one"]);
    expect(setItem).toHaveBeenCalledWith(
      RECENT_REPOSITORIES_STORAGE_KEY,
      JSON.stringify(["/repos/two", "/repos/one"]),
    );
  });

  it("ignores malformed persisted history", () => {
    expect(loadRecentRepositories({getItem: () => "not-json"})).toEqual([]);
    expect(loadRecentRepositories({getItem: () => JSON.stringify({path: "/repos/one"})})).toEqual([]);
  });
});
