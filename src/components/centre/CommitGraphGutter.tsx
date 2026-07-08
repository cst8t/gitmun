import { useTranslation } from "react-i18next";
import type { CommitHistoryItem } from "../../types";
import type { CommitGraphRow, CommitGraphSegment } from "../../utils/commitGraph";

const GRAPH_LANE_WIDTH = 12;
const GRAPH_NODE_RADIUS = 4;
const GRAPH_UNIT_HEIGHT = 100;

function graphLaneColour(lane: number): string {
  const colours = [
    "var(--accent)",
    "var(--green)",
    "var(--yellow)",
    "var(--red)",
    "#c4b5fd",
    "#6ee7b7",
    "#f0abfc",
    "#93c5fd",
  ];
  return colours[lane % colours.length];
}

function graphWidth(laneCount: number): number {
  return Math.max(14, laneCount * GRAPH_LANE_WIDTH);
}

function graphX(lane: number, laneCount: number): number {
  return 5 + Math.min(lane, laneCount - 1) * GRAPH_LANE_WIDTH;
}

function graphPieceClass(baseClass: string, active: boolean | null): string {
  if (active === null) return baseClass;
  return `${baseClass} ${active ? "log-view__graph-piece--active" : "log-view__graph-piece--dimmed"}`;
}

function formatGraphNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function graphCurvePath(
  fromLane: number,
  toLane: number,
  fromUnit: number,
  toUnit: number,
  laneCount: number,
): string {
  const fromX = graphX(fromLane, laneCount);
  const toX = graphX(toLane, laneCount);
  const verticalDistance = toUnit - fromUnit;
  const controlY1 = fromUnit + verticalDistance * 0.44;
  const controlY2 = fromUnit + verticalDistance * 0.56;
  return [
    `M ${formatGraphNumber(fromX)} ${formatGraphNumber(fromUnit)}`,
    `C ${formatGraphNumber(fromX)} ${formatGraphNumber(controlY1)}`,
    `${formatGraphNumber(toX)} ${formatGraphNumber(controlY2)}`,
    `${formatGraphNumber(toX)} ${formatGraphNumber(toUnit)}`,
  ].join(" ");
}

function graphVerticalPath(lane: number, fromUnit: number, toUnit: number, laneCount: number): string {
  const x = graphX(lane, laneCount);
  return `M ${formatGraphNumber(x)} ${formatGraphNumber(fromUnit)} L ${formatGraphNumber(x)} ${formatGraphNumber(toUnit)}`;
}

function graphTitle(
  commit: CommitHistoryItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const lines = [
    t("log.graphCommit", { hash: commit.shortHash }),
    t("log.graphLaneHint"),
  ];
  const firstParent = commit.parentHashes[0];
  const mergedParents = commit.parentHashes.slice(1);
  if (firstParent) {
    lines.push(t("log.graphFirstParent", { hash: firstParent.slice(0, 7) }));
  }
  if (mergedParents.length > 0) {
    lines.push(t("log.graphMergedParents", { hashes: mergedParents.map(hash => hash.slice(0, 7)).join(", ") }));
  }
  if (commit.refDecorations.length > 0) {
    lines.push(t("log.graphRefs", { refs: commit.refDecorations.map(ref => ref.name).join(", ") }));
  }
  return lines.join("\n");
}

function segmentKey(segment: CommitGraphSegment, index: number): string {
  if (segment.kind === "curve") {
    return `${index}-curve-${segment.fromLane}-${segment.toLane}-${segment.hash}`;
  }
  return `${index}-${segment.kind}-${segment.lane}-${segment.hash}`;
}

function graphGradientId(commitHash: string, segment: CommitGraphSegment, index: number): string {
  const key = segmentKey(segment, index).replace(/[^A-Za-z0-9_-]/g, "_");
  return `graph-gradient-${commitHash.slice(0, 12)}-${key}`;
}

export function CommitGraphGutter({
  row,
  laneCount,
  commit,
  highlightedHashes,
}: {
  row: CommitGraphRow | undefined;
  laneCount: number;
  commit: CommitHistoryItem;
  highlightedHashes: Set<string> | null;
}) {
  const { t } = useTranslation("centre");
  const width = graphWidth(laneCount);
  if (!row) {
    return <div className="log-view__graph" style={{ width }} aria-hidden="true" />;
  }

  const graphTitleText = graphTitle(commit, t);
  const hasHighlight = highlightedHashes !== null;
  const isActiveHash = (hash: string): boolean | null => {
    if (!highlightedHashes) return null;
    return highlightedHashes.has(hash);
  };
  const viewBoxHeight = row.heightUnits * GRAPH_UNIT_HEIGHT;
  const curves = row.segments.filter(segment => segment.kind === "curve");
  const verticals = row.segments.filter(segment => segment.kind === "vertical");
  const nodes = row.segments.filter(segment => segment.kind === "node");
  const curveStroke = (segment: typeof curves[number], index: number): string => (
    segment.fromLane === segment.toLane
      ? graphLaneColour(segment.colourLane)
      : `url(#${graphGradientId(commit.hash, segment, index)})`
  );

  return (
    <div
      className="log-view__graph"
      style={{
        width,
        minHeight: row.heightUnits > 1 ? `${row.heightUnits * 56}px` : undefined,
      }}
      title={graphTitleText}
      aria-label={graphTitleText}
    >
      <svg className="log-view__graph-connectors" width={width} height="100%" viewBox={`0 0 ${width} ${viewBoxHeight}`} preserveAspectRatio="none">
        <defs>
          {curves.map((segment, index) => (
            <linearGradient
              key={graphGradientId(commit.hash, segment, index)}
              id={graphGradientId(commit.hash, segment, index)}
              gradientUnits="userSpaceOnUse"
              x1={graphX(segment.fromLane, laneCount)}
              y1={segment.fromUnit}
              x2={graphX(segment.toLane, laneCount)}
              y2={segment.toUnit}
            >
              <stop offset="0%" stopColor={graphLaneColour(segment.fromLane)} />
              <stop offset="100%" stopColor={graphLaneColour(segment.toLane)} />
            </linearGradient>
          ))}
        </defs>
        {curves.map((segment, index) => (
          <path
            key={segmentKey(segment, index)}
            d={graphCurvePath(segment.fromLane, segment.toLane, segment.fromUnit, segment.toUnit, laneCount)}
            stroke={curveStroke(segment, index)}
            className={graphPieceClass("log-view__graph-connector log-view__graph-connector--curve", isActiveHash(segment.hash))}
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
        ))}
        {verticals.map((segment, index) => (
          <path
            key={segmentKey(segment, index)}
            d={graphVerticalPath(segment.lane, segment.fromUnit, segment.toUnit, laneCount)}
            stroke={graphLaneColour(segment.colourLane)}
            className={graphPieceClass("log-view__graph-connector log-view__graph-connector--vertical", isActiveHash(segment.hash))}
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
        ))}
      </svg>
      {nodes.map((segment, index) => (
        <span
          key={segmentKey(segment, index)}
          className={graphPieceClass("log-view__graph-node", hasHighlight ? highlightedHashes.has(segment.hash) : null)}
          style={{
            left: graphX(segment.lane, laneCount) - GRAPH_NODE_RADIUS,
            top: `calc(${(segment.unit / viewBoxHeight) * 100}% - ${GRAPH_NODE_RADIUS}px)`,
            width: GRAPH_NODE_RADIUS * 2,
            height: GRAPH_NODE_RADIUS * 2,
            background: graphLaneColour(segment.colourLane),
          }}
        />
      ))}
    </div>
  );
}
