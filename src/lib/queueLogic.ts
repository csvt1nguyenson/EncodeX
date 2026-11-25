import { buildOutputPreview, normalizeFolderInput } from "./paths";
import {
  clampConcurrentJobs,
  createDefaultSettings,
  getDefaultPreset,
  getFormatLabel,
  getPresetLabel,
  isAudioOnlyFormat,
  isValidFormat,
} from "./presets";
import type {
  EncoderLogPayload,
  ExportSettings,
  FormatId,
  JobStatus,
  MediaInfo,
  OutputMode,
  QueueFilePayload,
  QueueFinishedPayload,
  QueueItem,
} from "./types";

const UNFINISHED_STATUSES = new Set<JobStatus>(["Ready", "Waiting", "Failed", "Stopped"]);
const PRESERVED_LOAD_STATUSES = new Set<JobStatus>(["Done", "Skipped", "Failed"]);

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === "function" && el.closest("#realtimeLog, [contenteditable='true']")) {
    return true;
  }
  return false;
}

export function shouldTriggerStartShortcut(params: {
  key: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  target: EventTarget | null;
  isRunning: boolean;
  hasOpenDialog: boolean;
  queueLength: number;
}): boolean {
  if (params.key !== " " && params.key !== "Enter") return false;
  if (params.repeat || params.ctrlKey || params.altKey || params.metaKey) return false;
  if (params.isRunning || params.hasOpenDialog || params.queueLength === 0) return false;
  if (isEditableTarget(params.target)) return false;

  if (params.target && typeof params.target === "object") {
    const el = params.target as {
      getAttribute?: (name: string) => string | null;
      closest?: (selector: string) => unknown;
    };
    if (el.getAttribute?.("aria-expanded") === "true") return false;
    if (
      typeof el.closest === "function" &&
      el.closest(
        "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [role='switch'], [role='combobox']"
      )
    ) {
      return false;
    }
  }
  return true;
}

export function createQueueItemsFromPaths(
  existingQueue: QueueItem[],
  paths: string[],
  settings: ExportSettings
): { nextQueue: QueueItem[]; addedPaths: string[]; newSelection: Set<number> } {
  if (paths.length === 0) {
    return { nextQueue: existingQueue, addedPaths: [], newSelection: new Set() };
  }

  const existingSources = new Set(existingQueue.map((item) => item.source));
  const nextQueue = [...existingQueue];
  const addedPaths: string[] = [];
  const startIndex = nextQueue.length;

  for (const path of paths) {
    if (!path || existingSources.has(path)) continue;
    existingSources.add(path);

    const exportVideo = isAudioOnlyFormat(settings.format) ? false : settings.exportVideo;
    const item: QueueItem = {
      source: path,
      info: { size: "Loading...", resolution: "..." },
      format: settings.format,
      formatLabel: settings.formatLabel,
      preset: settings.preset,
      presetLabel: settings.presetLabel,
      exportVideo,
      exportAudio: settings.exportAudio,
      outputMode: settings.outputMode,
      customFolder: settings.customFolder,
      resolutionMode: settings.resolutionMode,
      customWidth: settings.customWidth,
      customHeight: settings.customHeight,
      fpsMode: settings.fpsMode,
      customFps: settings.customFps,
      output: "",
      sizeBefore: "Loading...",
      sizeAfter: "",
      savedPercent: "",
      status: "Waiting",
      progress: 0,
      eta: "--",
    };
    item.output = buildOutputPreview(item, settings);
    nextQueue.push(item);
    addedPaths.push(path);
  }

  const newSelection = new Set<number>();
  for (let i = startIndex; i < nextQueue.length; i++) {
    newSelection.add(i);
  }

  return { nextQueue, addedPaths, newSelection };
}

export function applyProbeResult(
  queue: QueueItem[],
  path: string,
  info: MediaInfo | null,
  probeError?: string
): QueueItem[] {
  const idx = queue.findIndex((item) => item.source === path);
  if (idx === -1) return queue;

  const current = queue[idx];
  const safeInfo: MediaInfo = info ?? {};
  const updated: QueueItem = {
    ...current,
    info: safeInfo,
    sizeBefore: safeInfo.size || "",
    status: "Ready",
    error: probeError || current.error,
  };

  const next = [...queue];
  next[idx] = updated;
  return next;
}

