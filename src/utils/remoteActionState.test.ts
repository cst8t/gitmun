import { describe, expect, it } from "vitest";
import type { BranchInfo } from "../types";
import { getRemoteActionState, getUpstreamStatusLabel, splitUpstreamRef } from "./remoteActionState";

function makeBranch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name: "feature/demo",
    isCurrent: true,
    isRemote: false,
    upstream: "origin/feature/demo",
    upstreamStatus: "tracked",
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

describe("getRemoteActionState", () => {
  it("returns publish for branches without an upstream", () => {
    expect(getRemoteActionState("feature/demo", makeBranch({ upstream: null, upstreamStatus: "none" }))).toMatchObject({
      kind: "publish",
      label: "Publish",
      disabled: false,
    });
  });

  it("returns push for tracked branches", () => {
    expect(getRemoteActionState("feature/demo", makeBranch())).toMatchObject({
      kind: "push",
      label: "Push",
      disabled: false,
    });
  });

  it("returns repair for missing upstreams", () => {
    expect(getRemoteActionState("feature/demo", makeBranch({ upstreamStatus: "missing" }))).toMatchObject({
      kind: "repair-upstream",
      label: "Repair Upstream",
      disabled: false,
    });
  });

  it("disables detached head", () => {
    expect(getRemoteActionState("detached@abc1234", null)).toMatchObject({
      kind: "detached",
      label: "Push",
      disabled: true,
    });
  });
});

describe("getUpstreamStatusLabel", () => {
  it("describes tracked branches", () => {
    expect(getUpstreamStatusLabel("feature/demo", makeBranch())).toBe("Tracking origin/feature/demo");
  });

  it("describes no upstream", () => {
    expect(getUpstreamStatusLabel("feature/demo", makeBranch({ upstream: null, upstreamStatus: "none" }))).toBe("No upstream");
  });

  it("describes missing upstream", () => {
    expect(getUpstreamStatusLabel("feature/demo", makeBranch({ upstreamStatus: "missing" }))).toBe("Upstream missing");
  });
});

describe("splitUpstreamRef", () => {
  it("splits remote and branch", () => {
    expect(splitUpstreamRef("origin/feature/demo")).toEqual({
      remote: "origin",
      branch: "feature/demo",
    });
  });

  it("returns null for missing upstream", () => {
    expect(splitUpstreamRef(null)).toBeNull();
  });
});
