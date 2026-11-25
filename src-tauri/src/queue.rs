use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Emitter};

use crate::ffmpeg::{
    build_ffmpeg_args, build_output_path, compute_active_elapsed_secs, concurrent_jobs, format_eta,
    is_audio_only_format, make_unique_existing_path, probe_duration, publish_output, size_result,
    validate_output,
};
#[cfg(target_os = "windows")]
use crate::process::CREATE_NO_WINDOW;
use crate::process::suspend_process;
use crate::state::{current_paused_duration, write_log, AppState};
use crate::tools::ffmpeg_exe;

pub fn run_pool<F: Fn(usize) + Sync>(state: &AppState, count: usize, limit: usize, work: F) {
    let next = Mutex::new(0usize);
    std::thread::scope(|scope| {
        for _ in 0..limit.clamp(1, 5).min(count) {
            let work = &work;
            let next = &next;
            scope.spawn(move || loop {
                let inner = state.0.lock().unwrap();
                if inner.stop_requested {
                    break;
                }
                if inner.is_paused {
                    drop(inner);
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                let mut cursor = next.lock().unwrap();
                if *cursor >= count {
                    break;
                }
                let index = *cursor;
                *cursor += 1;
                drop(cursor);
                drop(inner);
                work(index);
            });
        }
    });
}

fn update_item_ui(app: &AppHandle, index: usize, data: serde_json::Value) {
    let _ = app.emit(
        "queue-update",
        serde_json::json!({
            "index": index,
            "data": data
        }),
    );
}

pub fn run_queue_worker(
    app: AppHandle,
    state: AppState,
    settings: serde_json::Value,
    queue: Vec<serde_json::Value>,
) {
    write_log(
        &state,
        &format!("Queue started. Concurrent jobs: {}", concurrent_jobs(&settings)),
    );
    let reserved_outputs = Mutex::new(HashSet::new());
    let completed = AtomicUsize::new(0);

    run_pool(&state, queue.len(), concurrent_jobs(&settings), |index| {
        let result = run_one_job(
            &app,
            &state,
            &settings,
            &queue[index],
            index,
            queue.len(),
            &reserved_outputs,
        );
        completed.fetch_add(result, Ordering::SeqCst);
    });

    let stopped = {
        let mut inner = state.0.lock().unwrap();
        let was_stopped = inner.stop_requested;
        inner.children.clear();
        inner.running = false;
        inner.is_paused = false;
        inner.paused_since = None;
        inner.paused_total = Duration::ZERO;
        inner.stop_requested = false;
        was_stopped
    };

    let _ = app.emit("active-job", "No active job");
    let _ = app.emit(
        "queue-finished",
        serde_json::json!({
            "stopped": stopped,
            "completed": completed.load(Ordering::SeqCst)
        }),
    );
    write_log(&state, if stopped { "Queue stopped." } else { "Queue finished." });
}

fn run_one_job(
    app: &AppHandle,
    state: &AppState,
    settings: &serde_json::Value,
    item: &serde_json::Value,
    index: usize,
    total: usize,
    reserved_outputs: &Mutex<HashSet<String>>,
) -> usize {
    let job_log = |text: &str| write_log(state, &format!("[Job {}] {}", index + 1, text));

    {
        let inner = state.0.lock().unwrap();
        if inner.stop_requested {
            update_item_ui(
                app,
                index,
                serde_json::json!({
                    "status": "Stopped",
                    "progress": 0,
                    "eta": "--"
                }),
            );
            return 0;
        }
    }

    let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if !status.is_empty() && status != "Ready" {
        job_log(&format!("Skipped queue item {}: status is {}", index + 1, status));
        return 0;
    }

    let fmt = item.get("format").and_then(|v| v.as_str()).unwrap_or("h264_mp4");
    let export_video = if is_audio_only_format(fmt) {
        false
    } else {
        item.get("exportVideo").and_then(|v| v.as_bool()).unwrap_or(true)
    };
    let export_audio = item.get("exportAudio").and_then(|v| v.as_bool()).unwrap_or(true);

    if !export_video && !export_audio {
        let err_msg = "At least one of Video or Audio must be enabled.";
        update_item_ui(
            app,
            index,
            serde_json::json!({
                "status": "Failed",
                "progress": 0,
                "eta": "--",
                "error": err_msg
            }),
        );
        job_log(&format!("ERROR: {}", err_msg));
        return 0;
    }

    let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let existing_action = settings
        .get("existingAction")
        .and_then(|v| v.as_str())
        .unwrap_or("autorename");

    // Reserve output path atomically, then drop the mutex before any logging or IPC.
    enum OutputDecision {
        Skip(String),
        Encode { initial: String, final_path: String, renamed: bool },
    }

    let decision = {
        let mut reservations = reserved_outputs.lock().unwrap();
        let initial = build_output_path(source, settings, item, &mut reservations);
        if Path::new(&initial).exists() {
            if existing_action == "skip" {
                OutputDecision::Skip(initial)
            } else if existing_action == "autorename" {
                let renamed_path = make_unique_existing_path(&initial, &reservations);
                reservations.insert(renamed_path.to_lowercase());
                OutputDecision::Encode {
                    initial,
                    final_path: renamed_path,
                    renamed: true,
                }
            } else {
                OutputDecision::Encode {
                    final_path: initial.clone(),
                    initial,
                    renamed: false,
                }
            }
        } else {
            OutputDecision::Encode {
                final_path: initial.clone(),
                initial,
                renamed: false,
            }
        }
    };

    let final_output = match decision {
        OutputDecision::Skip(existing) => {
            job_log(&format!("[{}/{}] Source: {}", index + 1, total, source));
            job_log(&format!("Skipped: output already exists ({})", existing));
            let mut data = serde_json::json!({
                "output": existing,
                "status": "Skipped",
                "progress": 100,
                "eta": "--"
            });
            if let Some(map) = data.as_object_mut() {
                if let Some(size_map) = size_result(source, &existing) {
                    for (k, v) in size_map {
                        map.insert(k, v);
                    }
                }
            }
            update_item_ui(app, index, data);
            return 0;
        }
        OutputDecision::Encode {
            initial,
            final_path,
            renamed,
        } => {
            update_item_ui(
                app,
                index,
                serde_json::json!({
                    "output": final_path,
                    "status": "Encoding",
                    "progress": 0,
                    "eta": "--",
                    "error": serde_json::Value::Null
                }),
            );
            let filename = Path::new(source).file_name().and_then(|s| s.to_str()).unwrap_or("");
            let _ = app.emit("active-job", filename);
            job_log("");
            job_log(&format!("[{}/{}] Source: {}", index + 1, total, source));
            if renamed {
                job_log(&format!("Output exists ({}). Auto renamed to: {}", initial, final_path));
            } else {
                job_log(&format!("Output: {}", final_path));
            }
            final_path
        }
    };

    let duration = probe_duration(source);
    let temp_path = Path::new(&final_output);
    let temporary = temp_path
        .with_file_name(format!(
            "{}.encodex-{}-{}.part.{}",
            temp_path.file_stem().unwrap_or_default().to_string_lossy(),
            std::process::id(),
            index,
            temp_path.extension().unwrap_or_default().to_string_lossy()
        ))
        .to_string_lossy()
        .to_string();

    let cmd_args = build_ffmpeg_args(source, &temporary, settings, item);
    job_log("Command:");
    job_log(&format!("ffmpeg {}", cmd_args.join(" ")));

    let mut process_cmd = Command::new(ffmpeg_exe());
    process_cmd
        .args(&cmd_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    process_cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match process_cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("ERROR spawning FFmpeg: {}", e);
            update_item_ui(
                app,
                index,
                serde_json::json!({
                    "status": "Failed",
                    "progress": 0,
                    "eta": "--",
                    "error": msg
                }),
            );
            job_log(&msg);
            return 0;
        }
    };

    let stderr = child.stderr.take().unwrap();
    let log_state = state.clone_shared();
    let error_reader = std::thread::spawn(move || {
        let mut tail = VecDeque::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            write_log(&log_state, &format!("[Job {}] {}", index + 1, line));
            tail.push_back(line);
            if tail.len() > 12 {
                tail.pop_front();
            }
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });

    {
        let mut inner = state.0.lock().unwrap();
        if inner.stop_requested {
            let _ = child.kill();
        } else if inner.is_paused && !suspend_process(child.id()) {
            let _ = child.kill();
        }
        inner.children.insert(index, child);
    }

    let child_stdout = state
        .0
        .lock()
        .unwrap()
        .children
        .get_mut(&index)
        .unwrap()
        .stdout
        .take()
        .unwrap();
    let reader = BufReader::new(child_stdout);

    let process_start_time = Instant::now();
    let paused_baseline = current_paused_duration(state);
    let mut last_percent = -1;

    for line in reader.lines() {
        if state.0.lock().unwrap().stop_requested {
            break;
        }
        if let Ok(ref text) = line {
            let text = text.trim();
            if let Some(ms_str) = text.strip_prefix("out_time_ms=") {
                if let Ok(ms) = ms_str.parse::<i64>() {
                    if duration > 0.0 {
                        let sec = (ms as f64) / 1_000_000.0;
                        let percent = (((sec / duration) * 100.0) as i32).clamp(0, 99);
                        if percent != last_percent {
                            if last_percent < 0 || percent / 10 != last_percent / 10 {
                                job_log(&format!("Progress: {}%", percent));
                            }
                            let eta = if percent > 0 {
                                let paused_delta = current_paused_duration(state)
                                    .saturating_sub(paused_baseline);
                                let elapsed = compute_active_elapsed_secs(
                                    process_start_time.elapsed(),
                                    paused_delta,
                                );
                                let remaining = elapsed * (100.0 - percent as f64) / (percent as f64);
                                format_eta(remaining)
                            } else {
                                "--".to_string()
                            };
                            let status = if percent >= 99 { "Finishing..." } else { "Encoding" };
                            update_item_ui(
                                app,
                                index,
                                serde_json::json!({
                                    "status": status,
                                    "progress": percent,
                                    "eta": eta
                                }),
                            );
                            last_percent = percent;
                        }
                    }
                }
            }
        }
    }

    let exit_status = loop {
        let result = {
            let mut inner = state.0.lock().unwrap();
            inner.children.get_mut(&index).unwrap().try_wait()
        };
        match result {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => break Err(error),
        }
    };

    let mut completed = 0usize;
    if let Some(mut c) = state.0.lock().unwrap().children.remove(&index) {
        if exit_status.is_err() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let error_text = error_reader.join().unwrap_or_default();
        let is_stopped = state.0.lock().unwrap().stop_requested;

        if is_stopped {
            update_item_ui(
                app,
                index,
                serde_json::json!({
                    "status": "Stopped",
                    "progress": 0,
                    "eta": "--"
                }),
            );
            job_log("Stopped.");
            let _ = std::fs::remove_file(&temporary);
        } else if let Ok(status) = exit_status {
            let validation = if status.success() {
                validate_output(&temporary, duration)
                    .and_then(|_| publish_output(&temporary, &final_output, existing_action == "overwrite"))
            } else {
                Err(format!("FFmpeg {}: {}", status, error_text))
            };

            if validation.is_ok() {
                completed = 1;
                let mut data = serde_json::json!({
                    "output": final_output,
                    "status": "Done",
                    "progress": 100,
                    "eta": "--"
                });
                if let Some(map) = data.as_object_mut() {
                    if let Some(size_map) = size_result(source, &final_output) {
                        for (k, v) in size_map {
                            map.insert(k, v);
                        }
                    }
                }
                update_item_ui(app, index, data);
                job_log("OK.");
            } else {
                let reason = validation.unwrap_err();
                update_item_ui(
                    app,
                    index,
                    serde_json::json!({
                        "status": "Failed",
                        "progress": 0,
                        "eta": "--",
                        "error": reason
                    }),
                );
                job_log(&format!("FAILED: {}", reason));
                let _ = std::fs::remove_file(&temporary);
            }
        }
    }

    completed
}
