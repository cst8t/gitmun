// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityPanel } from "./IdentityPanel";
import type { GitIdentity, IdentityChanges } from "../../types";
import "../../i18n";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  openDialog: vi.fn(),
  message: vi.fn(),
  emit: vi.fn(),
  getSshAllowedSignerStatus: vi.fn(),
  getIdentitySigningContext: vi.fn(),
  importSshPublicKey: vi.fn(),
  listGpgSigningKeys: vi.fn(),
  cancelGpgSigningKeys: vi.fn(),
  addSshSigningKeyToAllowedSigners: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: mocks.ask,
  open: mocks.openDialog,
  message: mocks.message,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
}));

vi.mock("../../api/commands", () => ({
  getSshAllowedSignerStatus: mocks.getSshAllowedSignerStatus,
  getIdentitySigningContext: mocks.getIdentitySigningContext,
  importSshPublicKey: mocks.importSshPublicKey,
  listGpgSigningKeys: mocks.listGpgSigningKeys,
  cancelGpgSigningKeys: mocks.cancelGpgSigningKeys,
  addSshSigningKeyToAllowedSigners: mocks.addSshSigningKeyToAllowedSigners,
}));

beforeEach(() => {
  mocks.getIdentitySigningContext.mockImplementation(() => new Promise(() => {}));
  mocks.importSshPublicKey.mockReset();
  mocks.listGpgSigningKeys.mockResolvedValue([]);
  mocks.cancelGpgSigningKeys.mockResolvedValue(undefined);
});

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
  localIdentity?: GitIdentity;
  globalIdentity?: GitIdentity | null;
  onClose?: () => void;
  onSaveLocalIdentity?: (payload: IdentityChanges) => Promise<void>;
  onRefreshLocalIdentity?: () => Promise<void>;
} = {}) {
  return render(
    <IdentityPanel
      open
      repoPath={options.repoPath ?? "C:\\repo"}
      onClose={options.onClose ?? vi.fn()}
      localIdentity={options.localIdentity ?? identity}
      globalIdentity={options.globalIdentity ?? null}
      onSaveLocalIdentity={options.onSaveLocalIdentity ?? vi.fn(async () => {})}
      onRefreshLocalIdentity={options.onRefreshLocalIdentity ?? vi.fn(async () => {})}
    />,
  );
}

