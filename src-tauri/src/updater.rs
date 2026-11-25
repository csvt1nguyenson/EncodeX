use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::Serialize;

#[cfg(target_os = "windows")]
use crate::process::CREATE_NO_WINDOW;

pub const GITHUB_REPO: &str = "csvt1nguyenson/EncodeX";
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub no_release: bool,
    pub release_url: String,
    pub download_url: String,
    pub notes: String,
}

pub fn parse_semver(version: &str) -> Option<(u64, u64, u64)> {
    let cleaned = version.trim().trim_start_matches(['v', 'V']);
    let core = cleaned.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some((major, minor, patch))
}

pub fn is_newer_version(current: &str, latest: &str) -> bool {
    match (parse_semver(current), parse_semver(latest)) {
        (Some(cur), Some(lat)) => lat > cur,
        _ => false,
    }
}

pub fn is_allowed_github_url(url: &str) -> bool {
    let prefix = format!("https://github.com/{}/", GITHUB_REPO);
    url.starts_with(&prefix) && !url.contains([' ', '\r', '\n', '"'])
}

pub fn parse_github_release(current_version: &str, body: &str) -> Result<UpdateCheckResult, String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Invalid GitHub release JSON: {}", e))?;

    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if tag.is_empty() {
        return Err("Latest release has no tag_name.".into());
    }
    let latest_version = tag.trim_start_matches(['v', 'V']).to_string();

    let default_release_url = format!("https://github.com/{}/releases/latest", GITHUB_REPO);
    let release_url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .filter(|u| is_allowed_github_url(u))
        .unwrap_or(&default_release_url)
        .to_string();

    // Prefer the x64 NSIS setup executable if attached to the release.
    let download_url = json
        .get("assets")
        .and_then(|v| v.as_array())
        .and_then(|assets| {
            let pick = |pred: fn(&str) -> bool| {
                assets.iter().find_map(|asset| {
                    let name = asset.get("name").and_then(|v| v.as_str())?.to_lowercase();
                    let url = asset.get("browser_download_url").and_then(|v| v.as_str())?;
                    if pred(&name) && is_allowed_github_url(url) {
                        Some(url.to_string())
                    } else {
                        None
                    }
                })
            };
            pick(|n| n.ends_with("-setup.exe") || n.ends_with("_setup.exe"))
                .or_else(|| pick(|n| n.ends_with(".exe")))
        })
        .unwrap_or_else(|| release_url.clone());

    let notes = json
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .chars()
        .take(3000)
        .collect::<String>();

    Ok(UpdateCheckResult {
        current_version: current_version.to_string(),
        latest_version: latest_version.clone(),
        has_update: is_newer_version(current_version, &latest_version),
        no_release: false,
        release_url,
        download_url,
        notes,
    })
}

pub fn check_for_updates_sync() -> Result<UpdateCheckResult, String> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let user_agent = format!("EncodeX/{}", CURRENT_VERSION);

    #[cfg(target_os = "windows")]
    let curl_path = std::env::var("SystemRoot")
        .map(|root| format!("{}\\System32\\curl.exe", root))
        .unwrap_or_else(|_| "curl.exe".to_string());
    #[cfg(not(target_os = "windows"))]
    let curl_path = "curl".to_string();

    let mut cmd = Command::new(curl_path);
    cmd.args([
        "--silent",
        "--show-error",
        "--location",
        "--connect-timeout",
        "8",
        "--max-time",
        "15",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        &format!("User-Agent: {}", user_agent),
        "-w",
        "\n%{http_code}",
        &url,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("Failed to run curl: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Network request failed.".into()
        } else {
            stderr
        });
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let (body, code_str) = raw
        .rsplit_once('\n')
        .ok_or_else(|| "Unexpected response format.".to_string())?;
    let status_code = code_str.trim().parse::<u16>().unwrap_or(0);

    if status_code == 404 {
        return Ok(UpdateCheckResult {
            current_version: CURRENT_VERSION.to_string(),
            latest_version: CURRENT_VERSION.to_string(),
            has_update: false,
            no_release: true,
            release_url: format!("https://github.com/{}/releases", GITHUB_REPO),
            download_url: format!("https://github.com/{}/releases", GITHUB_REPO),
            notes: String::new(),
        });
    }

    if status_code != 200 {
        return Err(format!("GitHub API returned HTTP {}.", status_code));
    }

    parse_github_release(CURRENT_VERSION, body)
}
