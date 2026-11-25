use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::ffmpeg::probe_info_sync;
#[cfg(target_os = "windows")]
use crate::process::CREATE_NO_WINDOW;
use crate::process::{set_queue_paused, stop_all};
use crate::queue::run_queue_worker;
use crate::state::{write_log, AppState};
use crate::tools::{media_tools_directory, prepare_tools};
use crate::updater::{check_for_updates_sync, is_allowed_github_url, UpdateCheckResult};

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "webm", "ts", "m2ts", "mxf", "flv", "wmv", "m4v", "mpg", "mpeg",
    "3gp", "ogv", "mp3", "wav", "aac", "m4a", "flac", "ogg", "opus", "wma", "aiff", "aif",
];

#[tauri::command]
pub async fn prepare_media_tools(state: State<'_, AppState>) -> Result<String, String> {
    let shared = state.clone_shared();
    tauri::async_runtime::spawn_blocking(move || prepare_tools(&shared))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn schedule_shutdown(cancel: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("shutdown.exe");
        if cancel {
            cmd.arg("/a");
        } else {
            cmd.args(["/s", "/t", "60"]);
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cancel;
        Err("Shutdown is only supported on Windows".into())
    }
}

#[tauri::command]
pub fn choose_files() -> Vec<String> {
    rfd::FileDialog::new()
        .set_title("Select files")
        .add_filter("All files", &["*"])
        .add_filter("Media files", MEDIA_EXTENSIONS)
        .pick_files()
        .map(|paths| {
            paths
                .into_iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn choose_folder() -> Vec<String> {
    let mut result = Vec::new();
    if let Some(path) = rfd::FileDialog::new().set_title("Select folder").pick_folder() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                        if MEDIA_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                            result.push(p.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    result.sort();
    result
}

#[tauri::command]
pub fn choose_output_folder() -> String {
    rfd::FileDialog::new()
        .set_title("Select folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn open_output_path(output_path: String) -> bool {
    let normalized = output_path.trim().trim_matches('"').replace('/', "\\");
    let path = Path::new(&normalized);
    if normalized.is_empty() || !path.is_absolute() || normalized.contains('"') {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        let mut explorer = Command::new("explorer.exe");
        if path.is_file() {
            // Keep /select, outside the quoted filename when the path has spaces.
            explorer.raw_arg(format!("/select,\"{}\"", normalized));
        } else if path.is_dir() {
            explorer.arg(path);
        } else if let Some(parent) = path.parent().filter(|p| p.is_dir()) {
            explorer.arg(parent);
        } else {
            return false;
        }
        explorer.spawn().is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

// Run ffprobe off the main UI thread so slow NAS/network drives never stall WebView2.
#[tauri::command]
pub async fn probe_info(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || probe_info_sync(&path))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ui_log(state: State<'_, AppState>, text: String) -> bool {
    write_log(&state, &text);
    true
}

#[tauri::command]
pub fn save_queue(payload: serde_json::Value) -> bool {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Save queue")
        .add_filter("Queue JSON", &["json"])
        .save_file()
    else {
        return false;
    };

    if let Ok(mut f) = std::fs::File::create(path) {
        if let Ok(data) = serde_json::to_string_pretty(&payload) {
            return f.write_all(data.as_bytes()).is_ok();
        }
    }
    false
}

#[tauri::command]
pub fn load_queue() -> serde_json::Value {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Load queue")
        .add_filter("Queue JSON", &["json"])
        .pick_file()
    else {
        return serde_json::Value::Null;
    };

    if let Ok(data) = std::fs::read_to_string(path) {
        if let Ok(val) = serde_json::from_str(&data) {
            return val;
        }
    }
    serde_json::Value::Null
}

#[tauri::command]
pub fn start_queue(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: serde_json::Value,
    queue: Vec<serde_json::Value>,
) -> Result<bool, String> {
    if media_tools_directory().is_none() {
        return Err("FFmpeg/FFprobe not ready. Wait for setup or retry.".into());
    }
    {
        let mut inner = state.0.lock().unwrap();
        if inner.running {
            return Ok(false);
        }
        inner.running = true;
        inner.stop_requested = false;
        inner.is_paused = false;
        inner.paused_since = None;
        inner.paused_total = Duration::ZERO;
    }

    let state_clone = state.clone_shared();
    std::thread::spawn(move || {
        run_queue_worker(app, state_clone, settings, queue);
    });

    Ok(true)
}

#[tauri::command]
pub fn stop_queue(state: State<'_, AppState>) -> bool {
    stop_all(&state);
    true
}

#[tauri::command]
pub fn pause_queue(state: State<'_, AppState>) -> bool {
    set_queue_paused(&state, true)
}

#[tauri::command]
pub fn resume_queue(state: State<'_, AppState>) -> bool {
    set_queue_paused(&state, false)
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    tauri::async_runtime::spawn_blocking(check_for_updates_sync)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_release_url(app: AppHandle, url: String) -> Result<(), String> {
    if !is_allowed_github_url(&url) {
        return Err("Refused to open untrusted URL.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
