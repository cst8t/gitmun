import { describe, expect, it } from "vitest";
import type { CommitHistoryItem } from "../types";
import { buildCommitGraph } from "./commitGraph";

function commit(hash: string, parentHashes: string[] = []): CommitHistoryItem {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: "Test User",
    authorEmail: "test@example.com",
    date: "2026-06-13T10:00:00Z",
    message: hash,
    parentHashes,
    refDecorations: [],
    signatureStatus: "none",
    keyType: null,
  };
}

describe("commit graph", () => {
  it("keeps linear history on one lane", () => {
    const graph = buildCommitGraph([
      commit("c", ["b"]),
      commit("b", ["a"]),
      commit("a"),
    ]);

    expect(graph.visibleLaneCount).toBe(1);
    expect(graph.rows.c.commitLane).toBe(0);
    expect(graph.rows.b.commitLane).toBe(0);
    expect(graph.rows.a.commitLane).toBe(0);
  });

  it("adds a second lane for merge parents", () => {
    const graph = buildCommitGraph([
      commit("m", ["a", "b"]),
      commit("a", ["root"]),
      commit("b", ["root"]),
      commit("root"),
    ]);

    expect(graph.visibleLaneCount).toBe(2);
    expect(graph.rows.m.parentLanes.map(parent => parent.lane)).toEqual([0, 1]);
    expect(graph.rows.b.commitLane).toBe(1);
  });

  it("keeps the first parent on the straight lane", () => {
    const graph = buildCommitGraph([
      commit("m", ["later", "next"]),
      commit("next", ["base"]),
      commit("later", ["base"]),
      commit("base"),
    ]);

    expect(graph.rows.m.parentLanes).toEqual([
      { hash: "later", lane: 0 },
      { hash: "next", lane: 1 },
    ]);
    expect(graph.rows.next.commitLane).toBe(1);
    expect(graph.rows.later.commitLane).toBe(0);
  });

  it("keeps the first parent straight when the second parent is listed next", () => {
    const graph = buildCommitGraph([
      commit("merge", ["main", "feature-2"]),
      commit("feature-2", ["feature-1"]),
      commit("feature-1", ["main"]),
      commit("main", ["base"]),
    ]);

    expect(graph.rows.merge.parentLanes).toEqual([
      { hash: "main", lane: 0 },
      { hash: "feature-2", lane: 1 },
    ]);
    expect(graph.rows["feature-2"].commitLane).toBe(1);
    expect(graph.rows.main.commitLane).toBe(0);
  });

  it("continues unloaded parents past the loaded page", () => {
    const graph = buildCommitGraph([
      commit("head", ["parent-not-loaded"]),
    ]);

    expect(graph.rows.head.bottomLanes).toEqual([
      { hash: "parent-not-loaded", lane: 0 },
    ]);
  });

  it("tracks active parent source lanes when a side lane collapses", () => {
    const graph = buildCommitGraph([
      commit("merge", ["feature", "side"]),
      commit("feature", ["side"]),
      commit("side", ["base"]),
    ]);

    expect(graph.rows.feature.topLanes).toContainEqual({ hash: "side", lane: 1 });
    expect(graph.rows.feature.parentLanes).toEqual([
      { hash: "side", lane: 0, sourceLane: 1 },
    ]);
  });

  it("caps visible lane count", () => {
    const graph = buildCommitGraph([
      commit("wide", ["a", "b", "c", "d"]),
    ], 3);

    expect(graph.visibleLaneCount).toBe(3);
    expect(graph.rows.wide.parentLanes.map(parent => parent.lane)).toEqual([0, 1, 2, 3]);
  });
});
