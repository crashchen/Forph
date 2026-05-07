use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    process::Child,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

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
    children: HashMap<String, Arc<Mutex<Child>>>,
    cancelled: BTreeSet<String>,
}

pub(crate) struct JobRegistration {
    registry: Option<JobRegistry>,
    job_id: Option<String>,
}

impl JobRegistry {
    fn register(&self, job_id: &str, child: Arc<Mutex<Child>>) -> Result<(), String> {
        if job_id.trim().is_empty() {
            return Ok(());
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "任务注册表不可用。".to_string())?;
        state.children.insert(job_id.to_string(), child);
        state.cancelled.remove(job_id);
        Ok(())
    }

    fn unregister(&self, job_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.children.remove(job_id);
            state.cancelled.remove(job_id);
        }
    }

    pub(crate) fn cancel(&self, job_id: &str) -> Result<bool, String> {
        let job_id = job_id.trim();
        if job_id.is_empty() {
            return Err("任务 ID 不能为空。".into());
        }

        let child = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "任务注册表不可用。".to_string())?;
            let Some(child) = state.children.get(job_id).cloned() else {
                return Ok(false);
            };
            state.cancelled.insert(job_id.to_string());
            child
        };

        let mut child = child
            .lock()
            .map_err(|_| "当前任务句柄不可用，无法取消。".to_string())?;
        if child
            .try_wait()
            .map_err(|error| format!("无法检查当前任务状态: {}", error))?
            .is_some()
        {
            if let Ok(mut state) = self.state.lock() {
                state.cancelled.remove(job_id);
            }
            return Ok(false);
        }

        match child.kill() {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {
                if let Ok(mut state) = self.state.lock() {
                    state.cancelled.remove(job_id);
                }
                Ok(false)
            }
            Err(error) => Err(format!("无法取消当前任务: {}", error)),
        }
    }

    fn take_cancelled(&self, job_id: &str) -> bool {
        self.state
            .lock()
            .map(|mut state| state.cancelled.remove(job_id))
            .unwrap_or(false)
    }
}

impl JobRegistration {
    pub(crate) fn new(
        registry: Option<JobRegistry>,
        job_id: Option<String>,
        child: Arc<Mutex<Child>>,
    ) -> Self {
        if let (Some(registry), Some(job_id)) = (&registry, &job_id) {
            let _ = registry.register(job_id, child);
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
