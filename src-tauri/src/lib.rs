mod commands;
mod ffmpeg;
mod process;
mod queue;
mod state;
mod tools;
mod updater;

use std::sync::Arc;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use crate::process::stop_all;
use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .setup(|app| {
            let handle = app.handle().clone();
            app.state::<AppState>().0.lock().unwrap().log_emitter =
                Some(Arc::new(move |text| {
                    let _ = handle.emit(
                        "encoder-log",
                        serde_json::json!({
                            "time": chrono::Local::now().format("%H:%M:%S").to_string(),
                            "message": text
                        }),
                    );
                }));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
                stop_all(&window.state::<AppState>());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::prepare_media_tools,
            commands::schedule_shutdown,
            commands::choose_files,
            commands::choose_folder,
            commands::choose_output_folder,
            commands::open_output_path,
            commands::probe_info,
            commands::ui_log,
            commands::save_queue,
            commands::load_queue,
            commands::start_queue,
            commands::stop_queue,
            commands::pause_queue,
            commands::resume_queue,
            commands::check_for_updates,
            commands::open_release_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Ensure no FFmpeg child processes stay alive or suspended when the app exits.
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            stop_all(&app_handle.state::<AppState>());
        }
    });
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    use crate::ffmpeg::{
        build_ffmpeg_args, build_output_path, compute_active_elapsed_secs, concurrent_jobs,
        get_resolution_args, publish_output, validate_output,
    };
    #[cfg(target_os = "windows")]
    use crate::process::CREATE_NO_WINDOW;
    use crate::process::{set_queue_paused, stop_all};
    use crate::queue::run_pool;
    use crate::state::{write_log, AppState};
    use crate::tools::{ffmpeg_exe, ffprobe_exe, find_tool_pair, has_tool_pair, media_tools_directory};
    use crate::updater::{is_allowed_github_url, is_newer_version, parse_github_release};

    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "encodex-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn custom_resolution_accepts_ui_strings_and_rounds_even() {
        let settings = serde_json::json!({"resolutionMode":"custom", "customWidth":"1281", "customHeight":"721"});
        assert_eq!(
            get_resolution_args(&settings, &serde_json::json!({})).unwrap(),
            vec!["-vf", "scale=1280:720"]
        );
    }

    #[test]
    fn audio_only_formats_force_vn_even_if_export_video_true() {
        for fmt in ["mp3", "wav", "aac"] {
            let settings = serde_json::json!({"renderer": "nvidia", "resolutionMode": "1920x1080"});
            let item = serde_json::json!({"format": fmt, "exportVideo": true, "exportAudio": true});
            let args = build_ffmpeg_args("in.mp4", "out.audio", &settings, &item);
            assert!(args.contains(&"-vn".to_string()), "{fmt} must pass -vn");
            assert!(!args.contains(&"0:v:0?".to_string()), "{fmt} must not map video");
            assert!(!args.contains(&"-vf".to_string()), "{fmt} must not scale video");
        }
    }

    #[test]
    fn prores_and_webm_cap_cpu_threads_under_concurrency_even_with_nvidia_renderer() {
        let settings = serde_json::json!({"renderer": "nvidia", "concurrentJobs": 4});
        for fmt in ["mov_prores", "webm"] {
            let item = serde_json::json!({"format": fmt, "exportVideo": true, "exportAudio": true});
            let args = build_ffmpeg_args("in.mp4", "out.file", &settings, &item);
            assert!(args.contains(&"-threads:v".to_string()), "{fmt} should cap CPU threads");
        }
    }

    #[test]
    fn nvenc_args_align_mov_h264_and_keep_hevc_pascal_safe() {
        let settings = serde_json::json!({"renderer": "nvidia"});
        let mov = serde_json::json!({"format": "mov_h264", "preset": "mov_h264_high"});
        let mov_args = build_ffmpeg_args("in.mp4", "out.mov", &settings, &mov);
        assert!(mov_args.contains(&"-spatial-aq".to_string()));
        assert!(mov_args.contains(&"-temporal-aq".to_string()));

        let hevc = serde_json::json!({"format": "h265_mp4", "preset": "h265_high"});
        let hevc_args = build_ffmpeg_args("in.mp4", "out.mp4", &settings, &hevc);
        assert!(hevc_args.contains(&"-spatial-aq".to_string()));
        assert!(!hevc_args.contains(&"-temporal-aq".to_string()));
    }

    #[test]
    fn active_elapsed_subtracts_paused_time() {
        let active = compute_active_elapsed_secs(Duration::from_secs(120), Duration::from_secs(90));
        assert!((active - 30.0).abs() < 0.001);
    }

    #[test]
    fn build_output_path_same_folder_and_reservations() {
        let dir = scratch();
        let src = dir.join("clip.mov");
        let settings = serde_json::json!({"outputMode": "same_folder"});
        let item = serde_json::json!({"format": "h264_mp4"});
        let mut reserved = HashSet::new();
        let first = build_output_path(src.to_str().unwrap(), &settings, &item, &mut reserved);
        let second = build_output_path(src.to_str().unwrap(), &settings, &item, &mut reserved);
        assert!(first.ends_with("clip_encoded.mp4"));
        assert!(second.ends_with("clip_001.mp4"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn publish_does_not_destroy_existing_output_without_overwrite() {
        let dir = scratch();
        let src = dir.join("temporary.mp4");
        let dst = dir.join("final.mp4");
        std::fs::write(&src, b"new").unwrap();
        std::fs::write(&dst, b"old").unwrap();
        assert!(publish_output(src.to_str().unwrap(), dst.to_str().unwrap(), false).is_err());
        assert_eq!(std::fs::read(&dst).unwrap(), b"old");
        publish_output(src.to_str().unwrap(), dst.to_str().unwrap(), true).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"new");
        assert!(!src.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn encode_and_validate_real_media() {
        let dir = scratch();
        let src = dir.join("source.mp4");
        let dst = dir.join("output.part.mp4");
        let mut fixture = Command::new(ffmpeg_exe());
        fixture.args([
            "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "color=c=blue:s=160x90:r=25", "-t", "1", "-c:v", "libx264", "-y",
            src.to_str().unwrap(),
        ]);
        assert!(fixture.status().unwrap().success());
        let settings = serde_json::json!({"renderer":"cpu"});
        let item = serde_json::json!({"format":"h264_mp4","preset":"h264_balanced","exportVideo":true,"exportAudio":false});
        let output = Command::new(ffmpeg_exe())
            .args(build_ffmpeg_args(src.to_str().unwrap(), dst.to_str().unwrap(), &settings, &item))
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(validate_output(dst.to_str().unwrap(), 1.0).is_ok());
        assert!(validate_output(dst.to_str().unwrap(), 100.0).is_err());
        let invalid = dir.join("invalid.mp4");
        std::fs::write(&invalid, b"broken").unwrap();
        assert!(validate_output(invalid.to_str().unwrap(), 1.0).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn job_limit_is_always_one_to_five() {
        for (value, expected) in [(0, 1), (-9, 1), (1, 1), (3, 3), (5, 5), (100, 5)] {
            assert_eq!(concurrent_jobs(&serde_json::json!({"concurrentJobs": value})), expected);
        }
        assert_eq!(concurrent_jobs(&serde_json::json!({})), 1);
        assert_eq!(concurrent_jobs(&serde_json::json!({"concurrentJobs": "5"})), 5);
    }

    #[test]
    fn pool_processes_each_item_once_and_respects_limit() {
        for limit in [1, 2, 5] {
            let state = AppState::new();
            let active = AtomicUsize::new(0);
            let peak = AtomicUsize::new(0);
            let visits: Vec<_> = (0..15).map(|_| AtomicUsize::new(0)).collect();
            run_pool(&state, 15, limit, |index| {
                visits[index].fetch_add(1, Ordering::SeqCst);
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(20));
                active.fetch_sub(1, Ordering::SeqCst);
            });
            assert!(visits.iter().all(|n| n.load(Ordering::SeqCst) == 1));
            assert_eq!(peak.load(Ordering::SeqCst), limit);
        }
    }

    #[test]
    fn paused_pool_does_not_start_and_stop_discards_waiting_jobs() {
        let state = AppState::new();
        state.0.lock().unwrap().is_paused = true;
        let started = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                run_pool(&state, 20, 5, |_| {
                    started.fetch_add(1, Ordering::SeqCst);
                })
            });
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(started.load(Ordering::SeqCst), 0);
            stop_all(&state);
        });
        assert_eq!(started.load(Ordering::SeqCst), 0);

        let state = AppState::new();
        run_pool(&state, 20, 1, |_| {
            started.fetch_add(1, Ordering::SeqCst);
            stop_all(&state);
        });
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn pause_resume_stop_control_multiple_real_children() {
        let state = AppState::new();
        let log = std::env::temp_dir().join(format!("encodex-controls-{}.log", std::process::id()));
        {
            let mut inner = state.0.lock().unwrap();
            inner.running = true;
            inner.log_file = Some(log.to_string_lossy().to_string());
            for index in 0..2 {
                let child = Command::new(ffmpeg_exe())
                    .args([
                        "-nostdin", "-v", "error", "-re", "-f", "lavfi", "-i",
                        "color=s=16x16:r=1", "-t", "30", "-f", "null", "-",
                    ])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .unwrap();
                inner.children.insert(index, child);
            }
        }
        assert!(set_queue_paused(&state, true));
        assert!(state.0.lock().unwrap().is_paused);
        std::thread::sleep(Duration::from_millis(30));
        assert!(set_queue_paused(&state, false));
        assert!(!state.0.lock().unwrap().is_paused);
        assert!(state.0.lock().unwrap().paused_total >= Duration::from_millis(20));
        stop_all(&state);
        for child in state.0.lock().unwrap().children.values_mut() {
            assert!(!child.wait().unwrap().success());
        }
        let _ = std::fs::remove_file(log);
    }

    #[test]
    fn five_workers_encode_real_files_and_one_failure_does_not_block_others() {
        let dir = scratch();
        let source = dir.join("source.mp4");
        let fixture = Command::new(ffmpeg_exe())
            .args([
                "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                "color=s=160x90:r=10", "-t", "1", "-c:v", "libx264", "-y",
                source.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(fixture.status.success());

        let state = AppState::new();
        let successes = AtomicUsize::new(0);
        let failures = AtomicUsize::new(0);
        run_pool(&state, 7, 5, |index| {
            let target = dir.join(format!("output-{}.mp4", index));
            let src = if index == 2 {
                dir.join("missing.mp4")
            } else {
                source.clone()
            };
            let settings = serde_json::json!({"renderer":"cpu","concurrentJobs":5});
            let item = serde_json::json!({"format":"h264_mp4","preset":"h264_small","exportVideo":true,"exportAudio":false});
            let output = Command::new(ffmpeg_exe())
                .args(build_ffmpeg_args(
                    src.to_str().unwrap(),
                    target.to_str().unwrap(),
                    &settings,
                    &item,
                ))
                .output()
                .unwrap();
            if output.status.success() {
                validate_output(target.to_str().unwrap(), 1.0).unwrap();
                successes.fetch_add(1, Ordering::SeqCst);
            } else {
                failures.fetch_add(1, Ordering::SeqCst);
            }
        });
        assert_eq!(successes.load(Ordering::SeqCst), 6);
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn log_is_written_and_emitted_once_after_unlocking_state() {
        let state = AppState::new();
        let path = std::env::temp_dir().join(format!("encodex-live-log-{}.txt", std::process::id()));
        std::fs::write(&path, "").unwrap();
        let messages = Arc::new(Mutex::new(Vec::<String>::new()));
        let received = messages.clone();
        let weak = Arc::downgrade(&state.0);
        {
            let mut inner = state.0.lock().unwrap();
            inner.log_file = Some(path.to_string_lossy().to_string());
            inner.log_emitter = Some(Arc::new(move |message| {
                assert!(weak.upgrade().unwrap().try_lock().is_ok());
                received.lock().unwrap().push(message.to_string());
            }));
        }
        write_log(&state, "[Job 3] Tiến độ: 50%");
        assert_eq!(*messages.lock().unwrap(), vec!["[Job 3] Tiến độ: 50%"]);
        assert!(std::fs::read_to_string(&path).unwrap().contains("Tiến độ: 50%"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn nested_pair_is_found_but_incomplete_and_out_of_depth_are_not() {
        let root = scratch();
        let bin = root.join("ffmpeg-release").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("ffmpeg.exe"), b"test").unwrap();
        assert!(find_tool_pair(&root, 3).is_none());
        std::fs::write(bin.join("ffprobe.exe"), b"test").unwrap();
        assert_eq!(find_tool_pair(&root, 3), Some(bin.clone()));
        assert!(find_tool_pair(&root, 1).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detection_uses_installed_tools_on_this_machine() {
        let directory = media_tools_directory()
            .expect("This integration test needs an existing FFmpeg pair");
        assert!(has_tool_pair(&directory));
        assert!(Path::new(&ffmpeg_exe()).is_absolute());
        assert!(Path::new(&ffprobe_exe()).is_absolute());
    }

    #[test]
    fn updater_compares_semver_and_validates_github_urls() {
        assert!(is_newer_version("0.4.0", "v0.4.1"));
        assert!(is_newer_version("0.4.0", "1.0.0"));
        assert!(!is_newer_version("0.4.0", "v0.4.0"));
        assert!(!is_newer_version("0.4.1", "0.4.0"));

        assert!(is_allowed_github_url(
            "https://github.com/csvt1nguyenson/EncodeX/releases/tag/v0.5.0"
        ));
        assert!(!is_allowed_github_url("https://evil.example.com/setup.exe"));

        let body = r#"{
            "tag_name": "v0.5.0",
            "html_url": "https://github.com/csvt1nguyenson/EncodeX/releases/tag/v0.5.0",
            "body": "Faster NVENC queue",
            "assets": [
                {"name": "EncodeX_0.5.0_x64-setup.exe", "browser_download_url": "https://github.com/csvt1nguyenson/EncodeX/releases/download/v0.5.0/EncodeX_0.5.0_x64-setup.exe"}
            ]
        }"#;
        let parsed = parse_github_release("0.4.0", body).unwrap();
        assert!(parsed.has_update);
        assert_eq!(parsed.latest_version, "0.5.0");
        assert!(parsed.download_url.ends_with("EncodeX_0.5.0_x64-setup.exe"));
    }
}
