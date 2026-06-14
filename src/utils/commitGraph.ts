import type { CommitHistoryItem } from "../types";

export type CommitGraphLane = {
  lane: number;
  hash: string;
};

export type CommitGraphParent = CommitGraphLane;

export type CommitGraphRow = {
  hash: string;
  commitLane: number;
  topLanes: CommitGraphLane[];
  bottomLanes: CommitGraphLane[];
  parentLanes: CommitGraphParent[];
};

export type CommitGraph = {
  rows: Record<string, CommitGraphRow>;
  visibleLaneCount: number;
};

const DEFAULT_MAX_VISIBLE_LANES = 10;

function laneItems(lanes: string[]): CommitGraphLane[] {
  return lanes.map((hash, lane) => ({ hash, lane }));
}

function uniqueParents(parents: string[]): string[] {
  const seen = new Set<string>();
  return parents.filter(parent => {
    if (seen.has(parent)) return false;
    seen.add(parent);
    return true;
  });
}

function orderParentsByVisiblePosition(
  parents: string[],
  commitIndexes: Map<string, number>,
): string[] {
  return parents
    .map((parent, index) => ({
      parent,
      index,
      commitIndex: commitIndexes.get(parent) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.commitIndex - b.commitIndex || a.index - b.index)
    .map(item => item.parent);
}

export function buildCommitGraph(
  commits: CommitHistoryItem[],
  maxVisibleLanes = DEFAULT_MAX_VISIBLE_LANES,
): CommitGraph {
  const rows: Record<string, CommitGraphRow> = {};
  const commitIndexes = new Map(commits.map((commit, index) => [commit.hash, index]));
  let activeLanes: string[] = [];
  let widestLane = 0;

  for (const commit of commits) {
    let commitLane = activeLanes.indexOf(commit.hash);
    const laneAlreadyActive = commitLane !== -1;

    if (!laneAlreadyActive) {
      commitLane = activeLanes.length;
      activeLanes = [...activeLanes, commit.hash];
    }

    const topLanes = laneItems(activeLanes).filter(lane => (
      laneAlreadyActive || lane.lane !== commitLane
    ));
    const nextLanes = [...activeLanes];
    nextLanes.splice(commitLane, 1);

    const parentLanes: CommitGraphParent[] = [];
    const parents = orderParentsByVisiblePosition(uniqueParents(commit.parentHashes), commitIndexes);
    for (const [index, parent] of parents.entries()) {
      let parentLane = nextLanes.indexOf(parent);
      if (parentLane === -1) {
        parentLane = index === 0 ? Math.min(commitLane, nextLanes.length) : nextLanes.length;
        nextLanes.splice(parentLane, 0, parent);
      }
      parentLanes.push({ hash: parent, lane: parentLane });
    }

    const bottomLanes = laneItems(nextLanes);
    widestLane = Math.max(
      widestLane,
      commitLane,
      ...topLanes.map(lane => lane.lane),
      ...bottomLanes.map(lane => lane.lane),
      ...parentLanes.map(lane => lane.lane),
    );

    rows[commit.hash] = {
      hash: commit.hash,
      commitLane,
      topLanes,
      bottomLanes,
      parentLanes,
    };

    activeLanes = nextLanes;
  }

  return {
    rows,
    visibleLaneCount: Math.max(1, Math.min(maxVisibleLanes, widestLane + 1)),
  };
}
