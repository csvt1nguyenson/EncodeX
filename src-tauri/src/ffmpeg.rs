use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use crate::process::CREATE_NO_WINDOW;
use crate::tools::ffprobe_exe;

pub fn concurrent_jobs(settings: &serde_json::Value) -> usize {
    settings
        .get("concurrentJobs")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(1)
        .clamp(1, 5) as usize
}

pub fn is_audio_only_format(fmt: &str) -> bool {
    matches!(fmt, "mp3" | "wav" | "aac")
}

pub fn get_extension(fmt: &str) -> &'static str {
    match fmt {
        "h265_mp4" | "h264_mp4" => ".mp4",
        "mov_h264" | "mov_prores" => ".mov",
        "mp3" => ".mp3",
        "wav" => ".wav",
        "aac" => ".m4a",
        "webm" => ".webm",
        _ => ".mp4",
    }
}

pub fn fmt_size(path: &str) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = metadata.len() as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        Some(format!("{} B", value as i32))
    } else {
        Some(format!("{:.1} {}", value, units[unit]))
    }
}

pub fn size_result(source: &str, output: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut result = serde_json::Map::new();
    let before = std::fs::metadata(source).map(|m| m.len()).ok()?;
    let after_size = std::fs::metadata(output).map(|m| m.len()).ok();

    if let Some(before_str) = fmt_size(source) {
        result.insert("sizeBefore".to_string(), serde_json::Value::from(before_str.clone()));
        result.insert("sourceSize".to_string(), serde_json::Value::from(before_str));
    }
    if let Some(after) = after_size {
        if let Some(after_str) = fmt_size(output) {
            result.insert("sizeAfter".to_string(), serde_json::Value::from(after_str));
        }
        if before > 0 {
            let saved = (1.0 - (after as f64 / before as f64)) * 100.0;
            let sign = if saved >= 0.0 { "saved" } else { "larger" };
            result.insert(
                "savedPercent".to_string(),
                serde_json::Value::from(format!("{:.1}% {}", saved.abs(), sign)),
            );
        }
    }
    Some(result)
}

pub fn probe_info_sync(path: &str) -> serde_json::Value {
    let mut info = serde_json::Map::new();

    let mut cmd = Command::new(ffprobe_exe());
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        path,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(output) = cmd.output() {
        let raw = String::from_utf8_lossy(&output.stdout);
        if let Ok(data) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(duration_str) = data
                .get("format")
                .and_then(|fmt| fmt.get("duration"))
                .and_then(|v| v.as_str())
            {
                if let Ok(duration) = duration_str.parse::<f64>() {
                    info.insert("duration_seconds".to_string(), serde_json::Value::from(duration));
                    let h = (duration / 3600.0) as i32;
                    let m = ((duration % 3600.0) / 60.0) as i32;
                    let s = (duration % 60.0) as i32;
                    info.insert(
                        "duration".to_string(),
                        serde_json::Value::from(format!("{:02}:{:02}:{:02}", h, m, s)),
                    );
                }
            }
            if let Some(size_str) = fmt_size(path) {
                info.insert("size".to_string(), serde_json::Value::from(size_str));
            }
            if let Some(streams) = data.get("streams").and_then(|v| v.as_array()) {
                let video = streams
                    .iter()
                    .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("video"));
                let audio = streams
                    .iter()
                    .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"));

                if let Some(v) = video {
                    if let (Some(w), Some(h)) = (v.get("width"), v.get("height")) {
                        info.insert(
                            "resolution".to_string(),
                            serde_json::Value::from(format!("{}x{}", w, h)),
                        );
                    }
                    if let Some(codec) = v.get("codec_name") {
                        info.insert("video_codec".to_string(), codec.clone());
                    }
                    if let Some(fps_val) = v
                        .get("avg_frame_rate")
                        .or(v.get("r_frame_rate"))
                        .and_then(|v| v.as_str())
                    {
                        if fps_val != "0/0" {
                            if let Some((n, d)) = fps_val.split_once('/') {
                                if let (Ok(num), Ok(den)) = (n.parse::<f64>(), d.parse::<f64>()) {
                                    if den > 0.0 {
                                        info.insert(
                                            "fps".to_string(),
                                            serde_json::Value::from(format!("{:.2}", num / den)),
                                        );
                                    }
                                }
                            } else if let Ok(fps) = fps_val.parse::<f64>() {
                                info.insert(
                                    "fps".to_string(),
                                    serde_json::Value::from(format!("{:.2}", fps)),
                                );
                            }
                        }
                    }
                }

                if let Some(a) = audio {
                    if let Some(codec) = a.get("codec_name") {
                        info.insert("audio_codec".to_string(), codec.clone());
                    }
                    if let Some(rate) = a.get("sample_rate") {
                        info.insert("sample_rate".to_string(), rate.clone());
                    }
                }
            }
        }
    }

    if let Ok(metadata) = std::fs::metadata(path) {
        info.insert("size_bytes".to_string(), serde_json::Value::from(metadata.len()));
    }

    serde_json::Value::Object(info)
}

