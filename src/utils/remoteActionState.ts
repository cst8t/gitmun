import type { BranchInfo } from "../types";

export type RemoteActionKind = "push" | "publish" | "repair-upstream" | "detached";

export type RemoteActionState = {
  kind: RemoteActionKind;
  disabled: boolean;
};

export function isDetachedBranchName(branchName: string | null | undefined): boolean {
  return Boolean(branchName && branchName.startsWith("detached@"));
}

export function splitUpstreamRef(upstream: string | null | undefined): { remote: string; branch: string } | null {
  if (!upstream) {
    return null;
  }

  const slashIndex = upstream.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= upstream.length - 1) {
    return null;
  }

  return {
    remote: upstream.slice(0, slashIndex),
    branch: upstream.slice(slashIndex + 1),
  };
}

export function getUpstreamStatusLabel(
  currentBranch: string | null | undefined,
  currentBranchInfo: BranchInfo | null | undefined,
): string | null {
  if (isDetachedBranchName(currentBranch)) {
    return "branches.detachedHead";
  }
  if (!currentBranchInfo || currentBranchInfo.isRemote) {
    return null;
  }
  if (currentBranchInfo.upstreamStatus === "none") {
    return "branches.noUpstream";
  }
  if (currentBranchInfo.upstreamStatus === "missing") {
    return "branches.upstreamMissing";
  }
  return currentBranchInfo.upstream ? "branches.tracking" : "branches.trackingRemote";
}

export function getRemoteActionState(
  currentBranch: string | null | undefined,
  currentBranchInfo: BranchInfo | null | undefined,
): RemoteActionState {
  if (isDetachedBranchName(currentBranch)) {
    return {
      kind: "detached",
      disabled: true,
    };
  }
  if (!currentBranchInfo || currentBranchInfo.isRemote) {
    return {
      kind: "push",
      disabled: false,
    };
  }
  if (currentBranchInfo.upstreamStatus === "none") {
    return {
      kind: "publish",
      disabled: false,
    };
  }
  if (currentBranchInfo.upstreamStatus === "missing") {
    return {
      kind: "repair-upstream",
      disabled: false,
    };
  }
  return {
    kind: "push",
    disabled: false,
  };
}
