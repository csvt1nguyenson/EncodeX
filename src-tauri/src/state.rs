use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::tools::app_dir;

pub struct AppStateInner {
    pub children: HashMap<usize, Child>,
    pub running: bool,
    pub stop_requested: bool,
    pub is_paused: bool,
    pub paused_since: Option<Instant>,
    pub paused_total: Duration,
    pub log_file: Option<String>,
    pub log_emitter: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

pub struct AppState(pub Arc<Mutex<AppStateInner>>);

impl AppState {
    pub fn new() -> Self {
        AppState(Arc::new(Mutex::new(AppStateInner {
            children: HashMap::new(),
            running: false,
            stop_requested: false,
            is_paused: false,
            paused_since: None,
            paused_total: Duration::ZERO,
            log_file: None,
            log_emitter: None,
        })))
    }

    pub fn clone_shared(&self) -> Self {
        AppState(self.0.clone())
    }
}

pub fn current_paused_duration(state: &AppState) -> Duration {
    let inner = state.0.lock().unwrap();
    let live = inner.paused_since.map(|t| t.elapsed()).unwrap_or(Duration::ZERO);
    inner.paused_total.saturating_add(live)
}

pub fn write_log(state: &AppState, text: &str) {
    let emitter = {
        let mut inner = state.0.lock().unwrap();
        if inner.log_file.is_none() {
            let log_dir = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(app_dir)
                .join("EncodeX")
                .join("encoder_logs");
            let _ = std::fs::create_dir_all(&log_dir);
            let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
            let log_file_path = log_dir.join(format!("encode_log_{}.txt", timestamp));

            if let Ok(mut f) = std::fs::File::create(&log_file_path) {
                let _ = writeln!(f, "EncodeX 0.4.0 Log (Rust Tauri)");
                let _ = writeln!(f, "Started: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
                let _ = writeln!(f, "{}", "=".repeat(80));
                inner.log_file = Some(log_file_path.to_string_lossy().to_string());
            }
        }

        if let Some(ref path_str) = inner.log_file {
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(path_str) {
                let _ = writeln!(f, "{}", text);
            }
        }
        inner.log_emitter.clone()
    };

    // Emit strictly outside the AppState lock so callbacks can never deadlock.
    if let Some(emit) = emitter {
        emit(text);
    }
}
