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
});
