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
            let state = app_handle.state::<AppState>();
            stop_all(&state);
            // Give workers up to 5 seconds to delete their partial files.
            for _ in 0..100 {
                if !state.0.lock().unwrap().running {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
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
        expected_duration, get_resolution_filter, path_key, probe_info_sync, publish_output, validate_output,
    };
    #[cfg(target_os = "windows")]
    use crate::process::CREATE_NO_WINDOW;
    use crate::process::{set_queue_paused, stop_all};
    use crate::queue::{run_one_job, run_pool};
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
            get_resolution_filter(&settings, &serde_json::json!({})).unwrap(),
            "scale=iw*sar:ih,setsar=1,scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1"
        );
    }

    #[test]
    fn audio_only_formats_force_vn_even_if_export_video_true() {
        for fmt in ["mp3", "wav", "aac"] {
            let settings = serde_json::json!({"renderer": "nvidia", "resolutionMode": "1920x1080"});
            let item = serde_json::json!({"format": fmt, "exportVideo": true, "exportAudio": true});
            let args = build_ffmpeg_args("in.mp4", "out.audio", &settings, &item);
            assert!(args.contains(&"-vn".to_string()), "{fmt} must pass -vn");
            assert!(!args.contains(&"0:V:0?".to_string()), "{fmt} must not map video");
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

    fn ffmpeg(args: &[&str]) {
        let output = Command::new(ffmpeg_exe())
            .args(["-nostdin", "-v", "error", "-y"])
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    /// Runs one job to the end; fails instead of hanging if the job never finishes.
    fn finish_job(source: &Path, item: serde_json::Value, action: &str) -> serde_json::Value {
        let dir = source.parent().unwrap().to_path_buf();
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            let log = dir.join("job.log");
            std::fs::write(&log, "").unwrap();
            inner.log_file = Some(log.to_string_lossy().to_string());
        }
        let mut item = item;
        item["source"] = source.to_string_lossy().to_string().into();
        item["status"] = "Ready".into();
        let settings = serde_json::json!({
            "renderer": "cpu",
            "outputMode": "custom_folder",
            "customFolder": dir.join("out").to_string_lossy(),
            "existingAction": action
        });
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let last = Mutex::new(serde_json::Value::Null);
            let emit = |event: &str, data: serde_json::Value| {
                if event == "queue-update" {
                    *last.lock().unwrap() = data["data"].clone();
                }
            };
            run_one_job(&emit, &state, &settings, &item, 0, 1, &Mutex::new(HashSet::new()));
            let result = last.lock().unwrap().clone();
            tx.send(result).unwrap();
        });
        rx.recv_timeout(Duration::from_secs(60)).expect("job never finished")
    }

    #[test]
    fn job_finishes_and_handles_awkward_sources() {
        let dir = scratch();
        let path = |name: &str| dir.join(name);
        let text = |name: &str| dir.join(name).to_string_lossy().to_string();

        // Short audio, two audio tracks and odd dimensions.
        ffmpeg(&[
            "-f", "lavfi", "-i", "testsrc=s=161x91:r=10:d=8", "-f", "lavfi", "-i", "sine=d=2",
            "-f", "lavfi", "-i", "sine=d=2", "-map", "0", "-map", "1", "-map", "2",
            "-c:v", "ffv1", "-pix_fmt", "yuv444p", "-c:a", "pcm_s16le", &text("a.mkv"),
        ]);
        for format in ["h264_mp4", "h265_mp4", "mp3", "wav", "aac"] {
            let done = finish_job(&path("a.mkv"), serde_json::json!({"format": format}), "autorename");
            assert_eq!(done["status"], "Done", "{format}: {done}");
        }

        // Cover art is not video.
        ffmpeg(&[
            "-f", "lavfi", "-i", "sine=d=1", "-f", "lavfi", "-i", "color=s=64x64:d=1:r=1",
            "-map", "0", "-map", "1", "-c:a", "libmp3lame", "-c:v", "mjpeg",
            "-disposition:v", "attached_pic", &text("cover.mp3"),
        ]);
        let done = finish_job(&path("cover.mp3"), serde_json::json!({"format": "h265_mp4"}), "autorename");
        assert_eq!(done["status"], "Done", "{done}");

        // 5.1(side) audio to Opus.
        ffmpeg(&["-f", "lavfi", "-i", "anullsrc=cl=5.1(side):d=1", "-c:a", "pcm_s16le", &text("side.wav")]);
        let done = finish_job(&path("side.wav"), serde_json::json!({"format": "webm"}), "autorename");
        assert_eq!(done["status"], "Done", "{done}");

        // A missing source fails and leaves no partial file.
        let failed = finish_job(&path("missing.mov"), serde_json::json!({"format": "h264_mp4"}), "autorename");
        assert_eq!(failed["status"], "Failed");

        // A publish failure keeps the finished encode (a directory blocks the output name).
        std::fs::create_dir_all(path("out").join("side.mp3")).unwrap();
        let failed = finish_job(&path("side.wav"), serde_json::json!({"format": "mp3"}), "overwrite");
        assert_eq!(failed["status"], "Failed", "{failed}");
        assert!(failed["error"].as_str().unwrap().contains("kept at"), "{failed}");
        let parts = std::fs::read_dir(path("out"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".part."))
            .count();
        assert_eq!(parts, 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn output_never_lands_on_another_queued_source() {
        let dir = scratch();
        let other = dir.join("clip.mp4");
        std::fs::write(&other, b"original").unwrap();
        // The same folder spelled differently is still the same file.
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let custom = dir.join("sub").join("..");
        let settings = serde_json::json!({
            "outputMode": "custom_folder",
            "customFolder": custom.to_string_lossy()
        });
        let mut reserved = HashSet::from([path_key(&other.to_string_lossy())]);
        let output = build_output_path(
            dir.join("clip.mov").to_str().unwrap(),
            &settings,
            &serde_json::json!({"format": "h264_mp4"}),
            &mut reserved,
        );
        assert_ne!(path_key(&output), path_key(&other.to_string_lossy()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hdr_keeps_10_bit_in_hevc_and_tonemaps_in_h264() {
        let dir = scratch();
        let src = dir.join("hdr.mp4").to_string_lossy().to_string();
        ffmpeg(&[
            "-f", "lavfi", "-i", "testsrc=s=160x90:r=10:d=1", "-vf", "format=yuv420p10le",
            "-c:v", "libx265", "-x265-params",
            "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", &src,
        ]);
        let cases = [("h265_mp4", "yuv420p10le", "smpte2084"), ("h264_mp4", "yuv420p", "bt709")];
        for (format, depth, transfer) in cases {
            let item = serde_json::json!({"format": format, "info": probe_info_sync(&src)});
            let out = dir.join(format!("{format}.mp4")).to_string_lossy().to_string();
            let args = build_ffmpeg_args(&src, &out, &serde_json::json!({"renderer": "cpu"}), &item);
            ffmpeg(&args.iter().map(String::as_str).collect::<Vec<_>>());
            let info = probe_info_sync(&out);
            assert_eq!(info["pix_fmt"], depth);
            assert_eq!(info["color_transfer"], transfer);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expected_duration_follows_exported_streams() {
        let info = serde_json::json!({"duration_seconds": 20.0, "video_duration": 20.0, "audio_duration": 5.0});
        assert_eq!(expected_duration(&info, false, true), 5.0);
        assert_eq!(expected_duration(&info, true, true), 20.0);
        let unknown = serde_json::json!({"duration_seconds": 20.0});
        assert_eq!(expected_duration(&unknown, true, true), 20.0);
        assert_eq!(expected_duration(&unknown, false, true), 0.0);
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
