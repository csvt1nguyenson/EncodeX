<p align="center">
  <img src="src/assets/logo.png" alt="EncodeX" width="110" />
</p>

<h1 align="center">EncodeX</h1>

<p align="center">
  Fast, clean batch video &amp; audio encoder for Windows x64.<br />
  Powered by FFmpeg, NVIDIA NVENC, and Tauri v2.
</p>

<p align="center">
  <a href="https://github.com/csvt1nguyenson/EncodeX/releases/latest">
    <img src="https://img.shields.io/badge/Download-Windows%20x64%20(v0.4.1)-06B6D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download EncodeX for Windows x64" />
  </a>
</p>

---

## Download & Install

1. Download **`EncodeX_0.4.1_x64-setup.exe`** from the [**Latest Release**](https://github.com/csvt1nguyenson/EncodeX/releases/latest).
2. Run the installer and follow the on-screen steps.
3. **FFmpeg & FFprobe are set up automatically:** if your PC does not already have them installed, the installer downloads and verifies an official essentials build for you *(Internet connection required on first setup)*.

> **Requirements:** Windows 10 / 11 (64-bit). NVIDIA GPU recommended for NVENC hardware encoding; CPU Software mode is supported on all PCs.

---

## Features

- **Batch Queue (1–5 Parallel Jobs):** Encode multiple videos or audio files simultaneously with Pause, Resume, and Stop controls.
- **Supported Formats:**
  - **Video:** H.265 / HEVC MP4 *(default)*, H.264 MP4, QuickTime MOV (H.264 & ProRes 422 HQ / 4444 Alpha), WebM (VP9).
  - **Audio:** MP3 (128 / 320 kbps), WAV PCM 48kHz, AAC / M4A.
- **Flexible Output Modes:** Save to `FolderName_OUTPUT` *(default)*, `Same Folder`, or paste/pick any `Custom Folder`, with Auto Rename, Skip, or Overwrite handling.
- **Safe Output Pipeline:** Encodes to a temporary file, validates duration and streams with FFprobe, and publishes atomically so interrupted runs never leave broken files.
- **Built-in Update Checker:** Automatically checks GitHub Releases for newer versions and lets you trigger **Check for Updates** from the `•••` menu.

---

## Quick Tips & Shortcuts

| Action | Shortcut / Gesture |
| :--- | :--- |
| Add Files | **Double-click** empty queue area *(or click Add Files)* |
| Start Queue | `Space` or `Enter` |
| Select Multiple Items | `Click`, `Shift+Click`, `Ctrl+Click`, `Ctrl+A` |
| Remove Selected Items | `Delete` |
| Open Exported File | Click the output filename on any **Done** item |

---

<details>
<summary><strong>Build from Source (Developers)</strong></summary>

Requires **Node.js 20+** and **Rust (MSVC toolchain)**.

```powershell
npm install
npm run tauri -- dev
```

Run checks and package the NSIS installer:

```powershell
npm run typecheck
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File tests/install_ffmpeg.test.ps1
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --bundles nsis
```

</details>
