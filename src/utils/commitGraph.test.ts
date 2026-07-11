import { describe, expect, it } from "vitest";
import type { CommitHistoryItem } from "../types";
import { buildCommitGraph, type CommitGraphSegment } from "./commitGraph";

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

function curves(segments: CommitGraphSegment[]) {
  return segments.filter(segment => segment.kind === "curve");
}

function verticals(segments: CommitGraphSegment[]) {
  return segments.filter(segment => segment.kind === "vertical");
}

function gitkComparisonCommits(): CommitHistoryItem[] {
  return [
    commit("m350000", ["trunk01", "branchA"]),
    commit("trunk01", ["trunk02", "branchB"]),
    commit("trunk02", ["trunk03"]),
    commit("branchB", ["bot0001"]),
    commit("branchA", ["msix001"]),
    commit("trunk03", ["trunk04"]),
    commit("bot0001", ["common1"]),
    commit("msix001", ["common1"]),
    commit("trunk04", ["trunk05"]),
    commit("common1", ["trunk05"]),
    commit("trunk05", ["main000"]),
    commit("main000", ["base001", "side001"]),
    commit("side001", ["dep0001"]),
    commit("base001", ["base002"]),
    commit("dep0001", ["base002"]),
    commit("base002"),
  ];
}

function allRefsComparisonCommits(): CommitHistoryItem[] {
  return [
    commit("b03f190", ["5adfc06"]),
    commit("5adfc06", ["944b856", "46acab3"]),
    commit("46acab3", ["8cad84d"]),
    commit("8cad84d", ["240dc66"]),
    commit("240dc66", ["14b4519"]),
    commit("14b4519", ["107c01b"]),
    commit("107c01b", ["5ad6049"]),
    commit("5ad6049", ["91ff990", "b90460d"]),
    commit("b90460d", ["c89ff95"]),
    commit("c89ff95", ["774d89c"]),
    commit("91ff990", ["774d89c"]),
    commit("774d89c", ["73dd177"]),
    commit("73dd177", ["2d2158d"]),
    commit("2d2158d", ["944b856"]),
    commit("944b856", ["5b9d95f"]),
    commit("5b9d95f", ["74f5d91"]),
    commit("74f5d91", ["4b16751"]),
    commit("4b16751", ["be42942"]),
    commit("be42942", ["440e90f", "935d400"]),
    commit("440e90f", ["5469009", "9370356"]),
    commit("9370356", ["2aefbe4"]),
    commit("2aefbe4", ["9c25e0d"]),
    commit("9c25e0d", ["80d675f"]),
    commit("80d675f", ["220f7e3"]),
    commit("220f7e3", ["5469009"]),
    commit("5469009", ["4490dd8"]),
    commit("4490dd8", ["38450bb"]),
    commit("38450bb", ["b7055ec"]),
    commit("b7055ec", ["59e3633", "36235d0"]),
    commit("36235d0", ["43e51b3"]),
    commit("43e51b3", ["4909592"]),
    commit("4909592", ["ef2da30"]),
    commit("ef2da30", ["72319d2"]),
    commit("72319d2", ["82f749a"]),
    commit("82f749a", ["0a60a51"]),
    commit("0a60a51", ["2661559"]),
    commit("2661559", ["1f838a5"]),
    commit("1f838a5", ["59e3633"]),
    commit("59e3633"),
  ];
}

function segmentReachesBottom(
  segment: CommitGraphSegment,
  hash: string,
  lane: number,
  bottomUnit: number,
): boolean {
  if (segment.hash !== hash) return false;
  if (segment.kind === "vertical") {
    return segment.lane === lane && segment.toUnit === bottomUnit;
  }
  if (segment.kind === "curve") {
    return segment.toLane === lane && segment.toUnit === bottomUnit;
  }
  return false;
}

function expectNoUnexplainedTopStarts(commits: CommitHistoryItem[]) {
  const graph = buildCommitGraph(commits);

  for (const [index, commit] of commits.entries()) {
    const row = graph.rows[commit.hash];
    const topVerticals = verticals(row.segments).filter(segment => segment.fromUnit === 0);
    if (index === 0) {
      expect(topVerticals).toEqual([]);
      continue;
    }

    const previousCommit = commits[index - 1];
    const previousRow = graph.rows[previousCommit.hash];
    const previousBottom = previousRow.heightUnits * 100;
    for (const segment of topVerticals) {
      expect(
        previousRow.segments.some(previousSegment => (
          segmentReachesBottom(previousSegment, segment.hash, segment.lane, previousBottom)
        )),
      ).toBe(true);
    }
  }
}

