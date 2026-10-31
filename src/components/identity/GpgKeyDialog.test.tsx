// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GpgKeyDialog } from "./GpgKeyDialog";
import { cancelGpgSigningKeys, listGpgSigningKeys } from "../../api/commands";
import type { GpgSigningKey } from "../../types";
import "../../i18n";

vi.mock("../../api/commands", () => ({listGpgSigningKeys: vi.fn(), cancelGpgSigningKeys: vi.fn()}));
const keys: GpgSigningKey[] = [
  {fingerprint: "A".repeat(40), userIds: ["Work Identity <work@example.test>", "Secondary name"], expiresAt: null, hardwareBacked: false},
  {fingerprint: "B".repeat(40), userIds: ["Personal Identity <personal@example.test>"], expiresAt: 2000000000, hardwareBacked: true},
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listGpgSigningKeys).mockResolvedValue(keys);
  vi.mocked(cancelGpgSigningKeys).mockResolvedValue(undefined);
});

function renderDialog(currentKey: string | null = null) {
  const onCancel = vi.fn();
  const onUseKey = vi.fn();
  return {...render(<GpgKeyDialog repoPath="/repository" currentKey={currentKey} onCancel={onCancel} onUseKey={onUseKey}/>), onCancel, onUseKey};
}

describe("GpgKeyDialog", () => {
  it("shows key details and requires explicit selection", async () => {
    const {onUseKey} = renderDialog();
    await screen.findByText(keys[0].userIds[0]);
    expect(screen.getByRole("button", {name: "Use key"})).toBeDisabled();
    expect(screen.getByText("Primary key expiry: Never")).toBeInTheDocument();
    expect(screen.getByText("Hardware key available")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("button", {name: "Use key"}));
    expect(onUseKey).toHaveBeenCalledWith(keys[1].fingerprint);
  });

  it("preselects the current fingerprint and searches secondary identities and formatted fingerprints", async () => {
    renderDialog(keys[0].fingerprint.toLowerCase());
    await screen.findByText(keys[0].userIds[0]);
    expect(screen.getAllByRole("radio")[0]).toBeChecked();
    fireEvent.change(screen.getByRole("textbox"), {target: {value: "secondary"}});
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox"), {target: {value: "BBBB BBBB"}});
    expect(screen.getByText(keys[1].userIds[0])).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Use key"})).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), {target: {value: "unknown key"}});
    expect(screen.getByRole("status")).toHaveTextContent("No matching keys");
  });

  it("cancels pending backend work and ignores late results", async () => {
    let finish!: (value: GpgSigningKey[]) => void;
    vi.mocked(listGpgSigningKeys).mockReturnValue(new Promise(resolve => {finish = resolve;}));
    const {unmount} = renderDialog();
    expect(screen.getByRole("status")).toHaveTextContent("Loading signing keys");
    const requestId = vi.mocked(listGpgSigningKeys).mock.calls[0][1];
    unmount();
    expect(cancelGpgSigningKeys).toHaveBeenCalledWith(requestId);
    finish(keys);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([
    ["GITMUN_ERROR_GPG_UNAVAILABLE", "GPG is unavailable"],
    ["GITMUN_ERROR_GPG_LIST_TIMEOUT", "GPG took too long"],
    ["GITMUN_ERROR_GPG_LIST_FAILED", "Could not list GPG signing keys"],
  ])("localises %s and supports retry", async (error, message) => {
    vi.mocked(listGpgSigningKeys).mockRejectedValueOnce(new Error(error));
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    fireEvent.click(screen.getByRole("button", {name: "Retry"}));
    await screen.findByText(keys[0].userIds[0]);
    expect(listGpgSigningKeys).toHaveBeenCalledTimes(2);
  });

  it("shows an empty keyring and cancels with Escape", async () => {
    vi.mocked(listGpgSigningKeys).mockResolvedValue([]);
    const {onCancel} = renderDialog();
    expect(await screen.findByRole("status")).toHaveTextContent("No usable signing keys found");
    fireEvent.keyDown(screen.getByRole("textbox"), {key: "Escape"});
    expect(onCancel).toHaveBeenCalled();
  });

  it("focuses search, traps Tab and restores the initiating control", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const {unmount} = renderDialog(keys[0].fingerprint);
    await screen.findByText(keys[0].userIds[0]);
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("textbox"), {key: "Tab", shiftKey: true});
    expect(screen.getByRole("button", {name: "Use key"})).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", {name: "Use key"}), {key: "Tab"});
    expect(screen.getByRole("textbox")).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
