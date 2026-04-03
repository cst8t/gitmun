use crate::AppState;
use crate::git::types::{
    AddRemoteRequest, BranchInfo, BranchRequest, CreateBranchRequest, CreateTagRequest,
    DeleteBranchRequest, DeleteRemoteBranchRequest, DeleteRemoteTagRequest, DeleteTagRequest,
    OperationResult, PruneRemoteRequest, PushTagRequest, RemoteInfo, RemoveRemoteRequest,
    RenameBranchRequest, RenameRemoteRequest, RepoRequest, SetBranchUpstreamRequest,
    SetRemoteUrlRequest, TagInfo,
};

#[tauri::command]
pub fn get_branches(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BranchInfo>, String> {
    state
        .git_service
        .get_branches(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn switch_branch(
    request: BranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .switch_branch(request)
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
pub fn create_branch(
    request: CreateBranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .create_branch(request)
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
pub fn get_tags(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TagInfo>, String> {
    state
        .git_service
        .get_tags(request)
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
    state.git_service.create_tag(request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn push_tag(
    request: PushTagRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state.git_service.push_tag(request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_remote_tag(
    request: DeleteRemoteTagRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .delete_remote_tag(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_remote_branch(
    request: DeleteRemoteBranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .delete_remote_branch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_remotes(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RemoteInfo>, String> {
    state
        .git_service
        .get_remotes(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_remote(
    request: AddRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state.git_service.add_remote(request).map_err(|e| e.to_string())
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
    state.git_service.rename_remote(request).map_err(|e| e.to_string())
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
    state.git_service.prune_remote(request).map_err(|e| e.to_string())
}
