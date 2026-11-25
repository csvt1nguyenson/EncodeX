import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EncoderLogPayload,
  ExportSettings,
  MediaInfo,
  QueueFilePayload,
  QueueFinishedPayload,
  QueueItem,
  QueueUpdatePayload,
  UpdateCheckResult,
} from "./types";

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export const tauriApi = {
  prepareMediaTools: () => invoke<string>("prepare_media_tools"),
  chooseFiles: () => invoke<string[]>("choose_files"),
  chooseFolder: () => invoke<string[]>("choose_folder"),
  chooseOutputFolder: () => invoke<string>("choose_output_folder"),
  openOutputPath: (outputPath: string) => invoke<boolean>("open_output_path", { outputPath }),
  probeInfo: (path: string) => invoke<MediaInfo>("probe_info", { path }),
  uiLog: (text: string) => invoke<boolean>("ui_log", { text }),
  saveQueue: (payload: QueueFilePayload) => invoke<boolean>("save_queue", { payload }),
  loadQueue: () => invoke<QueueFilePayload | null>("load_queue"),
  startQueue: (settings: ExportSettings, queue: QueueItem[]) =>
    invoke<boolean>("start_queue", { settings, queue }),
  stopQueue: () => invoke<boolean>("stop_queue"),
  pauseQueue: () => invoke<boolean>("pause_queue"),
  resumeQueue: () => invoke<boolean>("resume_queue"),
  scheduleShutdown: (cancel: boolean) => invoke<void>("schedule_shutdown", { cancel }),
  checkForUpdates: () => invoke<UpdateCheckResult>("check_for_updates"),
  openReleaseUrl: (url: string) => invoke<void>("open_release_url", { url }),

  onEncoderLog: (cb: (payload: EncoderLogPayload) => void): Promise<UnlistenFn> =>
    listen<EncoderLogPayload>("encoder-log", (e) => cb(e.payload)),
  onQueueUpdate: (cb: (payload: QueueUpdatePayload) => void): Promise<UnlistenFn> =>
    listen<QueueUpdatePayload>("queue-update", (e) => cb(e.payload)),
  onQueueFinished: (cb: (payload: QueueFinishedPayload) => void): Promise<UnlistenFn> =>
    listen<QueueFinishedPayload>("queue-finished", (e) => cb(e.payload)),
};
