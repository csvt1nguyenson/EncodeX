export type FormatId =
  | "h265_mp4"
  | "h264_mp4"
  | "mov_h264"
  | "mov_prores"
  | "mp3"
  | "wav"
  | "aac"
  | "webm";

export type RendererMode = "nvidia" | "cpu";
export type OutputMode = "source_output" | "same_folder" | "custom_folder";
export type ExistingAction = "autorename" | "skip" | "overwrite";

export type JobStatus =
  | "Waiting"
  | "Ready"
  | "Encoding"
  | "Finishing..."
  | "Done"
  | "Failed"
  | "Skipped"
  | "Stopped";

export type AppBadgeState =
  | "READY"
  | "WAITING..."
  | "ENCODING"
  | "PAUSED"
  | "DONE"
  | "STOPPED"
  | "COMPLETED WITH ERRORS";

export interface MediaInfo {
  duration?: string;
  duration_seconds?: number;
  size?: string;
  size_bytes?: number;
  resolution?: string;
  fps?: string;
  video_codec?: string;
  audio_codec?: string;
  sample_rate?: string;
}

export interface ExportSettings {
  format: FormatId;
  formatLabel: string;
  preset: string;
  presetLabel: string;
  exportVideo: boolean;
  exportAudio: boolean;
  renderer: RendererMode;
  outputMode: OutputMode;
  customFolder: string;
  resolutionMode: string;
  customWidth: string;
  customHeight: string;
  fpsMode: string;
  customFps: string;
  copyMetadata: boolean;
  existingAction: ExistingAction;
  skipExisting: boolean;
  concurrentJobs: number;
  autoShutdown: boolean;
}

export interface QueueItem {
  source: string;
  info: MediaInfo;
  format: FormatId;
  formatLabel: string;
  preset: string;
  presetLabel: string;
  exportVideo: boolean;
  exportAudio: boolean;
  outputMode: OutputMode;
  customFolder: string;
  resolutionMode: string;
  customWidth: string;
  customHeight: string;
  fpsMode: string;
  customFps: string;
  output: string;
  sizeBefore: string;
  sourceSize?: string;
  sizeAfter: string;
  savedPercent: string;
  status: JobStatus;
  progress: number;
  eta: string;
  error?: string;
}

export interface QueueFilePayload {
  version: string;
  savedAt: string;
  settings?: Partial<ExportSettings>;
  queue: Partial<QueueItem>[];
}

export interface QueueUpdatePayload {
  index: number;
  data: Partial<QueueItem>;
}

export interface QueueFinishedPayload {
  stopped?: boolean;
  completed?: number;
}

export interface EncoderLogPayload {
  time?: string;
  message?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  noRelease: boolean;
  releaseUrl: string;
  downloadUrl: string;
  notes: string;
}
