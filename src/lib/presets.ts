import type {
  ExistingAction,
  ExportSettings,
  FormatId,
  OutputMode,
  QueueItem,
  RendererMode,
} from "./types";

export interface OptionItem<T extends string = string> {
  value: T;
  label: string;
}

export const FORMAT_OPTIONS: OptionItem<FormatId>[] = [
  { value: "h265_mp4", label: "H.265 / HEVC MP4" },
  { value: "h264_mp4", label: "H.264 MP4" },
  { value: "mov_h264", label: "QuickTime MOV - H.264" },
  { value: "mov_prores", label: "QuickTime MOV - ProRes" },
  { value: "mp3", label: "MP3 Audio" },
  { value: "wav", label: "WAV Audio" },
  { value: "aac", label: "AAC / M4A Audio" },
  { value: "webm", label: "WebM" },
];

export const AUDIO_ONLY_FORMATS = new Set<FormatId>(["mp3", "wav", "aac"]);

export const PRESETS: Record<FormatId, OptionItem[]> = {
  h265_mp4: [
    { value: "h265_high", label: "High Quality" },
    { value: "h265_balanced", label: "Balanced" },
    { value: "h265_small", label: "Small File" },
  ],
  h264_mp4: [
    { value: "h264_high", label: "High Quality" },
    { value: "h264_balanced", label: "Balanced" },
    { value: "h264_small", label: "Small File" },
  ],
  mov_h264: [
    { value: "mov_h264_high", label: "High Quality" },
    { value: "mov_h264_balanced", label: "Balanced" },
  ],
  mov_prores: [
    { value: "prores_422_hq", label: "ProRes 422 HQ" },
    { value: "prores_4444_alpha", label: "ProRes 4444 Alpha" },
  ],
  mp3: [
    { value: "mp3_128", label: "MP3 128 kbps" },
    { value: "mp3_320", label: "MP3 320 kbps" },
  ],
  wav: [{ value: "wav_48", label: "WAV PCM 48kHz" }],
  aac: [{ value: "aac_192", label: "AAC 192 kbps" }],
  webm: [{ value: "webm_balanced", label: "WebM Balanced" }],
};

export const RENDERER_OPTIONS: OptionItem<RendererMode>[] = [
  { value: "nvidia", label: "NVIDIA NVENC" },
  { value: "cpu", label: "CPU Software" },
];

export const OUTPUT_MODE_OPTIONS: OptionItem<OutputMode>[] = [
  { value: "source_output", label: "FolderName_OUTPUT" },
  { value: "same_folder", label: "Same Folder" },
  { value: "custom_folder", label: "Custom Folder" },
];

export const RESOLUTION_OPTIONS: OptionItem[] = [
  { value: "source", label: "Source Resolution" },
  { value: "1920x1080", label: "Full HD - 1920x1080" },
  { value: "2560x1440", label: "2K - 2560x1440" },
  { value: "3840x2160", label: "4K - 3840x2160" },
  { value: "7680x4320", label: "8K - 7680x4320" },
  { value: "custom", label: "Custom" },
];

export const FPS_OPTIONS: OptionItem[] = [
  { value: "source", label: "Source FPS" },
  { value: "23.976", label: "23.976 fps" },
  { value: "24", label: "24 fps" },
  { value: "25", label: "25 fps" },
  { value: "29.97", label: "29.97 fps" },
  { value: "30", label: "30 fps" },
  { value: "50", label: "50 fps" },
  { value: "59.94", label: "59.94 fps" },
  { value: "60", label: "60 fps" },
  { value: "custom", label: "Custom" },
];

export const EXISTING_ACTION_OPTIONS: OptionItem<ExistingAction>[] = [
  { value: "autorename", label: "Auto Rename" },
  { value: "skip", label: "Skip" },
  { value: "overwrite", label: "Overwrite" },
];

export const CONCURRENT_OPTIONS: OptionItem[] = [
  { value: "1", label: "1 job" },
  { value: "2", label: "2 jobs" },
  { value: "3", label: "3 jobs" },
  { value: "4", label: "4 jobs" },
  { value: "5", label: "5 jobs (max)" },
];

export function isAudioOnlyFormat(format: FormatId): boolean {
  return AUDIO_ONLY_FORMATS.has(format);
}

export function isValidFormat(value: unknown): value is FormatId {
  return typeof value === "string" && value in PRESETS;
}

export function getFormatLabel(format: FormatId): string {
  return FORMAT_OPTIONS.find((f) => f.value === format)?.label ?? format;
}

export function getPresetLabel(format: FormatId, preset: string): string {
  return PRESETS[format]?.find((p) => p.value === preset)?.label ?? preset;
}

export function getDefaultPreset(format: FormatId): OptionItem {
  return PRESETS[format][0];
}

export function clampConcurrentJobs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(5, Math.max(1, Math.trunc(parsed)));
}

export function createDefaultSettings(): ExportSettings {
  return {
    format: "h265_mp4",
    formatLabel: getFormatLabel("h265_mp4"),
    preset: "h265_high",
    presetLabel: getPresetLabel("h265_mp4", "h265_high"),
    exportVideo: true,
    exportAudio: true,
    renderer: "nvidia",
    outputMode: "source_output",
    customFolder: "",
    resolutionMode: "source",
    customWidth: "",
    customHeight: "",
    fpsMode: "source",
    customFps: "",
    copyMetadata: true,
    existingAction: "autorename",
    skipExisting: false,
    concurrentJobs: 1,
    autoShutdown: false,
  };
}

export function formatInfoText(item: Pick<QueueItem, "info">): string {
  if (!item.info) return "";
  const parts: string[] = [];
  if (item.info.resolution) parts.push(item.info.resolution);
  if (item.info.fps) parts.push(`${item.info.fps} fps`);
  if (item.info.duration) parts.push(item.info.duration);
  return parts.join(" · ");
}

export function formatSizeText(
  item: Pick<QueueItem, "sizeBefore" | "sourceSize" | "sizeAfter" | "savedPercent" | "info">
): string {
  const before = item.sizeBefore || item.sourceSize || item.info?.size || "";
  const after = item.sizeAfter || "";
  const saved = item.savedPercent || "";
  if (after && saved) return `${before} → ${after} (${saved})`;
  if (after) return `${before} → ${after}`;
  return before;
}

export function formatResolutionSummary(settings: ExportSettings): string {
  if (settings.resolutionMode === "source") return "Source";
  if (settings.resolutionMode === "custom") {
    return `${settings.customWidth || "?"}x${settings.customHeight || "?"}`;
  }
  return settings.resolutionMode;
}

export function formatFpsSummary(settings: ExportSettings): string {
  if (settings.fpsMode === "source") return "Source";
  if (settings.fpsMode === "custom") return `${settings.customFps || "?"} fps`;
  return `${settings.fpsMode} fps`;
}
