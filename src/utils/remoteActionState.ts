import type { BranchInfo } from "../types";

export type RemoteActionKind = "push" | "publish" | "repair-upstream" | "detached";

export type RemoteActionState = {
  kind: RemoteActionKind;
  label: string;
  disabled: boolean;
  title?: string;
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
    return "Detached HEAD";
  }
  if (!currentBranchInfo || currentBranchInfo.isRemote) {
    return null;
  }
  if (currentBranchInfo.upstreamStatus === "none") {
    return "No upstream";
  }
  if (currentBranchInfo.upstreamStatus === "missing") {
    return "Upstream missing";
  }
  return currentBranchInfo.upstream ? `Tracking ${currentBranchInfo.upstream}` : "Tracking remote";
}

export function getRemoteActionState(
  currentBranch: string | null | undefined,
  currentBranchInfo: BranchInfo | null | undefined,
): RemoteActionState {
  if (isDetachedBranchName(currentBranch)) {
    return {
      kind: "detached",
      label: "Push",
      disabled: true,
      title: "Push is unavailable while HEAD is detached.",
    };
  }
  if (!currentBranchInfo || currentBranchInfo.isRemote) {
    return {
      kind: "push",
      label: "Push",
      disabled: false,
    };
  }
  if (currentBranchInfo.upstreamStatus === "none") {
    return {
      kind: "publish",
      label: "Publish",
      disabled: false,
    };
  }
  if (currentBranchInfo.upstreamStatus === "missing") {
    return {
      kind: "repair-upstream",
      label: "Repair Upstream",
      disabled: false,
      title: "The configured upstream branch is missing. Repair it before pushing.",
    };
  }
  return {
    kind: "push",
    label: "Push",
    disabled: false,
  };
}
