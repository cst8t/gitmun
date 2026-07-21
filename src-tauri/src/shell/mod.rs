pub mod cli;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContextAction {
    OpenRepo,
    CloneRepo,
    LocalCopyRepo,
    InitialiseRepo,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WindowRouting {
    NewWindow,
    ReuseWindow,
}
