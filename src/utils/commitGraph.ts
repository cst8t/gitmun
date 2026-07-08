import type { CommitHistoryItem } from "../types";

export type CommitGraphSegment =
  | {
      kind: "vertical";
      lane: number;
      fromUnit: number;
      toUnit: number;
      hash: string;
      colourLane: number;
    }
  | {
      kind: "curve";
      fromLane: number;
      toLane: number;
      fromUnit: number;
      toUnit: number;
      hash: string;
      colourLane: number;
    }
  | {
      kind: "node";
      lane: number;
      unit: number;
      hash: string;
      colourLane: number;
    };

export type CommitGraphRow = {
  hash: string;
  nodeLane: number;
  laneCount: number;
  heightUnits: number;
  segments: CommitGraphSegment[];
};

export type CommitGraph = {
  rows: Record<string, CommitGraphRow>;
  visibleLaneCount: number;
};

const DEFAULT_MAX_VISIBLE_LANES = 10;
const ROW_TOP = 0;
const ROW_CENTRE = 50;
const ROW_BOTTOM = 100;

type ActiveLane = string | null;

function uniqueParents(parents: string[]): string[] {
  const seen = new Set<string>();
  return parents.filter(parent => {
    if (seen.has(parent)) return false;
    seen.add(parent);
    return true;
  });
}

function addVertical(
  segments: CommitGraphSegment[],
  lane: number,
  fromUnit: number,
  toUnit: number,
  hash: string,
  colourLane = lane,
) {
  if (fromUnit === toUnit) return;
  segments.push({ kind: "vertical", lane, fromUnit, toUnit, hash, colourLane });
}

function addConnection(
  segments: CommitGraphSegment[],
  fromLane: number,
  toLane: number,
  fromUnit: number,
  toUnit: number,
  hash: string,
  colourLane = fromLane,
) {
  if (fromLane === toLane) {
    addVertical(segments, fromLane, fromUnit, toUnit, hash, colourLane);
    return;
  }
  segments.push({ kind: "curve", fromLane, toLane, fromUnit, toUnit, hash, colourLane });
}

function placeHashInLane(lanes: ActiveLane[], hash: string, targetLane: number): number {
  const currentLane = lanes.indexOf(hash);
  if (currentLane !== -1) {
    lanes[currentLane] = null;
  }

  while (lanes.length < targetLane) {
    lanes.push(null);
  }

  if (targetLane === lanes.length || lanes[targetLane] === null) {
    lanes[targetLane] = hash;
    return targetLane;
  }

  lanes.splice(targetLane, 0, hash);
  return targetLane;
}

function compactLanes(lanes: ActiveLane[]): ActiveLane[] {
  return lanes.filter(hash => hash !== null);
}

