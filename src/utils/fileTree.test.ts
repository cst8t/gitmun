import { describe, expect, it } from "vitest";
import type { FileStatusItem } from "../types";
import { buildFileTree, descendantFilePaths } from "./fileTree";

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
            name: "graphics",
            path: "marine-lab/reports/sonar",
            children: [
              {
                type: "directory",
                name: "100/en/symbols",
                path: "marine-lab/reports/sonar/2026/atlantic",
              },
              {
                type: "directory",
                name: "50/en/symbols",
                path: "marine-lab/reports/sonar/2025/atlantic",
              },
            ],
          },
          {
            type: "directory",
            name: "scenes/default",
            path: "marine-lab/reports/observations/current",
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
