import { describe, expect, it } from "vitest";
import type { FileStatusItem } from "../types";
import {
  AUTO_COLLAPSE_SECTION_THRESHOLD,
  buildFileTree,
  descendantFilePaths,
  visibleFileTreeRows,
} from "./fileTree";

function file(path: string, additions: number | null = null, deletions: number | null = null): FileStatusItem {
  return {
    path,
    status: "modified",
    additions,
    deletions,
  };
}

function directory(path: string): FileStatusItem {
  return {
    path,
    status: "new",
    additions: null,
    deletions: null,
    kind: "directory",
  };
}

describe("buildFileTree", () => {
  it("groups files by shared folders", () => {
    const tree = buildFileTree([
      file("src/components/Button.tsx", 3, 1),
      file("src/components/Input.tsx", 2, 0),
      file("src/index.ts", 1, 1),
    ]);

    expect(tree).toMatchObject([
      {
        type: "directory",
        name: "src",
        path: "src",
        fileCount: 3,
        additions: 6,
        deletions: 2,
        children: [
          {
            type: "directory",
            name: "components",
            path: "src/components",
            fileCount: 2,
            additions: 5,
            deletions: 1,
          },
          {
            type: "file",
            name: "index.ts",
            path: "src/index.ts",
          },
        ],
      },
    ]);
  });

  it("sorts folders before files alphabetically within each level", () => {
    const tree = buildFileTree([
      file("z-root.ts"),
      file("beta/file.ts"),
      file("alpha/file.ts"),
      file("a-root.ts"),
    ]);

    expect(tree.map(node => node.name)).toEqual(["alpha", "beta", "a-root.ts", "z-root.ts"]);
  });

  it("handles root files beside folders", () => {
    const tree = buildFileTree([
      file("README.md"),
      file("src/App.tsx"),
    ]);

    expect(tree).toMatchObject([
      { type: "directory", name: "src" },
      { type: "file", name: "README.md", path: "README.md" },
    ]);
  });

  it("compacts uninterrupted single-directory chains", () => {
    const tree = buildFileTree([
      file("marine-lab/reports/sonar/2026/atlantic/beam_profile.csv", 3, 1),
    ]);

    expect(tree).toMatchObject([
      {
        type: "directory",
        name: "marine-lab/reports/sonar/2026/atlantic",
        path: "marine-lab/reports/sonar/2026/atlantic",
        fileCount: 1,
        additions: 3,
        deletions: 1,
        children: [
          {
            type: "file",
            name: "beam_profile.csv",
          },
        ],
      },
    ]);
  });

  it("compacts single-directory chains below a branch", () => {
    const tree = buildFileTree([
      file("marine-lab/reports/sonar/2026/atlantic/beam_profile.csv"),
      file("marine-lab/reports/sonar/2025/atlantic/beam_profile.csv"),
      file("marine-lab/reports/observations/current/plankton-baseline.json"),
    ]);

    expect(tree).toMatchObject([
      {
        type: "directory",
        name: "marine-lab/reports",
        path: "marine-lab/reports",
        children: [
          {
            type: "directory",
            name: "observations/current",
            path: "marine-lab/reports/observations/current",
          },
          {
            type: "directory",
            name: "sonar",
            path: "marine-lab/reports/sonar",
            children: [
              {
                type: "directory",
                name: "2025/atlantic",
                path: "marine-lab/reports/sonar/2025/atlantic",
              },
              {
                type: "directory",
                name: "2026/atlantic",
                path: "marine-lab/reports/sonar/2026/atlantic",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("does not compact directories containing files and directories", () => {
    const tree = buildFileTree([
      file("src/index.ts"),
      file("src/components/forms/Input.tsx"),
    ]);

    expect(tree).toMatchObject([
      {
        type: "directory",
        name: "src",
        path: "src",
        children: [
          {
            type: "directory",
            name: "components/forms",
            path: "src/components/forms",
          },
          {
            type: "file",
            name: "index.ts",
          },
        ],
      },
    ]);
  });

  it("keeps separation through caller-provided buckets", () => {
    const staged = buildFileTree([file("src/app.ts")]);
    const unstaged = buildFileTree([file("src/app.ts"), file("src/theme.css")]);

    expect(staged).toMatchObject([{ type: "directory", fileCount: 1 }]);
    expect(unstaged).toMatchObject([{ type: "directory", fileCount: 2 }]);
  });

  it("returns descendant paths for nested folders", () => {
    const [directory] = buildFileTree([
      file("src/App.tsx"),
      file("src/components/Button.tsx"),
    ]);

    expect(directory.type).toBe("directory");
    if (directory.type !== "directory") return;

    expect(descendantFilePaths(directory)).toEqual([
      "src/components/Button.tsx",
      "src/App.tsx",
    ]);
  });

  it("creates a directory node for a directory-kind untracked entry with no children", () => {
    const tree = buildFileTree([directory("drafts")]);

    expect(tree).toMatchObject([
      {
        type: "directory",
        name: "drafts",
        path: "drafts",
        selectablePath: "drafts",
        status: "new",
        fileCount: 1,
        children: [],
      },
    ]);
  });

  it("returns the directory path for selectable directory nodes", () => {
    const [node] = buildFileTree([directory("drafts")]);

    expect(node.type).toBe("directory");
    if (node.type !== "directory") return;

    expect(descendantFilePaths(node)).toEqual(["drafts"]);
  });
});

describe("visibleFileTreeRows", () => {
  const folderKey = (path: string) => path;

  function rowSummary(rows: ReturnType<typeof visibleFileTreeRows>) {
    return rows.map((row) =>
      row.type === "directory"
        ? { type: row.type, name: row.node.name, depth: row.depth, expanded: row.expanded }
        : { type: row.type, name: row.node.name, depth: row.depth, fileIndex: row.fileIndex },
    );
  }

  it("shows compact folders and nested basenames", () => {
    const files = [
      file("src/components/Button.tsx"),
      file("src/components/Icon.tsx"),
    ];
    const rows = visibleFileTreeRows(buildFileTree(files), {}, files.length, folderKey);

    expect(rowSummary(rows)).toEqual([
      { type: "directory", name: "src/components", depth: 0, expanded: true },
      { type: "file", name: "Button.tsx", depth: 1, fileIndex: 0 },
      { type: "file", name: "Icon.tsx", depth: 1, fileIndex: 1 },
    ]);
  });

  it("hides descendants when a folder is collapsed", () => {
    const files = [
      file("src/components/Button.tsx"),
      file("src/components/Icon.tsx"),
      file("README.md"),
    ];
    const rows = visibleFileTreeRows(
      buildFileTree(files),
      { "src/components": false },
      files.length,
      folderKey,
    );

    expect(rowSummary(rows)).toEqual([
      { type: "directory", name: "src/components", depth: 0, expanded: false },
      { type: "file", name: "README.md", depth: 0, fileIndex: 0 },
    ]);
  });

  it("auto-collapses top-level folders when the tree has more than 500 files", () => {
    const files = Array.from({ length: AUTO_COLLAPSE_SECTION_THRESHOLD + 1 }, (_, index) =>
      file(`marine-lab/samples/sample-${String(index).padStart(4, "0")}.csv`),
    );
    const rows = visibleFileTreeRows(buildFileTree(files), {}, files.length, folderKey);

    expect(rowSummary(rows)).toEqual([
      { type: "directory", name: "marine-lab/samples", depth: 0, expanded: false },
    ]);
  });

  it("keeps small nested folders expanded in large trees", () => {
    const nested = [
      file("marine-lab/reports/current/plankton.json"),
      file("marine-lab/reports/current/salinity.json"),
    ];
    const topLevel = Array.from({ length: AUTO_COLLAPSE_SECTION_THRESHOLD }, (_, index) =>
      file(`marine-lab/samples/sample-${String(index).padStart(4, "0")}.csv`),
    );
    const files = [...topLevel, ...nested];
    const rows = visibleFileTreeRows(
      buildFileTree(files),
      { "marine-lab": true },
      files.length,
      folderKey,
    );

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "directory",
        expanded: true,
        node: expect.objectContaining({ name: "reports/current" }),
      }),
      expect.objectContaining({
        type: "file",
        node: expect.objectContaining({ name: "plankton.json" }),
      }),
    ]));
  });
});