pub fn probe_duration(path: &str) -> f64 {
    let mut cmd = Command::new(ffprobe_exe());
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(output) = cmd.output() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Ok(val) = text.parse::<f64>() {
            return val;
        }
    }
    0.0
}

pub fn validate_output(path: &str, expected: f64) -> Result<(), String> {
    let info = probe_info_sync(path);
    let bytes = info.get("size_bytes").and_then(|v| v.as_u64()).unwrap_or(0);
    let duration = info.get("duration_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if bytes == 0
        || duration <= 0.0
        || (info.get("video_codec").is_none() && info.get("audio_codec").is_none())
    {
        return Err("Output is empty or cannot be read by FFprobe".into());
    }
    if expected > 0.0 && (duration - expected).abs() > (expected * 0.02).max(2.0) {
        return Err(format!(
            "Duration mismatch: source {:.2}s, output {:.2}s",
            expected, duration
        ));
    }
    Ok(())
}

pub fn publish_output(temporary: &str, output: &str, overwrite: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = std::ffi::OsStr::new(temporary)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let to: Vec<u16> = std::ffi::OsStr::new(output)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let flags = MOVEFILE_WRITE_THROUGH | if overwrite { MOVEFILE_REPLACE_EXISTING } else { 0 };
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
            return Err(format!(
                "Cannot publish output: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        if !overwrite && Path::new(output).exists() {
            return Err("Output already exists".into());
        }
        std::fs::rename(temporary, output).map_err(|e| e.to_string())
    }
}

pub fn make_unique_existing_path(output: &str, reserved_outputs: &HashSet<String>) -> String {
    let p = Path::new(output);
    let parent = p.parent().unwrap_or_else(|| Path::new(""));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");

    let mut counter = 1usize;
    loop {
        let candidate = parent
            .join(format!("{}_{:03}.{}", stem, counter, ext))
            .to_string_lossy()
            .to_string();
        if !reserved_outputs.contains(&candidate.to_lowercase()) && !Path::new(&candidate).exists() {
            return candidate;
        }
        counter += 1;
    }
}

pub fn build_output_path(
    source: &str,
    settings: &serde_json::Value,
    item: &serde_json::Value,
    reserved_outputs: &mut HashSet<String>,
) -> String {
    let source_path = Path::new(source);
    let parent = source_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = source_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");

    let format = item.get("format").and_then(|v| v.as_str()).unwrap_or("h264_mp4");
    let ext = get_extension(format);

    let output_mode = item
        .get("outputMode")
        .or(settings.get("outputMode"))
        .and_then(|v| v.as_str())
        .unwrap_or("source_output");
    let custom_folder = item
        .get("customFolder")
        .or(settings.get("customFolder"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let out_folder = if output_mode == "same_folder" {
        parent.to_path_buf()
    } else if output_mode == "custom_folder" && !custom_folder.is_empty() {
        PathBuf::from(custom_folder)
    } else {
        let folder_name = parent.file_name().and_then(|s| s.to_str()).unwrap_or("");
        parent.join(format!("{}_OUTPUT", folder_name))
    };

    let _ = std::fs::create_dir_all(&out_folder);
    let suffix = if output_mode == "same_folder" { "_encoded" } else { "" };

    let mut candidate = out_folder.join(format!("{}{}{}", stem, suffix, ext));
    if candidate.to_string_lossy().to_lowercase() == source.to_lowercase() {
        candidate = out_folder.join(format!("{}_encoded{}", stem, ext));
    }

    let mut final_str = candidate.to_string_lossy().to_string();
    let mut counter = 1usize;
    while reserved_outputs.contains(&final_str.to_lowercase()) {
        final_str = out_folder
            .join(format!("{}_{:03}{}", stem, counter, ext))
            .to_string_lossy()
            .to_string();
        counter += 1;
    }
    reserved_outputs.insert(final_str.to_lowercase());
    final_str
}

pub fn build_ffmpeg_args(
    source: &str,
    output: &str,
    settings: &serde_json::Value,
    item: &serde_json::Value,
) -> Vec<String> {
    let fmt = item.get("format").and_then(|v| v.as_str()).unwrap_or("h264_mp4");
    let preset = item.get("preset").and_then(|v| v.as_str()).unwrap_or("h264_balanced");
    let renderer = settings.get("renderer").and_then(|v| v.as_str()).unwrap_or("nvidia");
    // Audio-only formats must never attempt to map or filter video streams.
    let export_video = if is_audio_only_format(fmt) {
        false
    } else {
        item.get("exportVideo").and_then(|v| v.as_bool()).unwrap_or(true)
    };
    let export_audio = item.get("exportAudio").and_then(|v| v.as_bool()).unwrap_or(true);

    let mut args = vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        source.to_string(),
    ];

    if export_video {
        args.extend(["-map".to_string(), "0:v:0?".to_string()]);
    }
    if export_audio {
        args.extend(["-map".to_string(), "0:a?".to_string()]);
    }

    if settings.get("copyMetadata").and_then(|v| v.as_bool()).unwrap_or(true) {
        args.extend(["-map_metadata".to_string(), "0".to_string()]);
    }

    if !export_video {
        args.push("-vn".to_string());
    }
    if !export_audio {
        args.push("-an".to_string());
    }

    if export_video {
        if let Some(res_args) = get_resolution_args(settings, item) {
            args.extend(res_args);
        }
        if let Some(fps_args) = get_fps_args(settings, item) {
            args.extend(fps_args);
        } else {
            args.extend(["-fps_mode".to_string(), "passthrough".to_string()]);
        }
    }

    args.extend([
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
    ]);

    match fmt {
        "h265_mp4" => {
            if export_video {
                if renderer == "cpu" {
                    let crf = match preset {
                        "h265_high" => "16",
                        "h265_small" => "28",
                        _ => "22",
                    };
                    args.extend([
                        "-c:v", "libx265", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p",
                    ].map(str::to_string));
                } else {
                    let cq = match preset {
                        "h265_high" => "17",
                        "h265_small" => "28",
                        _ => "23",
                    };
                    // Omit -temporal-aq on HEVC NVENC so Pascal (GTX 10xx) GPUs remain compatible.
                    args.extend([
                        "-c:v", "hevc_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr",
                        "-cq:v", cq, "-b:v", "0", "-spatial-aq", "1", "-aq-strength", "8",
                        "-pix_fmt", "yuv420p",
                    ].map(str::to_string));
                }
            }
            if export_audio {
                args.extend(["-c:a", "aac", "-b:a", "192k"].map(str::to_string));
            }
            args.extend(["-movflags", "+faststart"].map(str::to_string));
        }
        "h264_mp4" => {
            if export_video {
                if renderer == "cpu" {
                    let crf = match preset {
                        "h264_high" => "16",
                        "h264_small" => "27",
                        _ => "21",
                    };
                    args.extend([
                        "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p",
                    ].map(str::to_string));
                } else {
                    let cq = match preset {
                        "h264_high" => "17",
                        "h264_small" => "28",
                        _ => "22",
                    };
                    args.extend([
                        "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr",
                        "-cq:v", cq, "-b:v", "0", "-spatial-aq", "1", "-temporal-aq", "1",
                        "-aq-strength", "8", "-pix_fmt", "yuv420p",
                    ].map(str::to_string));
                }
            }
            if export_audio {
                args.extend(["-c:a", "aac", "-b:a", "192k"].map(str::to_string));
            }
            args.extend(["-movflags", "+faststart"].map(str::to_string));
        }
        "mov_h264" => {
            if export_video {
                if renderer == "cpu" {
                    let crf = if preset == "mov_h264_high" { "18" } else { "21" };
                    args.extend([
                        "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p",
                    ].map(str::to_string));
                } else {
                    let cq = if preset == "mov_h264_high" { "19" } else { "23" };
                    args.extend([
                        "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr",
                        "-cq:v", cq, "-b:v", "0", "-spatial-aq", "1", "-temporal-aq", "1",
                        "-aq-strength", "8", "-pix_fmt", "yuv420p",
                    ].map(str::to_string));
                }
            }
            if export_audio {
                args.extend(["-c:a", "aac", "-b:a", "192k"].map(str::to_string));
            }
        }
        "mov_prores" => {
            if export_video {
                let profile = if preset == "prores_4444_alpha" { "4" } else { "3" };
                let pix = if preset == "prores_4444_alpha" {
                    "yuva444p10le"
                } else {
                    "yuv422p10le"
                };
                args.extend([
                    "-c:v", "prores_ks", "-profile:v", profile, "-pix_fmt", pix,
                ].map(str::to_string));
            }
            if export_audio {
                args.extend(["-c:a", "pcm_s16le"].map(str::to_string));
            }
        }
        "mp3" => {
            let br = if preset == "mp3_128" { "128k" } else { "320k" };
            args.extend(["-c:a", "libmp3lame", "-b:a", br].map(str::to_string));
        }
        "wav" => {
            args.extend(["-c:a", "pcm_s16le", "-ar", "48000"].map(str::to_string));
        }
        "aac" => {
            args.extend(["-c:a", "aac", "-b:a", "192k"].map(str::to_string));
        }
        "webm" => {
            if export_video {
                args.extend([
                    "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0",
                ].map(str::to_string));
            }
            if export_audio {
                args.extend(["-c:a", "libopus", "-b:a", "128k"].map(str::to_string));
            }
        }
        _ => {
            if export_video {
                args.extend(["-c:v", "copy"].map(str::to_string));
            }
            if export_audio {
                args.extend(["-c:a", "copy"].map(str::to_string));
            }
        }
    }

    // Cap per-worker video threads whenever the actual video encoder runs on CPU.
    let uses_cpu_video_encoder =
        export_video && (renderer == "cpu" || matches!(fmt, "mov_prores" | "webm"));
    let jobs = concurrent_jobs(settings);
    if uses_cpu_video_encoder && jobs > 1 {
        let threads = (std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            / jobs)
            .max(1);
        args.extend(["-threads:v".to_string(), threads.to_string()]);
        if fmt == "h265_mp4" && renderer == "cpu" {
            args.extend([
                "-x265-params".to_string(),
                format!("pools={}:frame-threads=1", threads),
            ]);
        }
    }

    args.push(output.to_string());
    args
}

pub fn get_resolution_args(
    settings: &serde_json::Value,
    item: &serde_json::Value,
) -> Option<Vec<String>> {
    let mode = item
        .get("resolutionMode")
        .or(settings.get("resolutionMode"))
        .and_then(|v| v.as_str())
        .unwrap_or("source");
    if mode == "source" {
        return None;
    }

    let (width, height) = if mode == "custom" {
        let w = item
            .get("customWidth")
            .or(settings.get("customWidth"))
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0);
        let h = item
            .get("customHeight")
            .or(settings.get("customHeight"))
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0);
        (w, h)
    } else if let Some((w_str, h_str)) = mode.split_once('x') {
        (w_str.parse::<i64>().unwrap_or(0), h_str.parse::<i64>().unwrap_or(0))
    } else {
        (0, 0)
    };

    if width >= 16 && height >= 16 {
        let w = width - (width % 2);
        let h = height - (height % 2);
        Some(vec!["-vf".to_string(), format!("scale={}:{}", w, h)])
    } else {
        None
    }
}

pub fn get_fps_args(settings: &serde_json::Value, item: &serde_json::Value) -> Option<Vec<String>> {
    let mode = item
        .get("fpsMode")
        .or(settings.get("fpsMode"))
        .and_then(|v| v.as_str())
        .unwrap_or("source");
    if mode == "source" {
        return None;
    }

    let fps_str = if mode == "custom" {
        item.get("customFps")
            .or(settings.get("customFps"))
            .and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_f64().map(|f| f.to_string())))
            .unwrap_or_default()
    } else {
        mode.to_string()
    };

    if let Ok(fps) = fps_str.parse::<f64>() {
        if fps > 0.0 && fps <= 240.0 {
            return Some(vec!["-r".to_string(), fps_str]);
        }
    }
    None
}

pub fn format_eta(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "--".to_string();
    }
    let s = seconds.round() as i64;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    if h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, sec)
    } else {
        format!("{:02}:{:02}", m, sec)
    }
}

pub fn compute_active_elapsed_secs(
    wall_elapsed: std::time::Duration,
    paused_delta: std::time::Duration,
) -> f64 {
    wall_elapsed.saturating_sub(paused_delta).as_secs_f64()
}