export function applySettingsToSelected(
  queue: QueueItem[],
  selectedIndices: Set<number>,
  settings: ExportSettings,
  isRunning: boolean
): QueueItem[] {
  if (isRunning || selectedIndices.size === 0) return queue;
  let changed = false;
  const next = queue.map((item, idx) => {
    if (!selectedIndices.has(idx) || !UNFINISHED_STATUSES.has(item.status)) return item;
    changed = true;
    const exportVideo = isAudioOnlyFormat(settings.format) ? false : settings.exportVideo;
    const updated: QueueItem = {
      ...item,
      format: settings.format,
      formatLabel: settings.formatLabel,
      preset: settings.preset,
      presetLabel: settings.presetLabel,
      exportVideo,
      exportAudio: settings.exportAudio,
      outputMode: settings.outputMode,
      customFolder: settings.customFolder,
      resolutionMode: settings.resolutionMode,
      customWidth: settings.customWidth,
      customHeight: settings.customHeight,
      fpsMode: settings.fpsMode,
      customFps: settings.customFps,
    };
    updated.output = buildOutputPreview(updated, settings);
    return updated;
  });
  return changed ? next : queue;
}

export function applyOutputToSelected(
  queue: QueueItem[],
  selectedIndices: Set<number>,
  outputMode: OutputMode,
  customFolder: string,
  settings: ExportSettings,
  isRunning: boolean
): QueueItem[] {
  if (isRunning || selectedIndices.size === 0) return queue;
  const normalizedFolder = normalizeFolderInput(customFolder);
  const fallback = { ...settings, outputMode, customFolder: normalizedFolder };
  let changed = false;

  const next = queue.map((item, idx) => {
    if (!selectedIndices.has(idx) || !UNFINISHED_STATUSES.has(item.status)) return item;
    changed = true;
    const updated: QueueItem = {
      ...item,
      outputMode,
      customFolder: normalizedFolder,
    };
    updated.output = buildOutputPreview(updated, fallback);
    return updated;
  });

  return changed ? next : queue;
}

