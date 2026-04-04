import { useCallback, useState } from "react";
import * as api from "../api/commands";
import type { AvailableUpdate, UpdateDownloadEvent } from "../types";

const DISMISSED_UPDATE_VERSION_KEY = "gitmun.dismissedUpdateVersion";

export type UpdateDialogPhase = "prompt" | "downloading" | "installing" | "success";

export type UpdateDialogState = {
  open: boolean;
  update: AvailableUpdate | null;
  phase: UpdateDialogPhase;
  errorMessage: string | null;
  dontShowAgain: boolean;
  downloadedBytes: number;
  contentLength: number | null;
};

function readDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY);
  } catch {
    return null;
  }
}

function writeDismissedVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, version);
  } catch {
  }
}

function createClosedState(): UpdateDialogState {
  return {
    open: false,
    update: null,
    phase: "prompt",
    errorMessage: null,
    dontShowAgain: false,
    downloadedBytes: 0,
    contentLength: null,
  };
}

export function useUpdateFlow() {
  const [checking, setChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [dialog, setDialog] = useState<UpdateDialogState>(createClosedState);

  const openPrompt = useCallback((update: AvailableUpdate) => {
    setDialog({
      open: true,
      update,
      phase: "prompt",
      errorMessage: null,
      dontShowAgain: false,
      downloadedBytes: 0,
      contentLength: null,
    });
  }, []);

  const showUpdatePrompt = useCallback((update: AvailableUpdate) => {
    openPrompt(update);
    setStatusMessage(`Update ${update.version} is available.`);
  }, [openPrompt]);

  const checkForUpdates = useCallback(async (options?: {
    silentIfNoUpdate?: boolean;
    respectDismissedVersion?: boolean;
  }): Promise<AvailableUpdate | null> => {
    const { silentIfNoUpdate = false, respectDismissedVersion = false } = options ?? {};
    setChecking(true);
    try {
      const updaterSupported = await api.isUpdaterEnabled();
      if (!updaterSupported) {
        if (!silentIfNoUpdate) {
          setStatusMessage("Updates are managed by this platform package channel.");
        }
        return null;
      }

      const update = await api.checkForAppUpdate();
      if (!update) {
        if (!silentIfNoUpdate) {
          setStatusMessage("You're already running the latest version.");
        }
        return null;
      }

      if (respectDismissedVersion && readDismissedVersion() === update.version) {
        return update;
      }

      showUpdatePrompt(update);
      return update;
    } catch (error) {
      const message = `Update check failed: ${String(error)}`;
      if (!silentIfNoUpdate) {
        setStatusMessage(message);
      }
      return null;
    } finally {
      setChecking(false);
    }
  }, [openPrompt]);

  const checkForUpdatesOnLaunch = useCallback(async () => {
    await checkForUpdates({silentIfNoUpdate: true, respectDismissedVersion: true});
  }, [checkForUpdates]);

  const handleDownloadEvent = useCallback((event: UpdateDownloadEvent) => {
    setDialog((current) => {
      if (!current.update) {
        return current;
      }

      switch (event.event) {
        case "Started":
          return {
            ...current,
            phase: "downloading",
            errorMessage: null,
            downloadedBytes: 0,
            contentLength: event.data.contentLength ?? null,
          };
        case "Progress":
          return {
            ...current,
            phase: "downloading",
            downloadedBytes: current.downloadedBytes + event.data.chunkLength,
          };
        case "Finished":
          return {
            ...current,
            phase: "installing",
            downloadedBytes: current.contentLength ?? current.downloadedBytes,
          };
      }
    });
  }, []);

  const installUpdate = useCallback(async () => {
    const update = dialog.update;
    if (!update) {
      return;
    }

    setDialog((current) => current.update ? {
      ...current,
      phase: "downloading",
      errorMessage: null,
      downloadedBytes: 0,
      contentLength: null,
    } : current);

    try {
      await api.downloadAndInstallAppUpdateWithProgress(handleDownloadEvent, update.version);
      setDialog((current) => current.update ? {
        ...current,
        phase: "success",
        errorMessage: null,
        downloadedBytes: current.contentLength ?? current.downloadedBytes,
      } : current);
      setStatusMessage("Update installed. Restart Gitmun to finish applying it.");
    } catch (error) {
      const message = `Update failed: ${String(error)}`;
      setDialog((current) => current.update ? {
        ...current,
        phase: "prompt",
        errorMessage: message,
      } : current);
      setStatusMessage(message);
    }
  }, [dialog.update, handleDownloadEvent]);

  const closeDialog = useCallback(() => {
    setDialog((current) => {
      if (current.update && current.dontShowAgain) {
        writeDismissedVersion(current.update.version);
      }
      return createClosedState();
    });
  }, []);

  const remindLater = useCallback(() => {
    setDialog(createClosedState());
  }, []);

  const setDontShowAgain = useCallback((value: boolean) => {
    setDialog((current) => ({...current, dontShowAgain: value}));
  }, []);

  return {
    checking,
    statusMessage,
    dialog,
    checkForUpdates,
    checkForUpdatesOnLaunch,
    showUpdatePrompt,
    installUpdate,
    closeDialog,
    remindLater,
    setDontShowAgain,
    setStatusMessage,
  };
}
