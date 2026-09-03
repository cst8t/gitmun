use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepositoriesSyncRequest {
    pub paths: Vec<String>,
    pub category_label: String,
    pub accessed_path: Option<String>,
    pub linux_seed_paths: Vec<String>,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct JumpListDestination {
    path: String,
    title: String,
    arguments: String,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum WindowsAppIdentity {
    Packaged(String),
    RunningProcess,
}

#[cfg(any(target_os = "windows", test))]
fn windows_app_identity(is_msix_build: bool, has_package_identity: bool) -> WindowsAppIdentity {
    if is_msix_build && has_package_identity {
        WindowsAppIdentity::Packaged(format!("{}!Gitmun", crate::MSIX_PACKAGE_FAMILY_NAME))
    } else {
        WindowsAppIdentity::RunningProcess
    }
}

fn repository_title(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[cfg(any(target_os = "windows", test))]
fn quote_windows_argument(argument: &str) -> String {
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(any(target_os = "windows", test))]
fn jump_list_destinations(
    paths: &[String],
    removed_paths: &[String],
    capacity: usize,
) -> Vec<JumpListDestination> {
    paths
        .iter()
        .filter(|path| !removed_paths.contains(path))
        .take(capacity)
        .map(|path| JumpListDestination {
            path: path.clone(),
            title: repository_title(path),
            arguments: format!("--new-window open {}", quote_windows_argument(path)),
        })
        .collect()
}

#[cfg(any(target_os = "windows", test))]
trait JumpListWriter {
    fn begin(&mut self) -> Result<(usize, Vec<String>), String>;
    fn append_category(
        &mut self,
        category_label: &str,
        destinations: &[JumpListDestination],
    ) -> Result<(), String>;
    fn commit(&mut self) -> Result<(), String>;
    fn abort(&mut self);
}

#[cfg(any(target_os = "windows", test))]
fn rebuild_jump_list(
    writer: &mut impl JumpListWriter,
    paths: &[String],
    category_label: &str,
) -> Result<Vec<String>, String> {
    let (capacity, removed_paths) = writer.begin()?;
    let destinations = jump_list_destinations(paths, &removed_paths, capacity);
    let result = writer
        .append_category(category_label, &destinations)
        .and_then(|()| writer.commit());
    if let Err(error) = result {
        writer.abort();
        return Err(error);
    }
    Ok(removed_paths)
}

#[tauri::command]
pub async fn sync_recent_repositories(
    app: tauri::AppHandle,
    request: RecentRepositoriesSyncRequest,
) -> Result<Vec<String>, String> {
    platform::sync(app, request).await
}

#[cfg(target_os = "linux")]
mod platform {
    use super::RecentRepositoriesSyncRequest;
    use gtk::prelude::RecentManagerExt;
    use std::path::Path;

    pub async fn sync(
        app: tauri::AppHandle,
        request: RecentRepositoriesSyncRequest,
    ) -> Result<Vec<String>, String> {
        let mut accessed_paths = request.linux_seed_paths;
        if let Some(accessed_path) = request.accessed_path {
            accessed_paths.push(accessed_path);
        }
        if accessed_paths.is_empty() {
            return Ok(Vec::new());
        }

        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            drop(sender.send(record_accesses(&accessed_paths)));
        })
        .map_err(|error| error.to_string())?;
        receiver.await.map_err(|error| error.to_string())??;
        Ok(Vec::new())
    }

    fn record_accesses(paths: &[String]) -> Result<(), String> {
        let manager = gtk::RecentManager::default()
            .ok_or_else(|| "GTK recent manager is unavailable".to_string())?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let app_exec = format!(
            "{} --new-window open %f",
            gtk::glib::shell_quote(&executable).to_string_lossy()
        );

        for path in paths {
            let uri = url::Url::from_directory_path(Path::new(path))
                .map_err(|()| format!("Cannot convert repository path to URI: {path}"))?;
            let recent_data = gtk::RecentData {
                display_name: Some(super::repository_title(path)),
                description: Some(path.clone()),
                mime_type: "inode/directory".to_string(),
                app_name: "Gitmun".to_string(),
                app_exec: app_exec.clone(),
                groups: vec!["gitmun".to_string()],
                is_private: false,
            };
            if !manager.add_full(uri.as_str(), &recent_data) {
                return Err(format!("GTK could not record recent repository: {path}"));
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{
        JumpListDestination, JumpListWriter, RecentRepositoriesSyncRequest, WindowsAppIdentity,
        rebuild_jump_list, windows_app_identity,
    };
    use windows::{
        Win32::{
            Foundation::PROPERTYKEY,
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoTaskMemFree, CoUninitialize, StructuredStorage::PROPVARIANT,
            },
            UI::Shell::{
                Common::{IObjectArray, IObjectCollection},
                DestinationList, EnumerableObjectCollection,
                GetCurrentProcessExplicitAppUserModelID, ICustomDestinationList, IShellLinkW,
                PropertiesSystem::IPropertyStore,
                ShellLink,
            },
        },
        core::{GUID, Interface, PCWSTR},
    };

    const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
        pid: 2,
    };
    const SHELL_STRING_CAPACITY: usize = 32_768;

    pub async fn sync(
        _app: tauri::AppHandle,
        request: RecentRepositoriesSyncRequest,
    ) -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || sync_blocking(request))
            .await
            .map_err(|error| error.to_string())?
    }

    fn sync_blocking(request: RecentRepositoriesSyncRequest) -> Result<Vec<String>, String> {
        let _com = ComInitialisation::new()?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let identity = windows_app_identity(crate::is_msix_build(), crate::has_package_identity());
        let mut writer = WindowsJumpListWriter {
            destination_list: None,
            executable: executable.to_string_lossy().into_owned(),
            identity,
        };
        rebuild_jump_list(&mut writer, &request.paths, &request.category_label)
    }

    struct ComInitialisation;

    impl ComInitialisation {
        fn new() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|error| error.to_string())?;
            Ok(Self)
        }
    }

    impl Drop for ComInitialisation {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct WindowsJumpListWriter {
        destination_list: Option<ICustomDestinationList>,
        executable: String,
        identity: WindowsAppIdentity,
    }

    impl JumpListWriter for WindowsJumpListWriter {
        fn begin(&mut self) -> Result<(usize, Vec<String>), String> {
            let destination_list: ICustomDestinationList =
                unsafe { CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER) }
                    .map_err(|error| error.to_string())?;
            if let WindowsAppIdentity::Packaged(app_id) = &self.identity {
                let app_id = wide_string(app_id);
                unsafe { destination_list.SetAppID(PCWSTR::from_raw(app_id.as_ptr())) }
                    .map_err(|error| error.to_string())?;
            } else if let Ok(app_id) = unsafe { GetCurrentProcessExplicitAppUserModelID() } {
                let result =
                    unsafe { destination_list.SetAppID(PCWSTR::from_raw(app_id.as_ptr())) };
                unsafe { CoTaskMemFree(Some(app_id.as_ptr().cast())) };
                result.map_err(|error| error.to_string())?;
            }

            let mut capacity = 0;
            let removed: IObjectArray = unsafe { destination_list.BeginList(&mut capacity) }
                .map_err(|error| error.to_string())?;
            self.destination_list = Some(destination_list);
            let removed_paths = match removed_paths(&removed) {
                Ok(paths) => paths,
                Err(error) => {
                    self.abort();
                    return Err(error);
                }
            };
            Ok((capacity as usize, removed_paths))
        }

        fn append_category(
            &mut self,
            category_label: &str,
            destinations: &[JumpListDestination],
        ) -> Result<(), String> {
            if destinations.is_empty() {
                return Ok(());
            }
            let collection: IObjectCollection = unsafe {
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)
            }
            .map_err(|error| error.to_string())?;
            for destination in destinations {
                let link = self.create_link(destination)?;
                unsafe { collection.AddObject(&link) }.map_err(|error| error.to_string())?;
            }
            let objects: IObjectArray = collection.cast().map_err(|error| error.to_string())?;
            let category_label = wide_string(category_label);
            unsafe {
                self.destination_list()
                    .AppendCategory(PCWSTR::from_raw(category_label.as_ptr()), &objects)
            }
            .map_err(|error| error.to_string())
        }

        fn commit(&mut self) -> Result<(), String> {
            unsafe { self.destination_list().CommitList() }.map_err(|error| error.to_string())
        }

        fn abort(&mut self) {
            if let Some(destination_list) = &self.destination_list {
                drop(unsafe { destination_list.AbortList() });
            }
        }
    }

    impl WindowsJumpListWriter {
        fn destination_list(&self) -> &ICustomDestinationList {
            self.destination_list
                .as_ref()
                .expect("destination list must be begun before it is updated")
        }

        fn create_link(&self, destination: &JumpListDestination) -> Result<IShellLinkW, String> {
            let link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
                    .map_err(|error| error.to_string())?;
            let executable = wide_string(&self.executable);
            let arguments = wide_string(&destination.arguments);
            let description = wide_string(&destination.path);
            let result = (|| -> windows::core::Result<()> {
                unsafe {
                    link.SetPath(PCWSTR::from_raw(executable.as_ptr()))?;
                    link.SetArguments(PCWSTR::from_raw(arguments.as_ptr()))?;
                    link.SetDescription(PCWSTR::from_raw(description.as_ptr()))?;
                    link.SetIconLocation(PCWSTR::from_raw(executable.as_ptr()), 0)?;
                    let properties: IPropertyStore = link.cast()?;
                    let title = PROPVARIANT::from(destination.title.as_str());
                    properties.SetValue(&PKEY_TITLE, &title)?;
                    properties.Commit()?;
                }
                Ok(())
            })();
            result.map_err(|error| error.to_string())?;
            Ok(link)
        }
    }

    fn removed_paths(objects: &IObjectArray) -> Result<Vec<String>, String> {
        let count = unsafe { objects.GetCount() }.map_err(|error| error.to_string())?;
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let link: IShellLinkW =
                unsafe { objects.GetAt(index) }.map_err(|error| error.to_string())?;
            let mut description = vec![0_u16; SHELL_STRING_CAPACITY];
            unsafe { link.GetDescription(&mut description) }.map_err(|error| error.to_string())?;
            let length = description
                .iter()
                .position(|character| *character == 0)
                .unwrap_or(description.len());
            if length > 0 {
                paths.push(String::from_utf16_lossy(&description[..length]));
            }
        }
        Ok(paths)
    }

    fn wide_string(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod platform {
    use super::RecentRepositoriesSyncRequest;

    pub async fn sync(
        _app: tauri::AppHandle,
        _request: RecentRepositoriesSyncRequest,
    ) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_destinations_and_preserves_order() {
        let paths = vec![
            r"C:\Repos\one".to_string(),
            r"C:\Repos\two".to_string(),
            r"C:\Repos\three".to_string(),
        ];

        let destinations = jump_list_destinations(&paths, &[], 2);

        assert_eq!(
            destinations
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>(),
            vec![r"C:\Repos\one", r"C:\Repos\two"]
        );
    }

    #[test]
    fn omits_removed_destinations_without_reordering_the_rest() {
        let paths = vec![
            r"C:\Repos\one".to_string(),
            r"C:\Repos\two".to_string(),
            r"C:\Repos\three".to_string(),
        ];

        let destinations = jump_list_destinations(&paths, &[r"C:\Repos\two".to_string()], 10);

        assert_eq!(
            destinations
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>(),
            vec![r"C:\Repos\one", r"C:\Repos\three"]
        );
    }

    #[test]
    fn builds_unicode_titles_and_correctly_quoted_arguments() {
        let paths = vec![r#"C:\Repos\quoted name\résumé"#.to_string()];

        let destinations = jump_list_destinations(&paths, &[], 10);

        assert_eq!(destinations[0].title, "résumé");
        assert_eq!(
            destinations[0].arguments,
            r#"--new-window open "C:\Repos\quoted name\résumé""#
        );
        assert_eq!(
            quote_windows_argument(r#"C:\Repos\name"with quote\"#),
            r#""C:\Repos\name\"with quote\\""#
        );
    }

    #[test]
    fn selects_packaged_and_running_process_identities() {
        assert_eq!(
            windows_app_identity(true, true),
            WindowsAppIdentity::Packaged("cst8t.Gitmun_yqm0gq6me4wme!Gitmun".to_string())
        );
        assert_eq!(
            windows_app_identity(false, false),
            WindowsAppIdentity::RunningProcess
        );
        assert_eq!(
            windows_app_identity(true, false),
            WindowsAppIdentity::RunningProcess
        );
    }

    #[derive(Default)]
    struct TestWriter {
        fail_append: bool,
        committed: bool,
        aborted: bool,
    }

    impl JumpListWriter for TestWriter {
        fn begin(&mut self) -> Result<(usize, Vec<String>), String> {
            Ok((10, Vec::new()))
        }

        fn append_category(
            &mut self,
            _category_label: &str,
            _destinations: &[JumpListDestination],
        ) -> Result<(), String> {
            if self.fail_append {
                Err("append failed".to_string())
            } else {
                Ok(())
            }
        }

        fn commit(&mut self) -> Result<(), String> {
            self.committed = true;
            Ok(())
        }

        fn abort(&mut self) {
            self.aborted = true;
        }
    }

    #[test]
    fn aborts_without_committing_after_a_build_error() {
        let mut writer = TestWriter {
            fail_append: true,
            ..TestWriter::default()
        };

        let result = rebuild_jump_list(&mut writer, &[r"C:\Repos\one".to_string()], "Recent");

        assert_eq!(result, Err("append failed".to_string()));
        assert!(writer.aborted);
        assert!(!writer.committed);
    }
}