export function resolveCustomFolderUpdate(rawValue: string): {
  outputMode: OutputMode;
  customFolder: string;
} {
  const folder = normalizeFolderInput(rawValue);
  if (!folder) {
    return { outputMode: "source_output", customFolder: "" };
  }
  // Keep trailing spaces so folder names with spaces can be typed; Rust trims before use.
  const typed = rawValue.trim().startsWith('"') ? folder : rawValue.trimStart().replace(/\//g, "\\");
  return { outputMode: "custom_folder", customFolder: typed };
}

export function resetSelectedItems(
  queue: QueueItem[],
  selectedIndices: Set<number>,
  settings: ExportSettings,
  isRunning: boolean
): QueueItem[] {
  if (isRunning || selectedIndices.size === 0) return queue;
  const resettable = new Set<JobStatus>(["Done", "Failed", "Skipped", "Stopped"]);
  let changed = false;

  const next = queue.map((item, idx) => {
    if (!selectedIndices.has(idx) || !resettable.has(item.status)) return item;
    changed = true;
    const updated: QueueItem = {
      ...item,
      status: "Ready",
      progress: 0,
      eta: "--",
      sizeAfter: "",
      savedPercent: "",
      error: undefined,
    };
    updated.output = buildOutputPreview(updated, settings);
    return updated;
  });

  return changed ? next : queue;
}

export function retryUnfinishedItems(queue: QueueItem[], isRunning: boolean): QueueItem[] {
  if (isRunning) return queue;
  let changed = false;
  const next = queue.map((item) => {
    if (item.status !== "Failed" && item.status !== "Stopped") return item;
    changed = true;
    return {
      ...item,
      status: "Ready" as JobStatus,
      progress: 0,
      eta: "--",
      error: undefined,
    };
  });
  return changed ? next : queue;
}

export function removeSelectedItems(
  queue: QueueItem[],
  selectedIndices: Set<number>,
  isRunning: boolean
): QueueItem[] {
  if (isRunning || selectedIndices.size === 0) return queue;
  return queue.filter((_, idx) => !selectedIndices.has(idx));
}

export function normalizeLoadedQueue(payload: QueueFilePayload): {
  settings: ExportSettings;
  queue: QueueItem[];
} {
  const base = createDefaultSettings();
  const incoming = payload.settings ?? {};
  const format: FormatId = isValidFormat(incoming.format) ? incoming.format : base.format;
  const preset =
    typeof incoming.preset === "string" && incoming.preset
      ? incoming.preset
      : getDefaultPreset(format).value;
  const existingAction =
    incoming.existingAction === "skip" ||
    incoming.existingAction === "overwrite" ||
    incoming.existingAction === "autorename"
      ? incoming.existingAction
      : base.existingAction;

  const settings: ExportSettings = {
    ...base,
    format,
    formatLabel: getFormatLabel(format),
    preset,
    presetLabel: getPresetLabel(format, preset),
    exportVideo: isAudioOnlyFormat(format)
      ? false
      : incoming.exportVideo !== undefined
        ? Boolean(incoming.exportVideo)
        : base.exportVideo,
    exportAudio:
      incoming.exportAudio !== undefined ? Boolean(incoming.exportAudio) : base.exportAudio,
    renderer: incoming.renderer === "cpu" ? "cpu" : "nvidia",
    outputMode:
      incoming.outputMode === "same_folder" || incoming.outputMode === "custom_folder"
        ? incoming.outputMode
        : "source_output",
    customFolder: normalizeFolderInput(incoming.customFolder),
    resolutionMode:
      typeof incoming.resolutionMode === "string" && incoming.resolutionMode
        ? incoming.resolutionMode
        : "source",
    customWidth: incoming.customWidth !== undefined ? String(incoming.customWidth) : "",
    customHeight: incoming.customHeight !== undefined ? String(incoming.customHeight) : "",
    fpsMode:
      typeof incoming.fpsMode === "string" && incoming.fpsMode ? incoming.fpsMode : "source",
    customFps: incoming.customFps !== undefined ? String(incoming.customFps) : "",
    existingAction,
    skipExisting: existingAction === "skip",
    concurrentJobs: clampConcurrentJobs(incoming.concurrentJobs),
    autoShutdown: Boolean(incoming.autoShutdown),
  };

  const queue: QueueItem[] = (payload.queue ?? [])
    .filter((raw): raw is Partial<QueueItem> & { source: string } => Boolean(raw && raw.source))
    .map((raw) => {
      const itemFormat: FormatId = isValidFormat(raw.format) ? raw.format : settings.format;
      const itemPreset =
        typeof raw.preset === "string" && raw.preset
          ? raw.preset
          : getDefaultPreset(itemFormat).value;
      const rawStatus = raw.status as JobStatus | undefined;
      const keepStatus = rawStatus && PRESERVED_LOAD_STATUSES.has(rawStatus);
      const item: QueueItem = {
        source: raw.source,
        info: raw.info ?? {},
        format: itemFormat,
        formatLabel: getFormatLabel(itemFormat),
        preset: itemPreset,
        presetLabel: getPresetLabel(itemFormat, itemPreset),
        exportVideo: isAudioOnlyFormat(itemFormat)
          ? false
          : raw.exportVideo !== undefined
            ? Boolean(raw.exportVideo)
            : settings.exportVideo,
        exportAudio: raw.exportAudio !== undefined ? Boolean(raw.exportAudio) : settings.exportAudio,
        outputMode: raw.outputMode ?? settings.outputMode,
        customFolder: normalizeFolderInput(raw.customFolder ?? settings.customFolder),
        resolutionMode: raw.resolutionMode ?? settings.resolutionMode,
        customWidth: raw.customWidth !== undefined ? String(raw.customWidth) : settings.customWidth,
        customHeight:
          raw.customHeight !== undefined ? String(raw.customHeight) : settings.customHeight,
        fpsMode: raw.fpsMode ?? settings.fpsMode,
        customFps: raw.customFps !== undefined ? String(raw.customFps) : settings.customFps,
        output: raw.output ?? "",
        sizeBefore: raw.sizeBefore ?? raw.sourceSize ?? raw.info?.size ?? "",
        sourceSize: raw.sourceSize,
        sizeAfter: raw.sizeAfter ?? "",
        savedPercent: raw.savedPercent ?? "",
        status: keepStatus ? rawStatus : "Ready",
        progress: keepStatus ? Number(raw.progress) || 0 : 0,
        eta: keepStatus ? raw.eta || "--" : "--",
        error: keepStatus ? raw.error : undefined,
      };
      if (!item.output) {
        item.output = buildOutputPreview(item, settings);
      }
      return item;
    });

  return { settings, queue };
}

export function shouldScheduleAutoShutdown(
  queue: QueueItem[],
  result: QueueFinishedPayload,
  autoShutdown: boolean
): boolean {
  if (!autoShutdown || result.stopped) return false;
  if ((result.completed ?? 0) <= 0) return false;
  if (queue.length === 0) return false;
  return queue.every((item) => item.status === "Done" || item.status === "Skipped");
}

export function appendLogLine(
  lines: string[],
  entry: EncoderLogPayload,
  maxLines = 2000
): string[] {
  const time = entry.time || new Date().toLocaleTimeString();
  const message = String(entry.message ?? "").slice(0, 4000);
  const next = [...lines, `[${time}] ${message}`];
  if (next.length > maxLines) {
    return next.slice(next.length - maxLines);
  }
  return next;
}
