use crate::AppState;
use crate::git::types::{
    AddRemoteRequest, BranchInfo, BranchRequest, CommitProgressEvent, CreateBranchRequest,
    CreateTagRequest, DeleteBranchRequest, DeleteRemoteBranchRequest, DeleteRemoteTagRequest,
    DeleteTagRequest, GitHookAttemptResult, OperationResult, PruneRemoteRequest, PushTagRequest,
    RemoteInfo, RemoveRemoteRequest, RenameBranchRequest, RenameRemoteRequest, RepoRequest,
    SetBranchUpstreamRequest, SetRemoteUrlRequest, TagInfo,
};
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
pub async fn get_branches(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<Vec<BranchInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_branches(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn switch_branch(
    request: BranchRequest,
    on_progress: tauri::ipc::Channel<CommitProgressEvent>,
    app: tauri::AppHandle,
) -> Result<GitHookAttemptResult<OperationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .switch_branch_with_progress(
                request,
                Arc::new(move |event| drop(on_progress.send(event))),
            )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_branch_upstream(
    request: SetBranchUpstreamRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .set_branch_upstream(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_branch(
    request: CreateBranchRequest,
    on_progress: tauri::ipc::Channel<CommitProgressEvent>,
    app: tauri::AppHandle,
) -> Result<GitHookAttemptResult<OperationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .create_branch_with_progress(
                request,
                Arc::new(move |event| drop(on_progress.send(event))),
            )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_branch(
    request: DeleteBranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .delete_branch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn rename_branch(
    request: RenameBranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .rename_branch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_tags(request: RepoRequest, app: tauri::AppHandle) -> Result<Vec<TagInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_tags(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_tag(
    request: DeleteTagRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .delete_tag(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_tag(
    request: CreateTagRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .create_tag(request)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn push_tag(
    request: PushTagRequest,
    skip_hooks: bool,
    on_progress: tauri::ipc::Channel<CommitProgressEvent>,
    app: tauri::AppHandle,
) -> Result<GitHookAttemptResult<OperationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.push_tag_with_progress(
            request,
            skip_hooks,
            Arc::new(move |event| drop(on_progress.send(event))),
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_remote_tag(
    request: DeleteRemoteTagRequest,
    skip_hooks: bool,
    on_progress: tauri::ipc::Channel<CommitProgressEvent>,
    app: tauri::AppHandle,
) -> Result<GitHookAttemptResult<OperationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .delete_remote_tag_with_progress(
                request,
                skip_hooks,
                Arc::new(move |event| drop(on_progress.send(event))),
            )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_remote_branch(
    request: DeleteRemoteBranchRequest,
    skip_hooks: bool,
    on_progress: tauri::ipc::Channel<CommitProgressEvent>,
    app: tauri::AppHandle,
) -> Result<GitHookAttemptResult<OperationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .delete_remote_branch_with_progress(
                request,
                skip_hooks,
                Arc::new(move |event| drop(on_progress.send(event))),
            )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_remotes(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<Vec<RemoteInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_remotes(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_remote(
    request: AddRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .add_remote(request)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_remote(
    request: RemoveRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .remove_remote(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn rename_remote(
    request: RenameRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .rename_remote(request)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_remote_url(
    request: SetRemoteUrlRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .set_remote_url(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn prune_remote(
    request: PruneRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .prune_remote(request)
        .map_err(|e| e.to_string())
}
