import type { CommitHistoryItem } from "../types";

export type CommitGraphLane = {
  lane: number;
  hash: string;
};

export type CommitGraphParent = CommitGraphLane & {
  sourceLane?: number;
};

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

export function buildCommitGraph(
  commits: CommitHistoryItem[],
  maxVisibleLanes = DEFAULT_MAX_VISIBLE_LANES,
): CommitGraph {
  const rows: Record<string, CommitGraphRow> = {};
  let activeLanes: string[] = [];
  let widestLane = 0;

  for (const commit of commits) {
    let commitLane = activeLanes.indexOf(commit.hash);
    const laneAlreadyActive = commitLane !== -1;
    const activeLaneByHash = new Map(activeLanes.map((hash, lane) => [hash, lane]));

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
    const parents = uniqueParents(commit.parentHashes);
    for (const [index, parent] of parents.entries()) {
      let parentLane = nextLanes.indexOf(parent);
      if (parentLane === -1) {
        parentLane = index === 0 ? Math.min(commitLane, nextLanes.length) : nextLanes.length;
        nextLanes.splice(parentLane, 0, parent);
      }
      const sourceLane = activeLaneByHash.get(parent);
      parentLanes.push({
        hash: parent,
        lane: parentLane,
        ...(sourceLane !== undefined && sourceLane !== parentLane ? { sourceLane } : {}),
      });
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
