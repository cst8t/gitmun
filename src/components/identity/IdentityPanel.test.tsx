// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityPanel } from "./IdentityPanel";
import type { GitIdentity } from "../../types";
import "../../i18n";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
  emit: vi.fn(),
  getSshAllowedSignerStatus: vi.fn(),
  addSshSigningKeyToAllowedSigners: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: mocks.ask,
  message: mocks.message,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
}));

vi.mock("../../api/commands", () => ({
  getSshAllowedSignerStatus: mocks.getSshAllowedSignerStatus,
  addSshSigningKeyToAllowedSigners: mocks.addSshSigningKeyToAllowedSigners,
}));

const identity: GitIdentity = {
  name: "Gitmun Test",
  email: "test@gitmun.test",
  signingKey: "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test@gitmun.test",
  signingFormat: "ssh",
  sshKeyPath: null,
  commitSigningEnabled: true,
};

function renderPanel(options: {
  repoPath?: string | null;
  onSaveLocalIdentity?: (payload: Partial<GitIdentity>) => Promise<void>;
  onRefreshLocalIdentity?: () => Promise<void>;
} = {}) {
  return render(
    <IdentityPanel
      open
      repoPath={options.repoPath ?? "C:\\repo"}
      onClose={vi.fn()}
      localIdentity={identity}
      globalIdentity={null}
      onSaveLocalIdentity={options.onSaveLocalIdentity ?? vi.fn(async () => {})}
      onRefreshLocalIdentity={options.onRefreshLocalIdentity ?? vi.fn(async () => {})}
    />,
  );
}

async function saveLocalIdentity() {
  fireEvent.click(screen.getByRole("button", {name: /Edit/i}));
  fireEvent.click(screen.getByRole("button", {name: "Save"}));
  await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
}

describe("IdentityPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSshAllowedSignerStatus.mockResolvedValue({
      setupNeeded: false,
      targetPath: null,
      blockingReason: null,
      allowedSignersConfigured: false,
      allowedSignersExists: false,
      signingKeyPresent: true,
      signingKeyTrusted: true,
      resolvedPublicKeyFingerprint: null,
      reason: "trusted",
    });
    mocks.addSshSigningKeyToAllowedSigners.mockResolvedValue({
      message: "Added",
      backendUsed: "git-cli",
    });
    mocks.ask.mockResolvedValue(false);
    mocks.message.mockResolvedValue("Ok");
    mocks.emit.mockResolvedValue(undefined);
  });

  it("prompts to add SSH signing keys to allowed signers after save", async () => {
    const onRefreshLocalIdentity = vi.fn(async () => {});
    mocks.getSshAllowedSignerStatus.mockResolvedValue({
      setupNeeded: true,
      targetPath: "C:\\repo\\.git\\gitmun_allowed_signers",
      blockingReason: null,
      allowedSignersConfigured: false,
      allowedSignersExists: false,
      signingKeyPresent: true,
      signingKeyTrusted: false,
      resolvedPublicKeyFingerprint: null,
      reason: "untrustedSigningKey",
    });
    mocks.ask.mockResolvedValue(true);
    renderPanel({onRefreshLocalIdentity});

    await saveLocalIdentity();

    await waitFor(() => {
      expect(mocks.ask).toHaveBeenCalledWith(
        expect.stringContaining("C:\\repo\\.git\\gitmun_allowed_signers"),
        expect.objectContaining({okLabel: "Add to allowed signers", cancelLabel: "Not now"}),
      );
      expect(mocks.addSshSigningKeyToAllowedSigners).toHaveBeenCalledWith("C:\\repo", "Local");
      expect(onRefreshLocalIdentity).toHaveBeenCalled();
      expect(mocks.emit).toHaveBeenCalledWith("signature-settings-updated");
    });
  });

  it("does not prompt when allowed signers already contain the key", async () => {
    renderPanel();

    await saveLocalIdentity();

    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.addSshSigningKeyToAllowedSigners).not.toHaveBeenCalled();
  });

  it("shows allowed signers path and file state", async () => {
    mocks.getSshAllowedSignerStatus.mockResolvedValue({
      setupNeeded: true,
      targetPath: "C:\\repo\\.git\\gitmun_allowed_signers",
      blockingReason: null,
      allowedSignersConfigured: true,
      allowedSignersExists: false,
      signingKeyPresent: true,
      signingKeyTrusted: false,
      resolvedPublicKeyFingerprint: null,
      reason: "missingAllowedSignersFile",
    });

    renderPanel();

    expect(await screen.findByText("C:\\repo\\.git\\gitmun_allowed_signers")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.getByText("Exists")).toBeInTheDocument();
    expect(screen.getByText("Key trusted")).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Add to allowed signers"})).toBeInTheDocument();
  });

  it("adds allowed signer from the status section", async () => {
    mocks.getSshAllowedSignerStatus.mockResolvedValue({
      setupNeeded: true,
      targetPath: "C:\\repo\\.git\\gitmun_allowed_signers",
      blockingReason: null,
      allowedSignersConfigured: false,
      allowedSignersExists: false,
      signingKeyPresent: true,
      signingKeyTrusted: false,
      resolvedPublicKeyFingerprint: null,
      reason: "untrustedSigningKey",
    });
    const onRefreshLocalIdentity = vi.fn(async () => {});
    renderPanel({onRefreshLocalIdentity});

    fireEvent.click(await screen.findByRole("button", {name: "Add to allowed signers"}));

    await waitFor(() => {
      expect(mocks.addSshSigningKeyToAllowedSigners).toHaveBeenCalledWith("C:\\repo", "Local");
      expect(onRefreshLocalIdentity).toHaveBeenCalled();
      expect(mocks.emit).toHaveBeenCalledWith("signature-settings-updated");
    });
  });

  it("does not update settings when the user cancels the prompt", async () => {
    mocks.getSshAllowedSignerStatus.mockResolvedValue({
      setupNeeded: true,
      targetPath: "C:\\repo\\.git\\gitmun_allowed_signers",
      blockingReason: null,
      allowedSignersConfigured: false,
      allowedSignersExists: false,
      signingKeyPresent: true,
      signingKeyTrusted: false,
      resolvedPublicKeyFingerprint: null,
      reason: "untrustedSigningKey",
    });
    mocks.ask.mockResolvedValue(false);
    renderPanel();

    await saveLocalIdentity();

    expect(mocks.ask).toHaveBeenCalled();
    expect(mocks.addSshSigningKeyToAllowedSigners).not.toHaveBeenCalled();
  });

  it("shows blocking status messages", async () => {
    mocks.getSshAllowedSignerStatus.mockResolvedValue({
      setupNeeded: false,
      targetPath: null,
      blockingReason: "GITMUN_ERROR_SSH_ALLOWED_SIGNERS_MISSING_EMAIL",
      allowedSignersConfigured: false,
      allowedSignersExists: false,
      signingKeyPresent: true,
      signingKeyTrusted: false,
      resolvedPublicKeyFingerprint: null,
      reason: "missingEmail",
    });
    renderPanel();

    await saveLocalIdentity();

    expect(mocks.message).toHaveBeenCalledWith(
      "Configure user.email before adding an allowed signer.",
      expect.objectContaining({kind: "error"}),
    );
  });
});
