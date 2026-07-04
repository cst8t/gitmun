use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftStoreUpdate {
    current_version: String,
    package_count: u32,
    mandatory: bool,
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
    if matches!(mode.as_str(), "" | "1" | "true" | "available" | "mandatory") {
        return Some(Ok(Some(MicrosoftStoreUpdate {
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            package_count: 1,
            mandatory: mode == "mandatory",
        })));
    }

    Some(Err(format!(
        "{LOCAL_TEST_ENV} must be one of available, mandatory, or none."
    )))
}

#[cfg(not(any(debug_assertions, test)))]
fn local_test_check() -> Option<Result<Option<MicrosoftStoreUpdate>, String>> {
    None
}

#[cfg(any(debug_assertions, test))]
fn local_test_open() -> Option<Result<(), String>> {
    if !is_local_test_enabled() {
        return None;
    }

    let mode = match local_test_mode() {
        Ok(mode) => mode,
        Err(error) => return Some(Err(error)),
    };
    if matches!(
        mode.as_str(),
        "" | "1" | "true" | "available" | "mandatory" | "none"
    ) {
        Some(Ok(()))
    } else {
        Some(Err(format!(
            "{LOCAL_TEST_ENV} must be one of available, mandatory, or none."
        )))
    }
}

#[cfg(not(any(debug_assertions, test)))]
fn local_test_open() -> Option<Result<(), String>> {
    None
}

#[cfg(target_os = "windows")]
mod platform {
    use super::MicrosoftStoreUpdate;
    use tauri::{Manager, WebviewWindow};
    use windows::{
        ApplicationModel::{Package, PackageVersion},
        Services::Store::StoreContext,
        Win32::Foundation::HWND,
        Win32::UI::{
            Shell::ShellExecuteW,
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
        core::w,
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

    fn open_store_page(hwnd: HWND) -> Result<(), String> {
        let result = unsafe {
            ShellExecuteW(
                Some(hwnd),
                w!("open"),
                w!("ms-windows-store://pdp/?ProductId=9NBVNCKH5J9V"),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err("Microsoft Store could not be opened.".to_string());
        }
        Ok(())
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

    pub async fn open_update_page(window: WebviewWindow) -> Result<(), String> {
        let hwnd_value = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let (sender, receiver) = std::sync::mpsc::channel();
        window
            .app_handle()
            .run_on_main_thread(move || {
                let result = open_store_page(HWND(hwnd_value as _));
                let _ = sender.send(result);
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
        if !crate::is_msix_build() {
            return Err("Microsoft Store update flow is disabled.".to_string());
        }
        let _ = state;
        platform::check().await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("Microsoft Store updates are only available on Windows.".to_string())
    }
}

#[tauri::command]
pub async fn open_microsoft_store_update_page(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    if let Some(result) = local_test_open() {
        return result;
    }

    #[cfg(target_os = "windows")]
    {
        if !crate::is_msix_build() {
            return Err("Microsoft Store update flow is disabled.".to_string());
        }
        let _ = state;
        platform::open_update_page(window).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        let _ = state;
        Err("Microsoft Store updates are only available on Windows.".to_string())
    }
}
