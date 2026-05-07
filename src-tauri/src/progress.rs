use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

use crate::command_with_augmented_path;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionProgressEvent {
    job_id: String,
    file_path: String,
    stage: String,
    percent: Option<f64>,
    indeterminate: bool,
    message: Option<String>,
    current_seconds: Option<f64>,
    total_seconds: Option<f64>,
}

#[derive(Clone, Default)]
pub(crate) struct JobRegistry {
    state: Arc<Mutex<JobRegistryState>>,
}

#[derive(Default)]
struct JobRegistryState {
    pids: HashMap<String, u32>,
    cancelled: BTreeSet<String>,
}

pub(crate) struct JobRegistration {
    registry: Option<JobRegistry>,
    job_id: Option<String>,
}

impl JobRegistry {
    fn register(&self, job_id: &str, pid: u32) -> Result<(), String> {
        if job_id.trim().is_empty() {
            return Ok(());
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "任务注册表不可用。".to_string())?;
        state.pids.insert(job_id.to_string(), pid);
        state.cancelled.remove(job_id);
        Ok(())
    }

    fn unregister(&self, job_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.pids.remove(job_id);
        }
    }

    pub(crate) fn cancel(&self, job_id: &str) -> Result<bool, String> {
        let job_id = job_id.trim();
        if job_id.is_empty() {
            return Err("任务 ID 不能为空。".into());
        }

        let pid = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "任务注册表不可用。".to_string())?;
            let Some(pid) = state.pids.get(job_id).copied() else {
                return Ok(false);
            };
            state.cancelled.insert(job_id.to_string());
            pid
        };

        let pid_arg = pid.to_string();
        let output = command_with_augmented_path("kill")
            .args(["-TERM", pid_arg.as_str()])
            .output()
            .map_err(|error| format!("无法发送取消请求: {}", error))?;

        if output.status.success() {
            return Ok(true);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.contains("No such process") || stderr.contains("no such process") {
            return Ok(false);
        }

        Err(if stderr.is_empty() {
            "无法取消当前任务。".into()
        } else {
            format!("无法取消当前任务: {}", stderr)
        })
    }

    fn take_cancelled(&self, job_id: &str) -> bool {
        self.state
            .lock()
            .map(|mut state| state.cancelled.remove(job_id))
            .unwrap_or(false)
    }
}

impl JobRegistration {
    pub(crate) fn new(registry: Option<JobRegistry>, job_id: Option<String>, pid: u32) -> Self {
        if let (Some(registry), Some(job_id)) = (&registry, &job_id) {
            let _ = registry.register(job_id, pid);
        }

        Self { registry, job_id }
    }

    pub(crate) fn was_cancelled(&self) -> bool {
        match (&self.registry, &self.job_id) {
            (Some(registry), Some(job_id)) => registry.take_cancelled(job_id),
            _ => false,
        }
    }
}

impl Drop for JobRegistration {
    fn drop(&mut self) {
        if let (Some(registry), Some(job_id)) = (&self.registry, &self.job_id) {
            registry.unregister(job_id);
        }
    }
}

#[derive(Clone)]
pub(crate) struct ProgressReporter {
    app: AppHandle,
    job_id: Option<String>,
    file_path: String,
}

impl ProgressReporter {
    pub(crate) fn new(app: AppHandle, job_id: Option<String>, file_path: String) -> Self {
        Self {
            app,
            job_id,
            file_path,
        }
    }

    pub(crate) fn emit(
        &self,
        stage: &str,
        percent: Option<f64>,
        indeterminate: bool,
        message: Option<&str>,
        current_seconds: Option<f64>,
        total_seconds: Option<f64>,
    ) {
        let Some(job_id) = self.job_id.clone() else {
            return;
        };

        let event = ConversionProgressEvent {
            job_id,
            file_path: self.file_path.clone(),
            stage: stage.to_string(),
            percent: percent.map(|value| (value.clamp(0.0, 100.0) * 10.0).round() / 10.0),
            indeterminate,
            message: message.map(ToOwned::to_owned),
            current_seconds,
            total_seconds,
        };

        let _ = self.app.emit("forph://conversion-progress", event);
    }

    pub(crate) fn job_id(&self) -> Option<String> {
        self.job_id.clone()
    }

    pub(crate) fn job_registry(&self) -> JobRegistry {
        self.app.state::<JobRegistry>().inner().clone()
    }
}