async function saveLocalIdentity() {
  fireEvent.click(screen.getByRole("button", {name: /Edit/i}));
  fireEvent.change(screen.getByLabelText("user.signingkey"), {target: {value: "key::ssh-ed25519 UpdatedKey"}});
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

const emptyIdentity: GitIdentity = {
  name: null, email: null, signingKey: null,
  signingFormat: null, sshKeyPath: null, commitSigningEnabled: null,
};

describe("repository identity overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSshAllowedSignerStatus.mockResolvedValue({setupNeeded: false});
    mocks.emit.mockResolvedValue(undefined);
  });

  it("stages all removals until Save and skips SSH trust setup", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({onSaveLocalIdentity: onSave});
    await screen.findByText("user.name");
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Clear Repository Overrides"}));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("user.name")).toHaveValue("");
    expect(screen.getByRole("combobox", {name: "Commit Signing"})).toHaveValue("inherit");
    mocks.getSshAllowedSignerStatus.mockClear();
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledWith({clearFields: ["name", "email", "signingFormat", "signingKey", "sshKeyPath", "commitSigningEnabled"]});
    expect(mocks.getSshAllowedSignerStatus).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.addSshSigningKeyToAllowedSigners).not.toHaveBeenCalled();
  });

  it("Cancel discards a staged reset", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Clear Repository Overrides"}));
    fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByLabelText("user.name")).toHaveValue(identity.name);
    expect(onSave).not.toHaveBeenCalled();
    await screen.findByRole("button", {name: "Save"});
  });

  it("removes individual fields and retains unrelated values", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Use inherited setting for user.email"}));
    fireEvent.change(screen.getByLabelText("user.name"), {target: {value: "Work Identity"}});
    fireEvent.change(screen.getByRole("combobox", {name: "Commit Signing"}), {target: {value: "inherit"}});
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({name: "Work Identity", clearFields: ["email", "commitSigningEnabled"]}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("treats an empty text field as a removal", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.change(screen.getByLabelText("user.name"), {target: {value: "  "}});
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({clearFields: ["name"]}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
  });

  it("does not introduce signing when editing identity or signing details", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({localIdentity: {...emptyIdentity, name: "Local"}, onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.change(screen.getByLabelText("user.name"), {target: {value: "Changed"}});
    fireEvent.change(screen.getByLabelText("user.email"), {target: {value: "changed@example.test"}});
    fireEvent.change(screen.getByLabelText("user.signingkey"), {target: {value: "ABC123"}});
    fireEvent.change(screen.getByLabelText("Format"), {target: {value: "openpgp"}});
    fireEvent.change(screen.getByLabelText("gpg.ssh.allowedSignersFile"), {target: {value: "/repo/signers"}});
    expect(screen.getByRole("combobox", {name: "Commit Signing"})).toHaveValue("inherit");
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({name: "Changed", email: "changed@example.test", signingKey: "ABC123", signingFormat: "openpgp", sshKeyPath: "/repo/signers"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
  });

  it.each([true, false])("saves explicit signing %s independently", async enabled => {
    const onSave = vi.fn(async () => {});
    renderPanel({localIdentity: {...emptyIdentity, name: "Local"}, onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.change(screen.getByRole("combobox", {name: "Commit Signing"}), {target: {value: String(enabled)}});
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({commitSigningEnabled: enabled}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
  });

  it("does not write any settings when saving an unchanged identity", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("can clear an existing empty text override", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({localIdentity: {...emptyIdentity, name: ""}, onSaveLocalIdentity: onSave});
    expect(screen.getByText("override")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Use inherited setting for user.name"}));
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({clearFields: ["name"]}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
  });

  it("counts disabled signing as a repository override", async () => {
    renderPanel({localIdentity: {...emptyIdentity, commitSigningEnabled: false}, globalIdentity: identity});
    expect(screen.getByText("override")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText(".git/config")).toBeInTheDocument();
  });

  it("shows absent values without an override badge", () => {
    renderPanel({localIdentity: emptyIdentity});
    expect(screen.getAllByText("No repository override")).toHaveLength(6);
    expect(screen.queryByText("override")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Global"}));
    expect(screen.getAllByText("Not configured")).toHaveLength(6);
  });

  it("discards drafts when switching scope or dismissing", async () => {
    const onClose = vi.fn();
    renderPanel({onClose, globalIdentity: {...identity, name: "Global Identity"}});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Clear Repository Overrides"}));
    fireEvent.click(screen.getByRole("button", {name: "Global"}));
    expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Repository"}));
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByLabelText("user.name")).toHaveValue(identity.name);
    fireEvent.click(screen.getByRole("button", {name: "Close"}));
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByLabelText("user.name")).toHaveValue(identity.name);
    await screen.findByRole("button", {name: "Save"});
  });

  it("retains the draft after a failed save and allows retry", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("GITMUN_ERROR_IDENTITY_SAVE_FAILED")).mockResolvedValueOnce(undefined);
    renderPanel({onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Clear Repository Overrides"}));
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save all identity changes");
    expect(screen.getByLabelText("user.name")).toHaveValue("");
    expect(mocks.ask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("blocks scope changes, dismissal and duplicate saves while pending", async () => {
    let completeSave!: () => void;
    const onClose = vi.fn();
    const onSave = vi.fn(() => new Promise<void>(resolve => {completeSave = resolve;}));
    renderPanel({onClose, onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Clear Repository Overrides"}));
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    expect(screen.getByRole("button", {name: "Saving..."})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Global"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Close"})).toBeDisabled();
    fireEvent.click(document.querySelector(".identity-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    completeSave();
    await waitFor(() => expect(screen.queryByRole("button", {name: "Saving..."})).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("allowed signers file picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openDialog.mockReset().mockResolvedValue(null);
    mocks.getSshAllowedSignerStatus.mockResolvedValue({setupNeeded: false});
  });

  it("stages the selected portal path until Save without enabling signing", async () => {
    const selectedPath = "/run/user/1000/doc/identity-signers/allowed_signers";
    mocks.openDialog.mockResolvedValue(selectedPath);
    const onSave = vi.fn(async () => {});
    renderPanel({
      localIdentity: {...identity, sshKeyPath: "/repository/current-signers", commitSigningEnabled: null},
      onSaveLocalIdentity: onSave,
    });
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Browse for allowed signers file"}));
    await waitFor(() => expect(screen.getByLabelText("gpg.ssh.allowedSignersFile")).toHaveValue(selectedPath));
    expect(mocks.openDialog).toHaveBeenCalledWith({directory: false, multiple: false, title: "Select allowed signers file", defaultPath: "/repository/current-signers"});
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", {name: "Commit Signing"})).toHaveValue("inherit");
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledWith({sshKeyPath: selectedPath});
  });

  it("leaves the draft unchanged when the picker is cancelled", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.change(screen.getByLabelText("gpg.ssh.allowedSignersFile"), {target: {value: "/repository/manual-signers"}});
    fireEvent.click(screen.getByRole("button", {name: "Browse for allowed signers file"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Browse for allowed signers file"})).toBeEnabled());
    expect(screen.getByLabelText("gpg.ssh.allowedSignersFile")).toHaveValue("/repository/manual-signers");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("discards a picked path when editing is cancelled", async () => {
    mocks.openDialog.mockResolvedValue("/repository/selected-signers");
    const onSave = vi.fn(async () => {});
    renderPanel({onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Browse for allowed signers file"}));
    await waitFor(() => expect(screen.getByLabelText("gpg.ssh.allowedSignersFile")).toHaveValue("/repository/selected-signers"));
    fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByLabelText("gpg.ssh.allowedSignersFile")).toHaveValue("");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a localised picker failure and keeps manual entry available", async () => {
    mocks.openDialog.mockRejectedValue(new Error("native dialog unavailable"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Browse for allowed signers file"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open the allowed signers file picker");
    expect(screen.getByLabelText("gpg.ssh.allowedSignersFile")).toBeEnabled();
    expect(screen.getByRole("button", {name: "Browse for allowed signers file"})).toBeEnabled();
  });

  it("blocks conflicting edits while the native picker is open", async () => {
    let closePicker!: (value: null) => void;
    mocks.openDialog.mockReturnValue(new Promise<null>(resolve => {closePicker = resolve;}));
    const onClose = vi.fn();
    renderPanel({onClose});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Browse for allowed signers file"}));
    expect(screen.getByRole("button", {name: "Browse for allowed signers file"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Save"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Global"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Close"})).toBeDisabled();
    expect(screen.getByLabelText("gpg.ssh.allowedSignersFile")).toBeDisabled();
    fireEvent.click(document.querySelector(".identity-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    closePicker(null);
    await waitFor(() => expect(screen.getByRole("button", {name: "Save"})).toBeEnabled());
  });

  it("offers the same picker on the global tab", async () => {
    mocks.openDialog.mockResolvedValue("/global/selected-signers");
    renderPanel({globalIdentity: {...identity, sshKeyPath: "/global/current-signers"}});
    fireEvent.click(screen.getByRole("button", {name: "Global"}));
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Browse for allowed signers file"}));
    await waitFor(() => expect(screen.getByLabelText("gpg.ssh.allowedSignersFile")).toHaveValue("/global/selected-signers"));
    expect(mocks.openDialog).toHaveBeenCalledWith(expect.objectContaining({defaultPath: "/global/current-signers"}));
  });
});


describe("signing key helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openDialog.mockReset().mockResolvedValue(null);
    mocks.getSshAllowedSignerStatus.mockResolvedValue({setupNeeded: false});
  });

  it.each(["Repository", "Global"])("imports an SSH public key into the %s draft only", async scope => {
    mocks.getIdentitySigningContext.mockResolvedValue({format: "ssh"});
    const selected = "/run/user/1000/doc/public-key/signing.pub";
    const key = "key::ssh-ed25519 ImportedPublicKey";
    mocks.openDialog.mockResolvedValue(selected);
    mocks.importSshPublicKey.mockResolvedValue(key);
    const onSave = vi.fn(async () => {});
    render(<IdentityPanel open repoPath="/repo" onClose={vi.fn()} localIdentity={{...identity, signingFormat: null, commitSigningEnabled: false}} globalIdentity={{...identity, signingFormat: null, commitSigningEnabled: false}} onSaveLocalIdentity={onSave} onSaveGlobalIdentity={onSave} />);
    fireEvent.click(screen.getByRole("button", {name: scope}));
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(await screen.findByRole("button", {name: "Import public key…"}));
    await waitFor(() => expect(screen.getByLabelText("user.signingkey")).toHaveValue(key));
    expect(mocks.importSshPublicKey).toHaveBeenCalledWith(selected);
    expect(mocks.openDialog).toHaveBeenCalledWith(expect.objectContaining({filters: [{name: "Public key files", extensions: ["pub"]}, {name: "All files", extensions: ["*"]}]}));
    expect(screen.getByText("Matching private key must be available in your SSH agent.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", {name: "Commit Signing"})).toHaveValue("false");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({signingKey: key}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
  });

  it("keeps the draft when SSH import fails or the picker is cancelled", async () => {
    mocks.getIdentitySigningContext.mockResolvedValue({format: "ssh"});
    renderPanel();
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    const helper = await screen.findByRole("button", {name: "Import public key…"});
    fireEvent.click(helper);
    await waitFor(() => expect(helper).toBeEnabled());
    expect(mocks.importSshPublicKey).not.toHaveBeenCalled();
    mocks.openDialog.mockResolvedValue("/private-key");
    mocks.importSshPublicKey.mockRejectedValue("GITMUN_ERROR_SSH_KEY_PRIVATE");
    fireEvent.click(helper);
    expect(await screen.findByRole("alert")).toHaveTextContent("This file contains a private key");
    expect(screen.getByLabelText("user.signingkey")).toHaveValue(identity.signingKey);
    expect(screen.getByLabelText("user.signingkey")).toBeEnabled();
  });

  it("blocks edits during import and discards a response after changing repository", async () => {
    mocks.getIdentitySigningContext.mockResolvedValue({format: "ssh"});
    mocks.openDialog.mockResolvedValue("/public-key.pub");
    let completeImport!: (key: string) => void;
    mocks.importSshPublicKey.mockReturnValue(new Promise<string>(resolve => {completeImport = resolve;}));
    const props = {open: true, repoPath: "/repo", onClose: vi.fn(), localIdentity: identity, globalIdentity: null};
    const view = render(<IdentityPanel {...props} />);
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(await screen.findByRole("button", {name: "Import public key…"}));
    await waitFor(() => expect(mocks.importSshPublicKey).toHaveBeenCalled());
    expect(screen.getByRole("button", {name: "Save"})).toBeDisabled();
    expect(screen.getByLabelText("Format")).toBeDisabled();
    view.rerender(<IdentityPanel {...props} repoPath="/other-repo" />);
    await act(async () => {completeImport("key::ssh-ed25519 Stale");});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByLabelText("user.signingkey")).toHaveValue(identity.signingKey);
    await screen.findByRole("button", {name: "Import public key…"});
  });

  it("selects a GPG fingerprint without changing format or signing and Cancel discards it", async () => {
    mocks.getIdentitySigningContext.mockResolvedValue({format: "openpgp"});
    const fingerprint = "A".repeat(40);
    mocks.listGpgSigningKeys.mockResolvedValue([{fingerprint, userIds: ["Work <work@example.test>"], expiresAt: null, hardwareBacked: false}]);
    const onSave = vi.fn(async () => {});
    renderPanel({localIdentity: {...identity, signingFormat: null, commitSigningEnabled: null}, onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(await screen.findByRole("button", {name: "Choose key…"}));
    fireEvent.click(await screen.findByRole("radio"));
    fireEvent.click(screen.getByRole("button", {name: "Use key"}));
    expect(screen.getByLabelText("user.signingkey")).toHaveValue(fingerprint);
    expect(screen.getByLabelText("Format")).toHaveValue("");
    expect(screen.getByRole("combobox", {name: "Commit Signing"})).toHaveValue("inherit");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByLabelText("user.signingkey")).toHaveValue(identity.signingKey);
    await screen.findByRole("button", {name: "Choose key…"});
  });

  it("resolves the format after a staged removal and ignores stale format responses", async () => {
    let completeInitial!: (context: {format: string}) => void;
    mocks.getIdentitySigningContext.mockReturnValueOnce(new Promise(resolve => {completeInitial = resolve;})).mockResolvedValue({format: "openpgp"});
    renderPanel();
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.click(screen.getByRole("button", {name: "Use inherited setting for Format"}));
    await screen.findByRole("button", {name: "Choose key…"});
    expect(mocks.getIdentitySigningContext).toHaveBeenLastCalledWith({repoPath: "C:\\repo", scope: "Local", signingFormat: null, clearSigningFormat: true});
    await act(async () => {completeInitial({format: "ssh"});});
    expect(screen.queryByRole("button", {name: "Import public key…"})).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Choose key…"})).toBeInTheDocument();
    const fields = Array.from(document.querySelectorAll(".identity-detail__input"));
    expect(fields.indexOf(screen.getByLabelText("Format"))).toBeLessThan(fields.indexOf(screen.getByLabelText("user.signingkey")));
  });

  it.each(["x509", "custom"])("keeps manual entry for %s format", async format => {
    mocks.getIdentitySigningContext.mockResolvedValue({format});
    renderPanel();
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    await waitFor(() => expect(screen.queryByText("Detecting signing format…")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", {name: "Choose key…"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Import public key…"})).not.toBeInTheDocument();
    expect(screen.getByLabelText("user.signingkey")).toBeEnabled();
  });

  it("keeps manual entry when signing context cannot be resolved", async () => {
    mocks.getIdentitySigningContext.mockRejectedValue("GITMUN_ERROR_IDENTITY_SIGNING_CONTEXT_FAILED");
    renderPanel();
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(await screen.findByText("Could not detect the signing format. You can still enter the key manually.")).toBeInTheDocument();
    expect(screen.getByLabelText("user.signingkey")).toBeEnabled();
  });
});


describe("signing format dropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSshAllowedSignerStatus.mockResolvedValue({setupNeeded: false});
    mocks.getIdentitySigningContext.mockImplementation(async request => ({format: request.clearSigningFormat ? "openpgp" : request.signingFormat ?? "ssh"}));
  });

  it.each(["Repository", "Global"])("offers supported formats and stages removal in %s mode", async scope => {
    const onSave = vi.fn(async () => {});
    render(<IdentityPanel open repoPath="/repo" onClose={vi.fn()} localIdentity={identity} globalIdentity={identity} onSaveLocalIdentity={onSave} onSaveGlobalIdentity={onSave} />);
    fireEvent.click(screen.getByRole("button", {name: scope}));
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    const format = screen.getByRole("combobox", {name: "Format"});
    expect(Array.from(format.querySelectorAll("option"), option => option.textContent)).toEqual([
      scope === "Repository" ? "Use inherited setting" : "Not configured", "OpenPGP (GPG)", "SSH", "X.509",
    ]);
    fireEvent.change(format, {target: {value: ""}});
    expect(await screen.findByRole("button", {name: "Choose key…"})).toBeEnabled();
    expect(screen.getByLabelText("user.signingkey")).toHaveValue(identity.signingKey);
    expect(screen.getByRole("combobox", {name: "Commit Signing"})).toHaveValue("true");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledWith({clearFields: ["signingFormat"]});
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it.each(["openpgp", "ssh", "x509"])("saves only the selected %s format and shows the matching helper", async selected => {
    const onSave = vi.fn(async () => {});
    renderPanel({localIdentity: {...identity, signingFormat: null, commitSigningEnabled: false}, onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.change(screen.getByRole("combobox", {name: "Format"}), {target: {value: selected}});
    await waitFor(() => expect(screen.queryByText("Detecting signing format…")).not.toBeInTheDocument());
    expect(!!screen.queryByRole("button", {name: "Import public key…"})).toBe(selected === "ssh");
    expect(!!screen.queryByRole("button", {name: "Choose key…"})).toBe(selected === "openpgp");
    expect(screen.getByLabelText("user.signingkey")).toHaveValue(identity.signingKey);
    expect(screen.getByRole("combobox", {name: "Commit Signing"})).toHaveValue("false");
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledWith({signingFormat: selected});
  });

  it("preserves an unknown existing format on unchanged Save and removes its option after selection", async () => {
    const onSave = vi.fn(async () => {});
    mocks.getIdentitySigningContext.mockResolvedValue({format: "future-format"});
    renderPanel({localIdentity: {...identity, signingFormat: "future-format"}, onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByRole("combobox", {name: "Format"})).toHaveValue("future-format");
    expect(screen.getByRole("option", {name: "Current value: future-format"})).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Detecting signing format…")).not.toBeInTheDocument());
    expect(screen.getByLabelText("user.signingkey")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    fireEvent.change(screen.getByRole("combobox", {name: "Format"}), {target: {value: "openpgp"}});
    expect(screen.queryByRole("option", {name: "Current value: future-format"})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByRole("combobox", {name: "Format"})).toHaveValue("future-format");
    await waitFor(() => expect(screen.queryByText("Detecting signing format…")).not.toBeInTheDocument());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps inherited format absent on unchanged Save", async () => {
    const onSave = vi.fn(async () => {});
    renderPanel({localIdentity: {...identity, signingFormat: null}, onSaveLocalIdentity: onSave});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    expect(screen.getByRole("combobox", {name: "Format"})).toHaveValue("");
    await screen.findByRole("button", {name: "Import public key…"});
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    await waitFor(() => expect(screen.queryByRole("button", {name: "Save"})).not.toBeInTheDocument());
    expect(onSave).not.toHaveBeenCalled();
  });
});