describe("commit graph", () => {
  it("keeps linear history on one lane", () => {
    const graph = buildCommitGraph([
      commit("c", ["b"]),
      commit("b", ["a"]),
      commit("a"),
    ]);

    expect(graph.visibleLaneCount).toBe(1);
    expect(graph.rows.c.nodeLane).toBe(0);
    expect(graph.rows.b.nodeLane).toBe(0);
    expect(graph.rows.a.nodeLane).toBe(0);
    expect(verticals(graph.rows.c.segments)).toContainEqual({
      kind: "vertical",
      lane: 0,
      fromUnit: 50,
      toUnit: 100,
      hash: "b",
      colourLane: 0,
    });
  });

  it("adds a second lane for merge parents", () => {
    const graph = buildCommitGraph([
      commit("m", ["a", "b"]),
      commit("a", ["root"]),
      commit("b", ["root"]),
      commit("root"),
    ]);

    expect(graph.visibleLaneCount).toBe(2);
    expect(graph.rows.m.nodeLane).toBe(0);
    expect(curves(graph.rows.m.segments)).toContainEqual({
      kind: "curve",
      fromLane: 0,
      toLane: 1,
      fromUnit: 50,
      toUnit: 100,
      hash: "b",
      colourLane: 0,
    });
    expect(graph.rows.b.nodeLane).toBe(1);
  });

  it("keeps the first parent on the straight lane", () => {
    const graph = buildCommitGraph([
      commit("m", ["later", "next"]),
      commit("next", ["base"]),
      commit("later", ["base"]),
      commit("base"),
    ]);

    expect(graph.rows.m.segments).toContainEqual({
      kind: "vertical",
      lane: 0,
      fromUnit: 50,
      toUnit: 100,
      hash: "later",
      colourLane: 0,
    });
    expect(curves(graph.rows.m.segments)).toContainEqual({
      kind: "curve",
      fromLane: 0,
      toLane: 1,
      fromUnit: 50,
      toUnit: 100,
      hash: "next",
      colourLane: 0,
    });
    expect(graph.rows.next.nodeLane).toBe(1);
    expect(graph.rows.later.nodeLane).toBe(0);
  });

  it("keeps the first parent straight when the second parent is listed next", () => {
    const graph = buildCommitGraph([
      commit("merge", ["main", "feature-2"]),
      commit("feature-2", ["feature-1"]),
      commit("feature-1", ["main"]),
      commit("main", ["base"]),
    ]);

    expect(graph.rows.merge.segments).toContainEqual({
      kind: "vertical",
      lane: 0,
      fromUnit: 50,
      toUnit: 100,
      hash: "main",
      colourLane: 0,
    });
    expect(curves(graph.rows.merge.segments)).toContainEqual({
      kind: "curve",
      fromLane: 0,
      toLane: 1,
      fromUnit: 50,
      toUnit: 100,
      hash: "feature-2",
      colourLane: 0,
    });
    expect(graph.rows["feature-2"].nodeLane).toBe(1);
    expect(graph.rows.main.nodeLane).toBe(0);
  });

  it("continues unloaded parents past the loaded page", () => {
    const graph = buildCommitGraph([
      commit("head", ["parent-not-loaded"]),
    ]);

    expect(graph.rows.head.segments).toContainEqual({
      kind: "vertical",
      lane: 0,
      fromUnit: 50,
      toUnit: 100,
      hash: "parent-not-loaded",
      colourLane: 0,
    });
  });

  it("collapses an active first parent on the right into the node lane", () => {
    const graph = buildCommitGraph([
      commit("merge", ["feature", "side"]),
      commit("feature", ["side"]),
      commit("side", ["base"]),
    ]);

    expect(verticals(graph.rows.feature.segments)).toContainEqual({
      kind: "vertical",
      lane: 1,
      fromUnit: 0,
      toUnit: 50,
      hash: "side",
      colourLane: 1,
    });
    expect(curves(graph.rows.feature.segments)).toContainEqual({
      kind: "curve",
      fromLane: 1,
      toLane: 0,
      fromUnit: 50,
      toUnit: 100,
      hash: "side",
      colourLane: 1,
    });
    expect(graph.rows.side.nodeLane).toBe(0);
  });

  it("introduces merge side parents beside the merge path", () => {
    const graph = buildCommitGraph([
      commit("after-merge", ["merge"]),
      commit("unrelated-tip", ["unrelated-base"]),
      commit("merge", ["main", "feature"]),
      commit("main", ["base"]),
      commit("feature", ["base"]),
      commit("unrelated-base"),
      commit("base"),
    ]);

    expect(curves(graph.rows.merge.segments)).toContainEqual({
      kind: "curve",
      fromLane: 1,
      toLane: 2,
      fromUnit: 50,
      toUnit: 100,
      hash: "unrelated-base",
      colourLane: 1,
    });
    expect(curves(graph.rows.merge.segments)).toContainEqual({
      kind: "curve",
      fromLane: 0,
      toLane: 1,
      fromUnit: 50,
      toUnit: 100,
      hash: "feature",
      colourLane: 0,
    });
    const unrelatedMove = curves(graph.rows.merge.segments).find(segment => segment.hash === "unrelated-base");
    expect(unrelatedMove?.colourLane).toBe(unrelatedMove?.fromLane);
  });

  it("keeps a gitk-like trunk with short side excursions", () => {
    const graph = buildCommitGraph(gitkComparisonCommits());

    expect([
      graph.rows.m350000.nodeLane,
      graph.rows.trunk01.nodeLane,
      graph.rows.trunk02.nodeLane,
      graph.rows.trunk03.nodeLane,
      graph.rows.trunk04.nodeLane,
      graph.rows.trunk05.nodeLane,
      graph.rows.main000.nodeLane,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0]);

    expect(graph.rows.branchB.nodeLane).toBe(1);
    expect(graph.rows.bot0001.nodeLane).toBe(1);
    expect(graph.rows.branchA.nodeLane).toBe(2);
    expect(graph.rows.msix001.nodeLane).toBe(2);
    expect(graph.rows.side001.nodeLane).toBe(1);
    expect(graph.rows.dep0001.nodeLane).toBe(1);
    expect(graph.rows.trunk05.laneCount).toBe(1);
    expect(verticals(graph.rows.trunk05.segments).filter(segment => segment.lane > 0)).toEqual([]);

    expect(curves(graph.rows.trunk01.segments)).toContainEqual({
      kind: "curve",
      fromLane: 1,
      toLane: 2,
      fromUnit: 50,
      toUnit: 100,
      hash: "branchA",
      colourLane: 1,
    });
    expect(verticals(graph.rows.trunk02.segments)).toContainEqual({
      kind: "vertical",
      lane: 2,
      fromUnit: 0,
      toUnit: 50,
      hash: "branchA",
      colourLane: 2,
    });
  });

  it("collapses an already-active shared first parent back onto the trunk", () => {
    const graph = buildCommitGraph([
      commit("5ad6049", ["91ff990", "b90460d"]),
      commit("b90460d", ["c89ff95"]),
      commit("c89ff95", ["774d89c"]),
      commit("91ff990", ["774d89c"]),
      commit("774d89c", ["73dd177"]),
      commit("73dd177"),
    ]);

    expect(graph.rows["91ff990"].nodeLane).toBe(0);
    expect(graph.rows.b90460d.nodeLane).toBe(1);
    expect(graph.rows.c89ff95.nodeLane).toBe(1);
    expect(graph.rows["774d89c"].nodeLane).toBe(0);
    expect(verticals(graph.rows["91ff990"].segments)).toContainEqual({
      kind: "vertical",
      lane: 1,
      fromUnit: 0,
      toUnit: 50,
      hash: "774d89c",
      colourLane: 1,
    });
    expect(curves(graph.rows["91ff990"].segments)).toContainEqual({
      kind: "curve",
      fromLane: 1,
      toLane: 0,
      fromUnit: 50,
      toUnit: 100,
      hash: "774d89c",
      colourLane: 1,
    });
  });

  it("does not start visible rails without previous-row continuity", () => {
    expectNoUnexplainedTopStarts(gitkComparisonCommits());
    expectNoUnexplainedTopStarts(allRefsComparisonCommits());
  });

  it("does not move an active trunk right for a side branch parent", () => {
    const graph = buildCommitGraph([
      commit("merge", ["main", "feature-2"]),
      commit("other-tip", ["other-base"]),
      commit("feature-2", ["feature-1"]),
      commit("feature-1", ["main"]),
      commit("main", ["base"]),
      commit("other-base"),
      commit("base"),
    ]);

    expect(graph.rows["feature-1"].nodeLane).toBe(1);
    expect(curves(graph.rows["feature-1"].segments)).toContainEqual({
      kind: "curve",
      fromLane: 1,
      toLane: 0,
      fromUnit: 50,
      toUnit: 100,
      hash: "main",
      colourLane: 0,
    });
    expect(graph.rows.main.nodeLane).toBe(0);
  });

  it("keeps sibling merge parents continuous until their shared parent", () => {
    const graph = buildCommitGraph([
      commit("merge", ["left", "right"]),
      commit("left", ["base"]),
      commit("right", ["base"]),
      commit("base"),
    ]);

    expect(verticals(graph.rows.left.segments)).toContainEqual({
      kind: "vertical",
      lane: 1,
      fromUnit: 50,
      toUnit: 100,
      hash: "right",
      colourLane: 1,
    });
    expect(verticals(graph.rows.right.segments)).toContainEqual({
      kind: "vertical",
      lane: 0,
      fromUnit: 0,
      toUnit: 50,
      hash: "base",
      colourLane: 0,
    });
  });

  it("caps visible lane count", () => {
    const graph = buildCommitGraph([
      commit("wide", ["a", "b", "c", "d"]),
    ], 3);

    expect(graph.visibleLaneCount).toBe(3);
    expect(graph.rows.wide.laneCount).toBe(4);
    expect(graph.rows.wide.heightUnits).toBe(3);
    expect(curves(graph.rows.wide.segments).map(segment => segment.toLane)).toEqual([1, 2, 3]);
    expect(curves(graph.rows.wide.segments).map(segment => segment.toUnit)).toEqual([300, 300, 300]);
  });
});
