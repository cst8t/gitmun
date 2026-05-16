use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftStoreUpdate {
    current_version: String,
    package_count: u32,
    mandatory: bool,
}

#[derive(Debug, Serialize)]
pub enum MicrosoftStoreUpdateStatus {
    Completed,
    Canceled,
    OtherError,
    ErrorLowBattery,
    ErrorWifiRecommended,
    ErrorWifiRequired,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftStoreUpdateResult {
    status: MicrosoftStoreUpdateStatus,
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
    ) {
        return Some(Ok(Some(MicrosoftStoreUpdate {
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            package_count: 1,
            mandatory: mode == "mandatory",
        })));
    }

    Some(Err(format!(
        "{LOCAL_TEST_ENV} must be one of available, mandatory, none, completed, cancelled, error, low-battery, wifi-recommended, or wifi-required."
    )))
}

#[cfg(not(any(debug_assertions, test)))]
fn local_test_check() -> Option<Result<Option<MicrosoftStoreUpdate>, String>> {
    None
}

#[cfg(any(debug_assertions, test))]
fn local_test_request() -> Option<Result<MicrosoftStoreUpdateResult, String>> {
    if !is_local_test_enabled() {
        return None;
    }

    let status = match local_test_mode() {
        Ok(mode) => match mode.as_str() {
            "cancelled" | "canceled" | "deferred" => MicrosoftStoreUpdateStatus::Canceled,
            "error" | "other-error" => MicrosoftStoreUpdateStatus::OtherError,
            "low-battery" => MicrosoftStoreUpdateStatus::ErrorLowBattery,
            "wifi-recommended" => MicrosoftStoreUpdateStatus::ErrorWifiRecommended,
            "wifi-required" => MicrosoftStoreUpdateStatus::ErrorWifiRequired,
            "" | "1" | "true" | "available" | "mandatory" | "none" | "completed" => {
                MicrosoftStoreUpdateStatus::Completed
            }
            _ => {
                return Some(Err(format!(
                    "{LOCAL_TEST_ENV} must be one of available, mandatory, none, completed, cancelled, error, low-battery, wifi-recommended, or wifi-required."
                )));
            }
        },
        Err(error) => return Some(Err(error)),
    };

    Some(Ok(MicrosoftStoreUpdateResult { status }))
}

#[cfg(not(any(debug_assertions, test)))]
fn local_test_request() -> Option<Result<MicrosoftStoreUpdateResult, String>> {
    None
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{MicrosoftStoreUpdate, MicrosoftStoreUpdateResult, MicrosoftStoreUpdateStatus};
    use std::sync::mpsc;
    use tauri::{Manager, WebviewWindow};
    use windows::{
        ApplicationModel::{Package, PackageVersion},
        Services::Store::{StoreContext, StorePackageUpdateResult, StorePackageUpdateState},
        Win32::Foundation::HWND,
        Win32::UI::Shell::IInitializeWithWindow,
        core::Interface,
    };
    use windows_future::AsyncOperationWithProgressCompletedHandler;

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

    pub async fn check() -> Result<Option<MicrosoftStoreUpdate>, String> {
        let context = StoreContext::GetDefault().map_err(|error| error.to_string())?;
        let updates = context
            .GetAppAndOptionalStorePackageUpdatesAsync()
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?;
        let package_count = updates.Size().map_err(|error| error.to_string())?;
        if package_count == 0 {
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
        }))
    }

    pub async fn request(window: WebviewWindow) -> Result<MicrosoftStoreUpdateResult, String> {
        let hwnd_value = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let (sender, receiver) = mpsc::channel();
        window
            .app_handle()
            .run_on_main_thread(move || {
                let mut sender = Some(sender);
                let result = (|| {
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
                        return Ok(MicrosoftStoreUpdateStatus::Completed);
                    }
                    let operation = context
                        .RequestDownloadAndInstallStorePackageUpdatesAsync(&updates)
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
                                        result.OverallState()
                                    })
                                    .map(update_status)
                                    .map_err(|error| error.to_string());
                                let _ = completion_sender.send(result);
                                Ok(())
                            },
                        ))
                        .map_err(|error| error.to_string())?;
                    Ok(MicrosoftStoreUpdateStatus::Unknown)
                })();
                if !matches!(result, Ok(MicrosoftStoreUpdateStatus::Unknown)) {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        let status = receiver.recv().map_err(|error| error.to_string())??;
        Ok(MicrosoftStoreUpdateResult { status })
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
) -> Result<MicrosoftStoreUpdateResult, String> {
    if let Some(result) = local_test_request() {
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
        platform::request(window).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        let _ = state;
        Err("Microsoft Store updates are only available on Windows.".to_string())
    }
}
