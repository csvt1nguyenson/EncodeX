# EncodeX

Fast batch video & audio encoder for Windows x64 built with **Tauri v2, Rust, React, TypeScript, Tailwind CSS, and shadcn/ui**.

## Highlights

- **Batch Queue & Parallel Workers (1–5 jobs):** H.265/HEVC MP4 (default), H.264 MP4, QuickTime MOV (H.264 / ProRes), WebM, MP3, WAV, and AAC/M4A with NVIDIA NVENC or CPU Software encoding.
- **Fast Desktop Workflow:** Double-click the empty queue area to add files (All Files supported), press `Space` or `Enter` to start encoding immediately, `Delete` to remove selected rows, and `Ctrl+A` to select all.
- **Safe Output Pipeline:** Atomic temp-file encoding, FFprobe validation, safe publish via `MoveFileExW`, pause-aware ETA via Win32 `NtSuspendProcess`/`NtResumeProcess`, and automatic child cleanup on exit.
- **Automatic FFmpeg Setup & Update Checker:** Reuses existing FFmpeg/FFprobe installations or downloads verified essentials builds automatically; checks GitHub Releases (`csvt1nguyenson/EncodeX`) for newer versions on startup and on demand.

## Development

```powershell
npm install
npm run tauri -- dev
```

## Testing & Packaging

```powershell
npm run typecheck
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File tests/install_ffmpeg.test.ps1
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --bundles nsis
```

## Releasing an Update

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Build `npm run tauri -- build --bundles nsis`.
3. Create a GitHub Release tagged `vX.Y.Z` (e.g., `v0.4.1`) and attach `EncodeX_X.Y.Z_x64-setup.exe`. Existing EncodeX installations will automatically detect it on launch.