export function buildCommitGraph(
  commits: CommitHistoryItem[],
  maxVisibleLanes = DEFAULT_MAX_VISIBLE_LANES,
): CommitGraph {
  const rows: Record<string, CommitGraphRow> = {};
  let activeLanes: ActiveLane[] = [];
  let widestLane = 0;

  for (const commit of commits) {
    let nodeLane = activeLanes.indexOf(commit.hash);
    const laneAlreadyActive = nodeLane !== -1;
    const activeLaneByHash = new Map<string, number>();
    for (const [lane, hash] of activeLanes.entries()) {
      if (hash !== null) {
        activeLaneByHash.set(hash, lane);
      }
    }

    if (!laneAlreadyActive) {
      nodeLane = activeLanes.length;
      activeLanes = [...activeLanes, commit.hash];
    }

    const nextLanes = [...activeLanes];
    nextLanes[nodeLane] = null;

    const parents = uniqueParents(commit.parentHashes);
    const heightUnits = Math.max(1, parents.length - 1);
    const rowBottom = heightUnits * ROW_BOTTOM;
    const parentLaneByHash = new Map<string, number>();
    let previousParentLane = Math.min(nodeLane, nextLanes.length);
    for (const [index, parent] of parents.entries()) {
      const currentParentLane = nextLanes.indexOf(parent);
      let parentLane = currentParentLane;
      if (index === 0 && parentLane !== -1 && parentLane > nodeLane) {
        parentLane = placeHashInLane(nextLanes, parent, nodeLane);
      } else if (parentLane === -1) {
        const targetLane = index === 0
          ? nodeLane
          : previousParentLane + 1;
        parentLane = placeHashInLane(nextLanes, parent, targetLane);
      }
      previousParentLane = parentLane;
      parentLaneByHash.set(parent, parentLane);
    }
    const compactedNextLanes = compactLanes(nextLanes);
    nextLanes.splice(0, nextLanes.length, ...compactedNextLanes);
    parentLaneByHash.clear();
    for (const parent of parents) {
      const parentLane = nextLanes.indexOf(parent);
      if (parentLane !== -1) {
        parentLaneByHash.set(parent, parentLane);
      }
    }

    const segments: CommitGraphSegment[] = [];
    for (const [lane, hash] of activeLanes.entries()) {
      if (hash === null) continue;
      if (!laneAlreadyActive && lane === nodeLane) continue;
      addVertical(segments, lane, ROW_TOP, ROW_CENTRE, hash);
    }

    const parentHashes = new Set(parentLaneByHash.keys());
    const connectedBottomLaneKeys = new Set<string>();

    for (const parent of parents) {
      const parentLane = parentLaneByHash.get(parent);
      if (parentLane === undefined) continue;

      const sourceLane = activeLaneByHash.get(parent);
      if (sourceLane !== undefined && sourceLane !== parentLane) {
        addConnection(segments, sourceLane, parentLane, ROW_CENTRE, rowBottom, parent);
        connectedBottomLaneKeys.add(`${parentLane}:${parent}`);
        if (parentLane !== nodeLane) {
          addConnection(segments, nodeLane, parentLane, ROW_CENTRE, rowBottom, parent, parentLane);
        }
      } else if (sourceLane !== undefined && parentLane !== nodeLane) {
        addConnection(segments, nodeLane, parentLane, ROW_CENTRE, rowBottom, parent, parentLane);
        connectedBottomLaneKeys.add(`${parentLane}:${parent}`);
      } else {
        addConnection(segments, nodeLane, parentLane, ROW_CENTRE, rowBottom, parent);
        connectedBottomLaneKeys.add(`${parentLane}:${parent}`);
      }
    }

    const bottomLaneByHash = new Map<string, number>();
    for (const [lane, hash] of nextLanes.entries()) {
      if (hash !== null) {
        bottomLaneByHash.set(hash, lane);
      }
    }
    for (const [hash, sourceLane] of activeLaneByHash) {
      if (hash === commit.hash || parentHashes.has(hash)) continue;
      const targetLane = bottomLaneByHash.get(hash);
      if (targetLane === undefined || targetLane === sourceLane) continue;
      addConnection(segments, sourceLane, targetLane, ROW_CENTRE, rowBottom, hash);
      connectedBottomLaneKeys.add(`${targetLane}:${hash}`);
    }

    for (const [lane, hash] of nextLanes.entries()) {
      if (hash === null) continue;
      if (connectedBottomLaneKeys.has(`${lane}:${hash}`)) continue;
      addVertical(segments, lane, ROW_CENTRE, rowBottom, hash);
    }

    segments.push({
      kind: "node",
      lane: nodeLane,
      unit: ROW_CENTRE,
      hash: commit.hash,
      colourLane: nodeLane,
    });

    const rowWidestLane = Math.max(
      nodeLane,
      ...activeLanes.map((_, lane) => lane),
      ...nextLanes.map((_, lane) => lane),
      ...segments.flatMap(segment => {
        if (segment.kind === "curve") return [segment.fromLane, segment.toLane];
        return [segment.lane];
      }),
    );
    widestLane = Math.max(widestLane, rowWidestLane);

    rows[commit.hash] = {
      hash: commit.hash,
      nodeLane,
      laneCount: Math.max(1, rowWidestLane + 1),
      heightUnits,
      segments,
    };

    while (nextLanes[nextLanes.length - 1] === null) {
      nextLanes.pop();
    }
    activeLanes = nextLanes;
  }

  return {
    rows,
    visibleLaneCount: Math.max(1, Math.min(maxVisibleLanes, widestLane + 1)),
  };
}
