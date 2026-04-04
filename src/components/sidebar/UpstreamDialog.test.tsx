// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpstreamDialog } from "./UpstreamDialog";
import type { BranchInfo, RemoteInfo } from "../../types";

const remotes: RemoteInfo[] = [
  { name: "origin", url: "git@example.com:repo.git" },
  { name: "upstream", url: "git@example.com:upstream.git" },
];

const remoteBranches: BranchInfo[] = [
  { name: "origin/feature/demo", isCurrent: false, isRemote: true, upstream: null, upstreamStatus: "none", ahead: 0, behind: 0 },
  { name: "upstream/main", isCurrent: false, isRemote: true, upstream: null, upstreamStatus: "none", ahead: 0, behind: 0 },
];

describe("UpstreamDialog", () => {
  it("defaults the only remote and branch name for publish", () => {
    render(
      <UpstreamDialog
        mode="publish"
        branchName="feature/demo"
        remotes={[remotes[0]]}
        remoteBranches={remoteBranches}
        initialUpstream={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Remote")).toHaveValue("origin");
    expect(screen.getByLabelText("Remote branch")).toHaveValue("feature/demo");
    expect(screen.getByRole("button", { name: "Publish Branch" })).toBeEnabled();
  });

  it("requires remote selection when multiple remotes exist", () => {
    render(
      <UpstreamDialog
        mode="publish"
        branchName="feature/demo"
        remotes={remotes}
        remoteBranches={remoteBranches}
        initialUpstream={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Remote")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Publish Branch" })).toBeDisabled();
  });

  it("uses mode-specific confirm text and submits the chosen target", () => {
    const onConfirm = vi.fn();
    render(
      <UpstreamDialog
        mode="repair"
        branchName="feature/demo"
        remotes={remotes}
        remoteBranches={remoteBranches}
        initialUpstream="origin/feature/demo"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Remote branch"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Repair Upstream" }));

    expect(onConfirm).toHaveBeenCalledWith({
      remote: "origin",
      remoteBranch: "main",
    });
  });
});
