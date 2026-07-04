import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/commands";
import type {
  AppAvailableUpdate,
  AvailableUpdate,
  MicrosoftStoreUpdate,
  UpdateDownloadEvent,
} from "../types";

const DISMISSED_UPDATE_VERSION_KEY = "gitmun.dismissedUpdateVersion";

export type UpdateDialogPhase =
  | "prompt"
  | "downloading"
  | "installing"
  | "success"
  | "storeOpened"
  | "storeError";

export type UpdateDialogState = {
  open: boolean;
  update: AppAvailableUpdate | null;
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

function releaseUpdate(update: AvailableUpdate): AppAvailableUpdate {
  return {...update, source: "selfManaged"};
}

function microsoftStoreUpdate(update: MicrosoftStoreUpdate): AppAvailableUpdate {
  return {...update, source: "microsoftStore"};
}

function dismissedVersionKey(update: AppAvailableUpdate): string {
  return update.source === "selfManaged"
    ? `self-managed:${update.version}`
    : `microsoft-store:${update.currentVersion}`;
}

function isDismissedUpdate(update: AppAvailableUpdate): boolean {
  const dismissedVersion = readDismissedVersion();
  return dismissedVersion === dismissedVersionKey(update)
    || (update.source === "selfManaged" && dismissedVersion === update.version);
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
  const { t } = useTranslation("update");
  const [checking, setChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [dialog, setDialog] = useState<UpdateDialogState>(createClosedState);

  const openPrompt = useCallback((update: AppAvailableUpdate) => {
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

  const showUpdatePrompt = useCallback((update: AppAvailableUpdate) => {
    openPrompt(update);
    setStatusMessage(update.source === "selfManaged"
      ? t("status.updateAvailable", { version: update.version })
      : t("status.storeUpdateAvailable"));
  }, [openPrompt, t]);

  const checkForUpdates = useCallback(async (options?: {
    silentIfNoUpdate?: boolean;
    respectDismissedVersion?: boolean;
  }): Promise<AppAvailableUpdate | null> => {
    const { silentIfNoUpdate = false, respectDismissedVersion = false } = options ?? {};
    setChecking(true);
    try {
      const updateChannel = await api.getAppUpdateChannel();
      if (updateChannel === "SystemManaged") {
        if (!silentIfNoUpdate) {
          setStatusMessage(t("status.managed"));
        }
        return null;
      }

      const update = updateChannel === "MicrosoftStore"
        ? await api.checkMicrosoftStoreUpdate().then((storeUpdate) => storeUpdate ? microsoftStoreUpdate(storeUpdate) : null)
        : await api.checkForAppUpdate().then((availableUpdate) => availableUpdate ? releaseUpdate(availableUpdate) : null);
      if (!update) {
        if (!silentIfNoUpdate) {
          setStatusMessage(updateChannel === "MicrosoftStore"
            ? t("status.latestMicrosoftStore")
            : t("status.latest"));
        }
        return null;
      }

      if (respectDismissedVersion && isDismissedUpdate(update)) {
        return update;
      }

      showUpdatePrompt(update);
      return update;
    } catch (error) {
      const message = t("status.checkFailed", { message: String(error) });
      if (!silentIfNoUpdate) {
        setStatusMessage(message);
      }
      return null;
    } finally {
      setChecking(false);
    }
  }, [showUpdatePrompt, t]);

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

    if (update.source === "microsoftStore") {
      try {
        await api.openMicrosoftStoreUpdatePage();
        setDialog((current) => current.update ? {
          ...current,
          phase: "storeOpened",
          errorMessage: null,
        } : current);
        setStatusMessage(t("status.storeOpened"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setDialog((current) => current.update ? {
          ...current,
          phase: "storeError",
          errorMessage: message,
        } : current);
        setStatusMessage(t("status.storeFailed", { message }));
      }
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
      setStatusMessage(t("status.installed"));
    } catch (error) {
      const message = t("status.failed", { message: String(error) });
      setDialog((current) => current.update ? {
        ...current,
        phase: "prompt",
        errorMessage: message,
      } : current);
      setStatusMessage(message);
    }
  }, [
    dialog.update,
    handleDownloadEvent,
    t,
  ]);

  const closeDialog = useCallback(() => {
    setDialog((current) => {
      if (current.update && current.dontShowAgain) {
        writeDismissedVersion(dismissedVersionKey(current.update));
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
