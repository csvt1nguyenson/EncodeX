use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use crate::process::CREATE_NO_WINDOW;
use crate::state::{write_log, AppState};

static MEDIA_TOOLS: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
static MEDIA_INSTALL: Mutex<()> = Mutex::new(());

pub fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

pub fn has_tool_pair(directory: &Path) -> bool {
    directory.join("ffmpeg.exe").is_file() && directory.join("ffprobe.exe").is_file()
}

pub fn find_tool_pair(root: &Path, depth: usize) -> Option<PathBuf> {
    if has_tool_pair(root) {
        return Some(root.to_path_buf());
    }
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(root).ok()?;
    let mut directories: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            if kind.is_dir() && !kind.is_symlink() {
                Some(entry.path())
            } else {
                None
            }
        })
        .take(128)
        .collect();
    directories.sort();
    directories
        .into_iter()
        .find_map(|directory| find_tool_pair(&directory, depth - 1))
}

fn discover_media_tools() -> Option<PathBuf> {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    for name in ["Mybin", "My Bin", "My_Bin"] {
        if let Some(path) = find_tool_pair(&PathBuf::from(format!("{}\\{}", drive, name)), 3) {
            return Some(path);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            if directory.is_absolute() && has_tool_pair(&directory) {
                return Some(directory);
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        if let Some(path) =
            find_tool_pair(&PathBuf::from(local).join("EncodeX").join("tools"), 3)
        {
            return Some(path);
        }
    }
    let local_bin = app_dir().join("bin");
    if has_tool_pair(&local_bin) {
        return Some(local_bin);
    }
    None
}

pub fn media_tools_directory() -> Option<PathBuf> {
    let mut cached = MEDIA_TOOLS.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if let Some(path) = cached.as_ref().filter(|path| has_tool_pair(path)) {
        return Some(path.clone());
    }
    *cached = discover_media_tools();
    cached.clone()
}

pub fn tool_path(exe_name: &str) -> String {
    media_tools_directory()
        .map(|directory| directory.join(exe_name).to_string_lossy().to_string())
        .unwrap_or_else(|| exe_name.to_string())
}

pub fn ffmpeg_exe() -> String {
    tool_path("ffmpeg.exe")
}

pub fn ffprobe_exe() -> String {
    tool_path("ffprobe.exe")
}

pub fn prepare_tools(state: &AppState) -> Result<String, String> {
    let _guard = MEDIA_INSTALL.lock().unwrap();
    if let Some(directory) = media_tools_directory() {
        let message = format!("FFmpeg/FFprobe: {}", directory.display());
        write_log(state, &message);
        return Ok(message);
    }
    write_log(
        state,
        "FFmpeg/FFprobe not found. Downloading and verifying automatically...",
    );

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            include_str!("install_ffmpeg.ps1"),
        ]);
        command
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stderr = child.stderr.take().unwrap();
        let error_reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut text);
            text
        });

        let mut last_message = String::new();
        for line in BufReader::new(child.stdout.take().unwrap())
            .lines()
            .map_while(Result::ok)
        {
            write_log(state, &line);
            last_message = line;
        }

        let status = child.wait().map_err(|error| error.to_string())?;
        let errors = error_reader.join().unwrap_or_default();
        if !status.success() {
            return Err(format!(
                "Unable to download FFmpeg: {} {}. Check your Internet connection and retry.",
                last_message, errors
            ));
        }
        if let Some(directory) = media_tools_directory() {
            return Ok(format!("FFmpeg/FFprobe: {}", directory.display()));
        }
        Err("Download finished but no valid FFmpeg/FFprobe pair was found.".into())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Automatic FFmpeg installation requires Windows.".into())
    }
}
