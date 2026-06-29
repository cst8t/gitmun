import { describe, expect, it } from "vitest";
import { buildMainWindowTitle, displayNameForRepoPath, repoNameFromPath } from "./repoDisplayName";

describe("repoDisplayName", () => {
  it("builds the main window title with a custom display name", () => {
    expect(buildMainWindowTitle("/home/conor/repos/gitmun", "Project Atlas"))
      .toBe("Project Atlas - /home/conor/repos/gitmun");
  });

  it("builds the main window title with the repository folder name", () => {
    expect(buildMainWindowTitle("/home/conor/repos/gitmun", null))
      .toBe("gitmun - /home/conor/repos/gitmun");
  });

  it("derives a repository name from a trailing slash path", () => {
    expect(repoNameFromPath("C:\\Users\\conor\\GitmunProjects\\gitmun\\")).toBe("gitmun");
  });

  it("uses a custom display name when one exists", () => {
    expect(displayNameForRepoPath("/home/conor/repos/gitmun", "Project Atlas")).toBe("Project Atlas");
  });

  it("falls back to a repository folder name without a custom display name", () => {
    expect(displayNameForRepoPath("/home/conor/repos/gitmun", null)).toBe("gitmun");
  });
});
