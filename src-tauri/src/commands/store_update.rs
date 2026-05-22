use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftStoreUpdate {
    current_version: String,
    package_count: u32,
    mandatory: bool,
    queue_status: Option<MicrosoftStoreQueueStatus>,
}

#[derive(Clone, Debug, Serialize)]
pub enum MicrosoftStoreUpdateStatus {
    Completed,
    Canceled,
    OtherError,
    ErrorLowBattery,
    ErrorWifiRecommended,
    ErrorWifiRequired,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
pub enum MicrosoftStoreQueueState {
    Active,
    Paused,
    Completed,
    Canceled,
    Error,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftStoreUpdateProgress {
    package_download_progress: f64,
    total_download_progress: f64,
    package_bytes_downloaded: u64,
    package_download_size_in_bytes: u64,
    package_update_state: MicrosoftStoreUpdateStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftStoreQueueStatus {
    state: MicrosoftStoreQueueState,
    extended_state: String,
    progress: Option<MicrosoftStoreUpdateProgress>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum MicrosoftStoreUpdateEvent {
    #[serde(rename = "Progress")]
    Progress(MicrosoftStoreUpdateProgress),
    #[serde(rename = "QueueStatus")]
    QueueStatus(MicrosoftStoreQueueStatus),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftStoreUpdateResult {
    status: MicrosoftStoreUpdateStatus,
    queue_status: Option<MicrosoftStoreQueueStatus>,
}

#[cfg(any(debug_assertions, test))]
const LOCAL_TEST_ENV: &str = "GITMUN_TEST_MICROSOFT_STORE_UPDATE";

#[cfg(any(debug_assertions, test))]
pub fn is_local_test_enabled() -> bool {
    std::env::var_os(LOCAL_TEST_ENV).is_some()
}

#[cfg(not(any(debug_assertions, test)))]
pub fn is_local_test_enabled() -> bool {
    false
}

#[cfg(any(debug_assertions, test))]
fn local_test_mode() -> Result<String, String> {
    Ok(std::env::var(LOCAL_TEST_ENV)
        .map_err(|error| error.to_string())?
        .trim()
        .to_ascii_lowercase())
}

#[cfg(any(debug_assertions, test))]
fn local_test_check() -> Option<Result<Option<MicrosoftStoreUpdate>, String>> {
    if !is_local_test_enabled() {
        return None;
    }

    let mode = match local_test_mode() {
        Ok(mode) => mode,
        Err(error) => return Some(Err(error)),
    };
    if mode == "none" {
        return Some(Ok(None));
    }
    if matches!(
        mode.as_str(),
        "" | "1"
            | "true"
            | "available"
            | "mandatory"
            | "completed"
            | "cancelled"
            | "canceled"
            | "deferred"
            | "error"
            | "other-error"
            | "low-battery"
            | "wifi-recommended"
            | "wifi-required"
            | "progress-download"
            | "progress-install"
            | "queue-active"
            | "queue-paused"
            | "queue-completed"
            | "queue-cancelled"
            | "queue-canceled"
            | "queue-error"
    ) {
        return Some(Ok(Some(MicrosoftStoreUpdate {
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            package_count: 1,
            mandatory: mode == "mandatory",
            queue_status: local_test_queue_status(&mode),
        })));
    }

    Some(Err(format!(
        "{LOCAL_TEST_ENV} must be one of available, mandatory, none, completed, cancelled, error, low-battery, wifi-recommended, wifi-required, progress-download, progress-install, queue-active, queue-paused, queue-completed, queue-cancelled, or queue-error."
    )))
}

#[cfg(not(any(debug_assertions, test)))]
fn local_test_check() -> Option<Result<Option<MicrosoftStoreUpdate>, String>> {
    None
}

#[cfg(any(debug_assertions, test))]
fn local_test_progress(mode: &str) -> Option<MicrosoftStoreUpdateProgress> {
    let total_download_progress: f64 = match mode {
        "progress-download" | "queue-active" => 0.4,
        "progress-install" | "queue-paused" => 0.85,
        _ => return None,
    };
    Some(MicrosoftStoreUpdateProgress {
        package_download_progress: total_download_progress.min(0.8) / 0.8,
        total_download_progress,
        package_bytes_downloaded: (total_download_progress * 1_000.0) as u64,
        package_download_size_in_bytes: 1_000,
        package_update_state: MicrosoftStoreUpdateStatus::Unknown,
    })
}

#[cfg(any(debug_assertions, test))]
fn local_test_queue_status(mode: &str) -> Option<MicrosoftStoreQueueStatus> {
    let state = match mode {
        "queue-active" => MicrosoftStoreQueueState::Active,
        "queue-paused" => MicrosoftStoreQueueState::Paused,
        "queue-completed" => MicrosoftStoreQueueState::Completed,
        "queue-cancelled" | "queue-canceled" => MicrosoftStoreQueueState::Canceled,
        "queue-error" => MicrosoftStoreQueueState::Error,
        _ => return None,
    };
    Some(MicrosoftStoreQueueStatus {
        state,
        extended_state: mode.to_string(),
        progress: local_test_progress(mode),
    })
}

#[cfg(any(debug_assertions, test))]
fn local_test_request(
    on_event: Channel<MicrosoftStoreUpdateEvent>,
) -> Option<Result<MicrosoftStoreUpdateResult, String>> {
    if !is_local_test_enabled() {
        return None;
    }

    let mode = match local_test_mode() {
        Ok(mode) => mode,
        Err(error) => return Some(Err(error)),
    };
    if let Some(progress) = local_test_progress(&mode) {
        let _ = on_event.send(MicrosoftStoreUpdateEvent::Progress(progress));
    }
    if let Some(queue_status) = local_test_queue_status(&mode) {
        let _ = on_event.send(MicrosoftStoreUpdateEvent::QueueStatus(queue_status.clone()));
        let status = match queue_status.state {
            MicrosoftStoreQueueState::Completed => MicrosoftStoreUpdateStatus::Completed,
            MicrosoftStoreQueueState::Canceled => MicrosoftStoreUpdateStatus::Canceled,
            MicrosoftStoreQueueState::Error => MicrosoftStoreUpdateStatus::OtherError,
            MicrosoftStoreQueueState::Active | MicrosoftStoreQueueState::Paused => {
                MicrosoftStoreUpdateStatus::Unknown
            }
            MicrosoftStoreQueueState::Unknown => MicrosoftStoreUpdateStatus::Unknown,
        };
        return Some(Ok(MicrosoftStoreUpdateResult {
            status,
            queue_status: Some(queue_status),
        }));
    }

    let status = match mode.as_str() {
        "cancelled" | "canceled" | "deferred" => MicrosoftStoreUpdateStatus::Canceled,
        "error" | "other-error" => MicrosoftStoreUpdateStatus::OtherError,
        "low-battery" => MicrosoftStoreUpdateStatus::ErrorLowBattery,
        "wifi-recommended" => MicrosoftStoreUpdateStatus::ErrorWifiRecommended,
        "wifi-required" => MicrosoftStoreUpdateStatus::ErrorWifiRequired,
        "progress-download" | "progress-install" => MicrosoftStoreUpdateStatus::Completed,
        "" | "1" | "true" | "available" | "mandatory" | "none" | "completed" => {
            MicrosoftStoreUpdateStatus::Completed
        }
        _ => {
            return Some(Err(format!(
                "{LOCAL_TEST_ENV} must be one of available, mandatory, none, completed, cancelled, error, low-battery, wifi-recommended, wifi-required, progress-download, progress-install, queue-active, queue-paused, queue-completed, queue-cancelled, or queue-error."
            )));
        }
    };

    Some(Ok(MicrosoftStoreUpdateResult {
        status,
        queue_status: None,
    }))
}

#[cfg(not(any(debug_assertions, test)))]
fn local_test_request(
    _on_event: Channel<MicrosoftStoreUpdateEvent>,
) -> Option<Result<MicrosoftStoreUpdateResult, String>> {
    None
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{
        MicrosoftStoreQueueState, MicrosoftStoreQueueStatus, MicrosoftStoreUpdate,
        MicrosoftStoreUpdateEvent, MicrosoftStoreUpdateProgress, MicrosoftStoreUpdateResult,
        MicrosoftStoreUpdateStatus,
    };
    use std::sync::mpsc;
    use tauri::{Manager, WebviewWindow, ipc::Channel};
    use windows::{
        ApplicationModel::{Package, PackageVersion},
        Services::Store::{
            StoreContext, StorePackageUpdateResult, StorePackageUpdateState,
            StorePackageUpdateStatus, StoreQueueItemExtendedState, StoreQueueItemState,
        },
        Win32::Foundation::HWND,
        Win32::UI::{
            Shell::{IInitializeWithWindow, ShellExecuteW},
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
        core::{Interface, w},
    };
    use windows_future::{
        AsyncOperationProgressHandler, AsyncOperationWithProgressCompletedHandler,
    };

    fn version_string(version: PackageVersion) -> String {
        format!(
            "{}.{}.{}.{}",
            version.Major, version.Minor, version.Build, version.Revision
        )
    }

    fn current_version() -> Result<String, String> {
        let package = Package::Current().map_err(|error| error.to_string())?;
        let id = package.Id().map_err(|error| error.to_string())?;
        let version = id.Version().map_err(|error| error.to_string())?;
        Ok(version_string(version))
    }

    fn update_status(state: StorePackageUpdateState) -> MicrosoftStoreUpdateStatus {
        if state == StorePackageUpdateState::Completed {
            MicrosoftStoreUpdateStatus::Completed
        } else if state == StorePackageUpdateState::Canceled {
            MicrosoftStoreUpdateStatus::Canceled
        } else if state == StorePackageUpdateState::OtherError {
            MicrosoftStoreUpdateStatus::OtherError
        } else if state == StorePackageUpdateState::ErrorLowBattery {
            MicrosoftStoreUpdateStatus::ErrorLowBattery
        } else if state == StorePackageUpdateState::ErrorWiFiRecommended {
            MicrosoftStoreUpdateStatus::ErrorWifiRecommended
        } else if state == StorePackageUpdateState::ErrorWiFiRequired {
            MicrosoftStoreUpdateStatus::ErrorWifiRequired
        } else {
            MicrosoftStoreUpdateStatus::Unknown
        }
    }

    fn progress_status(status: StorePackageUpdateStatus) -> MicrosoftStoreUpdateProgress {
        MicrosoftStoreUpdateProgress {
            package_download_progress: status.PackageDownloadProgress,
            total_download_progress: status.TotalDownloadProgress,
            package_bytes_downloaded: status.PackageBytesDownloaded,
            package_download_size_in_bytes: status.PackageDownloadSizeInBytes,
            package_update_state: update_status(status.PackageUpdateState),
        }
    }

    fn queue_state(state: StoreQueueItemState) -> MicrosoftStoreQueueState {
        if state == StoreQueueItemState::Active {
            MicrosoftStoreQueueState::Active
        } else if state == StoreQueueItemState::Paused {
            MicrosoftStoreQueueState::Paused
        } else if state == StoreQueueItemState::Completed {
            MicrosoftStoreQueueState::Completed
        } else if state == StoreQueueItemState::Canceled {
            MicrosoftStoreQueueState::Canceled
        } else if state == StoreQueueItemState::Error {
            MicrosoftStoreQueueState::Error
        } else {
            MicrosoftStoreQueueState::Unknown
        }
    }

    fn queue_extended_state(state: StoreQueueItemExtendedState) -> String {
        if state == StoreQueueItemExtendedState::ActivePending {
            "ActivePending"
        } else if state == StoreQueueItemExtendedState::ActiveStarting {
            "ActiveStarting"
        } else if state == StoreQueueItemExtendedState::ActiveAcquiringLicense {
            "ActiveAcquiringLicense"
        } else if state == StoreQueueItemExtendedState::ActiveDownloading {
            "ActiveDownloading"
        } else if state == StoreQueueItemExtendedState::ActiveRestoringData {
            "ActiveRestoringData"
        } else if state == StoreQueueItemExtendedState::ActiveInstalling {
            "ActiveInstalling"
        } else if state == StoreQueueItemExtendedState::Completed {
            "Completed"
        } else if state == StoreQueueItemExtendedState::Canceled {
            "Canceled"
        } else if state == StoreQueueItemExtendedState::Paused {
            "Paused"
        } else if state == StoreQueueItemExtendedState::Error {
            "Error"
        } else if state == StoreQueueItemExtendedState::PausedPackagesInUse {
            "PausedPackagesInUse"
        } else if state == StoreQueueItemExtendedState::PausedLowBattery {
            "PausedLowBattery"
        } else if state == StoreQueueItemExtendedState::PausedWiFiRecommended {
            "PausedWiFiRecommended"
        } else if state == StoreQueueItemExtendedState::PausedWiFiRequired {
            "PausedWiFiRequired"
        } else if state == StoreQueueItemExtendedState::PausedReadyToInstall {
            "PausedReadyToInstall"
        } else {
            "Unknown"
        }
        .to_string()
    }

    fn queue_status(context: &StoreContext) -> Result<Option<MicrosoftStoreQueueStatus>, String> {
        let items = context
            .GetAssociatedStoreQueueItemsAsync()
            .map_err(|error| error.to_string())?
            .get()
            .map_err(|error| error.to_string())?;
        let item_count = items.Size().map_err(|error| error.to_string())?;
        for index in 0..item_count {
            let item = items.GetAt(index).map_err(|error| error.to_string())?;
            let status = item.GetCurrentStatus().map_err(|error| error.to_string())?;
            let state = queue_state(
                status
                    .PackageInstallState()
                    .map_err(|error| error.to_string())?,
            );
            if matches!(state, MicrosoftStoreQueueState::Unknown) {
                continue;
            }
            let extended_state = status
                .PackageInstallExtendedState()
                .map(queue_extended_state)
                .unwrap_or_else(|_| "Unknown".to_string());
            let progress = status.UpdateStatus().ok().map(progress_status);
            return Ok(Some(MicrosoftStoreQueueStatus {
                state,
                extended_state,
                progress,
            }));
        }
        Ok(None)
    }

    fn open_store_updates_page(hwnd: HWND) {
        let _ = unsafe {
            ShellExecuteW(
                Some(hwnd),
                w!("open"),
                w!("ms-windows-store://downloadsandupdates"),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
    }

    pub async fn check() -> Result<Option<MicrosoftStoreUpdate>, String> {
        let context = StoreContext::GetDefault().map_err(|error| error.to_string())?;
        let queue_status = queue_status(&context)?;
        let updates = context
            .GetAppAndOptionalStorePackageUpdatesAsync()
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?;
        let package_count = updates.Size().map_err(|error| error.to_string())?;
        if package_count == 0 && queue_status.is_none() {
            return Ok(None);
        }

        let mut mandatory = false;
        for index in 0..package_count {
            let update = updates.GetAt(index).map_err(|error| error.to_string())?;
            mandatory |= update.Mandatory().map_err(|error| error.to_string())?;
        }

        Ok(Some(MicrosoftStoreUpdate {
            current_version: current_version()?,
            package_count,
            mandatory,
            queue_status,
        }))
    }

    pub async fn request(
        window: WebviewWindow,
        on_event: Channel<MicrosoftStoreUpdateEvent>,
    ) -> Result<MicrosoftStoreUpdateResult, String> {
        let hwnd_value = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let (sender, receiver) = mpsc::channel();
        window
            .app_handle()
            .run_on_main_thread(move || {
                let mut sender = Some(sender);
                let result = (|| {
                    open_store_updates_page(HWND(hwnd_value as _));
                    let context = StoreContext::GetDefault().map_err(|error| error.to_string())?;
                    let initialise: IInitializeWithWindow =
                        context.cast().map_err(|error| error.to_string())?;
                    unsafe {
                        initialise
                            .Initialize(HWND(hwnd_value as _))
                            .map_err(|error| error.to_string())?;
                    }
                    let updates = context
                        .GetAppAndOptionalStorePackageUpdatesAsync()
                        .map_err(|error| error.to_string())?
                        .get()
                        .map_err(|error| error.to_string())?;
                    let package_count = updates.Size().map_err(|error| error.to_string())?;
                    if package_count == 0 {
                        return Ok(MicrosoftStoreUpdateResult {
                            status: MicrosoftStoreUpdateStatus::Completed,
                            queue_status: queue_status(&context)?,
                        });
                    }
                    let operation = context
                        .RequestDownloadAndInstallStorePackageUpdatesAsync(&updates)
                        .map_err(|error| error.to_string())?;
                    operation
                        .SetProgress(&AsyncOperationProgressHandler::new({
                            let on_event = on_event;
                            move |_operation, progress| {
                                if let Some(progress) = progress.as_ref() {
                                    let _ = on_event.send(MicrosoftStoreUpdateEvent::Progress(
                                        progress_status(progress.clone()),
                                    ));
                                }
                                Ok(())
                            }
                        }))
                        .map_err(|error| error.to_string())?;
                    let completion_sender = sender.take().ok_or_else(|| {
                        "Microsoft Store update callback was already used.".to_string()
                    })?;
                    operation
                        .SetCompleted(&AsyncOperationWithProgressCompletedHandler::new(
                            move |operation, _status| {
                                let result = operation
                                    .ok()
                                    .and_then(|operation| operation.GetResults())
                                    .and_then(|result: StorePackageUpdateResult| {
                                        let status = update_status(result.OverallState()?);
                                        let queue_status =
                                            result.StoreQueueItems().ok().and_then(|items| {
                                                let item = items.GetAt(0).ok()?;
                                                let status = item.GetCurrentStatus().ok()?;
                                                Some(MicrosoftStoreQueueStatus {
                                                    state: queue_state(
                                                        status.PackageInstallState().ok()?,
                                                    ),
                                                    extended_state: status
                                                        .PackageInstallExtendedState()
                                                        .map(queue_extended_state)
                                                        .unwrap_or_else(|_| "Unknown".to_string()),
                                                    progress: status
                                                        .UpdateStatus()
                                                        .ok()
                                                        .map(progress_status),
                                                })
                                            });
                                        Ok(MicrosoftStoreUpdateResult {
                                            status,
                                            queue_status,
                                        })
                                    })
                                    .map_err(|error| error.to_string());
                                let _ = completion_sender.send(result);
                                Ok(())
                            },
                        ))
                        .map_err(|error| error.to_string())?;
                    Ok(MicrosoftStoreUpdateResult {
                        status: MicrosoftStoreUpdateStatus::Unknown,
                        queue_status: None,
                    })
                })();
                if !matches!(
                    result,
                    Ok(MicrosoftStoreUpdateResult {
                        status: MicrosoftStoreUpdateStatus::Unknown,
                        ..
                    })
                ) {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        receiver.recv().map_err(|error| error.to_string())?
    }
}

#[tauri::command]
pub async fn check_microsoft_store_update(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Option<MicrosoftStoreUpdate>, String> {
    if let Some(result) = local_test_check() {
        return result;
    }

    #[cfg(target_os = "windows")]
    {
        if !crate::is_msix_build()
            || !state
                .git_service
                .get_settings()
                .enable_update_with_ms_store_flow
        {
            return Err("Microsoft Store update flow is disabled.".to_string());
        }
        platform::check().await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("Microsoft Store updates are only available on Windows.".to_string())
    }
}

#[tauri::command]
pub async fn request_microsoft_store_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    on_event: Channel<MicrosoftStoreUpdateEvent>,
) -> Result<MicrosoftStoreUpdateResult, String> {
    if let Some(result) = local_test_request(on_event.clone()) {
        return result;
    }

    #[cfg(target_os = "windows")]
    {
        if !crate::is_msix_build()
            || !state
                .git_service
                .get_settings()
                .enable_update_with_ms_store_flow
        {
            return Err("Microsoft Store update flow is disabled.".to_string());
        }
        platform::request(window, on_event).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        let _ = state;
        let _ = on_event;
        Err("Microsoft Store updates are only available on Windows.".to_string())
    }
}
