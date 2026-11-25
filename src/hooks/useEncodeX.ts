import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  appendLogLine,
  applyOutputToSelected,
  applyProbeResult,
  applySettingsToSelected,
  createQueueItemsFromPaths,
  isEditableTarget,
  normalizeLoadedQueue,
  removeSelectedItems,
  resetSelectedItems,
  resolveCustomFolderUpdate,
  retryUnfinishedItems,
  shouldScheduleAutoShutdown,
  shouldTriggerStartShortcut,
} from "@/lib/queueLogic";
import {
  clampConcurrentJobs,
  createDefaultSettings,
  getDefaultPreset,
  getFormatLabel,
  getPresetLabel,
  isAudioOnlyFormat,
} from "@/lib/presets";
import { baseName } from "@/lib/paths";
import { formatError, tauriApi } from "@/lib/tauri";
import type {
  AppBadgeState,
  ExistingAction,
  ExportSettings,
  FormatId,
  OutputMode,
  QueueFinishedPayload,
  QueueItem,
  RendererMode,
  UpdateCheckResult,
} from "@/lib/types";

// GitHub allows 60 anonymous requests per hour per IP, shared by every PC in the office.
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export interface AlertState {
  title: string;
  message: string;
}

function blurActiveElement() {
  if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

export function useEncodeX() {
  const [settings, setSettings] = useState<ExportSettings>(createDefaultSettings);
  const [queue, setQueueState] = useState<QueueItem[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState(-1);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [badge, setBadge] = useState<AppBadgeState>("READY");
  const [etaText, setEtaText] = useState("--");
  const [shutdownPending, setShutdownPending] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logAutoScroll, setLogAutoScroll] = useState(true);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [alertDialog, setAlertDialog] = useState<AlertState | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateCheckResult | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const queueRef = useRef(queue);
  // The ref updates synchronously, so back-to-back backend events never see a stale queue.
  const setQueue = useCallback((update: QueueItem[] | ((prev: QueueItem[]) => QueueItem[])) => {
    queueRef.current = typeof update === "function" ? update(queueRef.current) : update;
    setQueueState(queueRef.current);
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectedRef = useRef(selectedIndices);
  selectedRef.current = selectedIndices;
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const hasOpenDialogRef = useRef(false);
  hasOpenDialogRef.current = confirmClearOpen || alertDialog !== null || updateDialogOpen;

  const mediaToolsPromiseRef = useRef<Promise<string> | null>(null);
  const notifiedVersionRef = useRef("");
  const probeGenerationRef = useRef(0);
  const pendingLogsRef = useRef<Array<{ time?: string; message?: string }>>([]);
  const logRafRef = useRef<number | null>(null);

  const ensureMediaTools = useCallback(() => {
    if (!mediaToolsPromiseRef.current) {
      mediaToolsPromiseRef.current = tauriApi.prepareMediaTools().catch((err) => {
        mediaToolsPromiseRef.current = null;
        throw err;
      });
    }
    return mediaToolsPromiseRef.current;
  }, []);

  const writeUiLog = useCallback((text: string) => {
    tauriApi.uiLog(text).catch(() => {});
  }, []);

  const checkForUpdates = useCallback(async (silent = false) => {
    setCheckingUpdate(true);
    try {
      const result = await tauriApi.checkForUpdates();
      if (result.hasUpdate) {
        setAvailableUpdate(result);
        // Background checks pop up once per version, so "Later" is respected until the next launch.
        if (!silent || notifiedVersionRef.current !== result.latestVersion) {
          notifiedVersionRef.current = result.latestVersion;
          setUpdateDialogOpen(true);
        }
      } else {
        setAvailableUpdate(null);
        if (!silent) {
          if (result.noRelease) {
            toast.info("No published releases found on GitHub yet.");
          } else {
            toast.success(`You are on the latest version (v${result.currentVersion}).`);
          }
        }
      }
    } catch (err) {
      if (!silent) {
        toast.error("Unable to check for updates", { description: formatError(err) });
      }
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const openReleaseUrl = useCallback(async (url: string) => {
    try {
      await tauriApi.openReleaseUrl(url);
    } catch (err) {
      toast.error("Failed to open link", { description: formatError(err) });
    }
  }, []);

  useEffect(() => {
    ensureMediaTools().catch((err) => {
      setAlertDialog({
        title: "FFmpeg Setup Failed",
        message: formatError(err),
      });
    });
    void checkForUpdates(true);
    const timer = setInterval(() => void checkForUpdates(true), UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ensureMediaTools, checkForUpdates]);

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    const flushLogs = () => {
      logRafRef.current = null;
      const batch = pendingLogsRef.current.splice(0);
      if (batch.length === 0) return;
      setLogLines((prev) => batch.reduce((acc, entry) => appendLogLine(acc, entry, 2000), prev));
    };

    const setup = async () => {
      const u1 = await tauriApi.onEncoderLog((entry) => {
        pendingLogsRef.current.push(entry);
        if (logRafRef.current === null) {
          logRafRef.current = requestAnimationFrame(flushLogs);
        }
      });

      const u2 = await tauriApi.onQueueUpdate(({ index, data }) => {
        setQueue((prev) => {
          const current = prev[index];
          if (!current) return prev;
          const updated = { ...current, ...data };
          const next = [...prev];
          next[index] = updated;

          const activeItems = next.filter(
            (x) => x.status === "Encoding" || x.status === "Finishing..."
          );
          setEtaText(activeItems.length === 1 ? activeItems[0].eta || "--" : "--");
          if (data.error) {
            writeUiLog(`Error ${baseName(updated.source)}: ${data.error}`);
          }
          return next;
        });
      });

      const u3 = await tauriApi.onQueueFinished((result: QueueFinishedPayload = {}) => {
        setIsRunning(false);
        setIsPaused(false);
        setEtaText("--");

        const currentQueue = queueRef.current;
        const failed = currentQueue.filter((x) => x.status === "Failed").length;
        const done = currentQueue.filter((x) => x.status === "Done").length;
        const skipped = currentQueue.filter((x) => x.status === "Skipped").length;

        const nextBadge: AppBadgeState = result.stopped
          ? "STOPPED"
          : failed > 0
            ? "COMPLETED WITH ERRORS"
            : "DONE";
        setBadge(nextBadge);

        const summary = `${done} done · ${failed} failed · ${skipped} skipped${
          result.stopped ? " · Stopped" : ""
        }`;
        writeUiLog(`Summary: ${summary}`);

        if (result.stopped) {
          toast.warning("Queue stopped", { description: summary });
        } else if (failed > 0) {
          toast.error("Completed with errors", { description: summary });
        } else {
          toast.success("Queue completed", { description: summary });
        }

        if (shouldScheduleAutoShutdown(currentQueue, result, settingsRef.current.autoShutdown)) {
          tauriApi
            .scheduleShutdown(false)
            .then(() => {
              setShutdownPending(true);
              setAlertDialog({
                title: "Shutdown Scheduled",
                message: "This PC will shut down in 60 seconds. Click Cancel Shutdown to abort.",
              });
            })
            .catch((err) => {
              setAlertDialog({
                title: "Unable to Schedule Shutdown",
                message: formatError(err),
              });
            });
        }
      });

      if (!active) {
        u1();
        u2();
        u3();
      } else {
        unlisteners.push(u1, u2, u3);
      }
    };

    setup().catch(() => {});

    return () => {
      active = false;
      if (logRafRef.current !== null) cancelAnimationFrame(logRafRef.current);
      for (const unlisten of unlisteners) unlisten();
    };
  }, [writeUiLog]);

  const startQueue = useCallback(async () => {
    if (isRunningRef.current) return;
    if (queueRef.current.length === 0) {
      toast.warning("Queue is empty. Add files or a folder first.");
      return;
    }
    if (queueRef.current.some((x) => x.status === "Waiting")) {
      toast.warning("Please wait until media probing finishes before starting.");
      return;
    }

    isRunningRef.current = true;
    setIsRunning(true);
    setIsPaused(false);
    setBadge("ENCODING");
    setEtaText("--");

    try {
      await ensureMediaTools();
      const accepted = await tauriApi.startQueue(settingsRef.current, queueRef.current);
      if (!accepted) {
        throw new Error("Another queue is already running.");
      }
    } catch (err) {
      setIsRunning(false);
      setIsPaused(false);
      setBadge("READY");
      setAlertDialog({ title: "Start Queue Failed", message: formatError(err) });
    }
  }, [ensureMediaTools]);

  // Global keyboard shortcuts: Space/Enter starts queue; Delete removes selected; Ctrl+A selects all.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        shouldTriggerStartShortcut({
          key: event.key,
          repeat: event.repeat,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          target: event.target,
          isRunning: isRunningRef.current,
          hasOpenDialog: hasOpenDialogRef.current,
          queueLength: queueRef.current.length,
        })
      ) {
        event.preventDefault();
        blurActiveElement();
        void startQueue();
        return;
      }

      if (isEditableTarget(event.target) || hasOpenDialogRef.current) return;

      if (event.key === "Delete") {
        if (isRunningRef.current || selectedRef.current.size === 0) return;
        event.preventDefault();
        setQueue((prev) => removeSelectedItems(prev, selectedRef.current, false));
        setSelectedIndices(new Set());
        setLastSelectedIndex(-1);
        writeUiLog("Selected item(s) removed.");
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        if (queueRef.current.length === 0) return;
        event.preventDefault();
        const all = new Set<number>();
        for (let i = 0; i < queueRef.current.length; i++) all.add(i);
        setSelectedIndices(all);
        setLastSelectedIndex(queueRef.current.length - 1);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [startQueue, writeUiLog]);

  const syncSettingsFromItem = useCallback((item: QueueItem) => {
    setSettings((prev) => ({
      ...prev,
      format: item.format,
      formatLabel: getFormatLabel(item.format),
      preset: item.preset,
      presetLabel: getPresetLabel(item.format, item.preset),
      exportVideo: isAudioOnlyFormat(item.format) ? false : item.exportVideo,
      exportAudio: item.exportAudio,
      outputMode: item.outputMode || "source_output",
      customFolder: item.customFolder || "",
      resolutionMode: item.resolutionMode || "source",
      customWidth: item.customWidth || "",
      customHeight: item.customHeight || "",
      fpsMode: item.fpsMode || "source",
      customFps: item.customFps || "",
    }));
  }, []);

  const selectRow = useCallback(
    (index: number, modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
      let nextSelected: Set<number>;
      if (modifiers.shiftKey && lastSelectedIndex >= 0) {
        const start = Math.min(lastSelectedIndex, index);
        const end = Math.max(lastSelectedIndex, index);
        nextSelected = new Set<number>();
        for (let i = start; i <= end; i++) nextSelected.add(i);
      } else if (modifiers.ctrlKey || modifiers.metaKey) {
        nextSelected = new Set(selectedRef.current);
        if (nextSelected.has(index)) {
          nextSelected.delete(index);
        } else {
          nextSelected.add(index);
        }
        setLastSelectedIndex(index);
      } else {
        nextSelected = new Set([index]);
        setLastSelectedIndex(index);
      }

      setSelectedIndices(nextSelected);
      const firstIndex = [...nextSelected][0];
      if (firstIndex !== undefined && queueRef.current[firstIndex]) {
        syncSettingsFromItem(queueRef.current[firstIndex]);
      }
    },
    [lastSelectedIndex, syncSettingsFromItem]
  );

  const updateSettingsAndApply = useCallback(
    (updater: (prev: ExportSettings) => ExportSettings, applyMode: "all" | "output" | "none") => {
      const nextSettings = updater(settingsRef.current);
      setSettings(nextSettings);

      if (applyMode === "all") {
        setQueue((prev) =>
          applySettingsToSelected(prev, selectedRef.current, nextSettings, isRunningRef.current)
        );
      } else if (applyMode === "output") {
        setQueue((prev) =>
          applyOutputToSelected(
            prev,
            selectedRef.current,
            nextSettings.outputMode,
            nextSettings.customFolder,
            nextSettings,
            isRunningRef.current
          )
        );
      }
    },
    []
  );

  const setFormat = useCallback(
    (format: FormatId) => {
      const defaultPreset = getDefaultPreset(format);
      const audioOnly = isAudioOnlyFormat(format);
      updateSettingsAndApply(
        (prev) => ({
          ...prev,
          format,
          formatLabel: getFormatLabel(format),
          preset: defaultPreset.value,
          presetLabel: defaultPreset.label,
          exportVideo: !audioOnly,
          exportAudio: true,
        }),
        "all"
      );
    },
    [updateSettingsAndApply]
  );

  const setPreset = useCallback(
    (preset: string) => {
      updateSettingsAndApply(
        (prev) => ({
          ...prev,
          preset,
          presetLabel: getPresetLabel(prev.format, preset),
        }),
        "all"
      );
    },
    [updateSettingsAndApply]
  );

  const setExportVideo = useCallback(
    (enabled: boolean) => {
      if (isAudioOnlyFormat(settingsRef.current.format)) return;
      if (!enabled && !settingsRef.current.exportAudio) {
        toast.warning("Cannot disable both Video and Audio streams.");
        return;
      }
      updateSettingsAndApply((prev) => ({ ...prev, exportVideo: enabled }), "all");
    },
    [updateSettingsAndApply]
  );

  const setExportAudio = useCallback(
    (enabled: boolean) => {
      if (!enabled && !settingsRef.current.exportVideo) {
        toast.warning("Cannot disable both Video and Audio streams.");
        return;
      }
      updateSettingsAndApply((prev) => ({ ...prev, exportAudio: enabled }), "all");
    },
    [updateSettingsAndApply]
  );

  const setRenderer = useCallback(
    (renderer: RendererMode) => {
      updateSettingsAndApply((prev) => ({ ...prev, renderer }), "none");
    },
    [updateSettingsAndApply]
  );

  const setOutputMode = useCallback(
    (outputMode: OutputMode) => {
      updateSettingsAndApply((prev) => ({ ...prev, outputMode }), "output");
    },
    [updateSettingsAndApply]
  );

  const setCustomFolderInput = useCallback(
    (rawValue: string) => {
      const { outputMode, customFolder } = resolveCustomFolderUpdate(rawValue);
      updateSettingsAndApply((prev) => ({ ...prev, outputMode, customFolder }), "output");
    },
    [updateSettingsAndApply]
  );

  const chooseOutputFolder = useCallback(async () => {
    try {
      const folder = await tauriApi.chooseOutputFolder();
      if (folder) {
        setCustomFolderInput(folder);
      }
    } catch (err) {
      toast.error("Failed to select output folder", { description: formatError(err) });
    }
  }, [setCustomFolderInput]);

  const setResolutionMode = useCallback(
    (resolutionMode: string) => {
      updateSettingsAndApply((prev) => ({ ...prev, resolutionMode }), "all");
    },
    [updateSettingsAndApply]
  );

  const setCustomDimensions = useCallback(
    (patch: { customWidth?: string; customHeight?: string }) => {
      updateSettingsAndApply((prev) => ({ ...prev, ...patch }), "all");
    },
    [updateSettingsAndApply]
  );

  const setFpsMode = useCallback(
    (fpsMode: string) => {
      updateSettingsAndApply((prev) => ({ ...prev, fpsMode }), "all");
    },
    [updateSettingsAndApply]
  );

  const setCustomFps = useCallback(
    (customFps: string) => {
      updateSettingsAndApply((prev) => ({ ...prev, customFps }), "all");
    },
    [updateSettingsAndApply]
  );

  const setExistingAction = useCallback(
    (existingAction: ExistingAction) => {
      updateSettingsAndApply(
        (prev) => ({ ...prev, existingAction, skipExisting: existingAction === "skip" }),
        "none"
      );
    },
    [updateSettingsAndApply]
  );

  const setConcurrentJobs = useCallback(
    (value: string) => {
      updateSettingsAndApply(
        (prev) => ({ ...prev, concurrentJobs: clampConcurrentJobs(value) }),
        "none"
      );
    },
    [updateSettingsAndApply]
  );

  const setAutoShutdown = useCallback(
    (autoShutdown: boolean) => {
      updateSettingsAndApply((prev) => ({ ...prev, autoShutdown }), "none");
    },
    [updateSettingsAndApply]
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (isRunningRef.current || paths.length === 0) return;
      await ensureMediaTools();
      if (isRunningRef.current) return;

      const { nextQueue, addedPaths, newSelection } = createQueueItemsFromPaths(
        queueRef.current,
        paths,
        settingsRef.current
      );

      if (addedPaths.length === 0) {
        toast.info("Selected file(s) are already in the queue.");
        return;
      }

      const generation = probeGenerationRef.current;
      setQueue(nextQueue);
      setSelectedIndices(newSelection);
      setLastSelectedIndex(nextQueue.length - 1);
      setBadge("WAITING...");
      writeUiLog(`Added ${addedPaths.length} item(s).`);

      for (const path of addedPaths) {
        if (probeGenerationRef.current !== generation || queueRef.current.length === 0) break;
        if (!queueRef.current.some((item) => item.source === path)) continue;

        try {
          const info = await tauriApi.probeInfo(path);
          if (probeGenerationRef.current !== generation || queueRef.current.length === 0) break;
          setQueue((prev) => {
            const updated = applyProbeResult(prev, path, info);
            if (!updated.some((item) => item.status === "Waiting") && !isRunningRef.current) {
              setBadge("READY");
            }
            return updated;
          });
        } catch (err) {
          if (probeGenerationRef.current !== generation || queueRef.current.length === 0) break;
          const msg = `Probe warning (${baseName(path)}): ${formatError(err)}`;
          writeUiLog(msg);
          setQueue((prev) => {
            const updated = applyProbeResult(prev, path, {}, msg);
            if (!updated.some((item) => item.status === "Waiting") && !isRunningRef.current) {
              setBadge("READY");
            }
            return updated;
          });
        }
      }
    },
    [ensureMediaTools, writeUiLog]
  );

  const addFiles = useCallback(async () => {
    if (isRunningRef.current) return;
    blurActiveElement();
    try {
      const files = await tauriApi.chooseFiles();
      await addPaths(files || []);
    } catch (err) {
      setAlertDialog({ title: "Add Files Failed", message: formatError(err) });
    } finally {
      blurActiveElement();
    }
  }, [addPaths]);

  const addFolder = useCallback(async () => {
    if (isRunningRef.current) return;
    blurActiveElement();
    try {
      const files = await tauriApi.chooseFolder();
      await addPaths(files || []);
    } catch (err) {
      setAlertDialog({ title: "Add Folder Failed", message: formatError(err) });
    } finally {
      blurActiveElement();
    }
  }, [addPaths]);

  const removeSelected = useCallback(() => {
    if (isRunningRef.current || selectedRef.current.size === 0) return;
    const count = selectedRef.current.size;
    setQueue((prev) => removeSelectedItems(prev, selectedRef.current, false));
    setSelectedIndices(new Set());
    setLastSelectedIndex(-1);
    writeUiLog(`Removed ${count} selected item(s).`);
  }, [writeUiLog]);

  const cancelShutdown = useCallback(async (): Promise<boolean> => {
    try {
      await tauriApi.scheduleShutdown(true);
      setShutdownPending(false);
      writeUiLog("Scheduled shutdown cancelled.");
      toast.info("Scheduled shutdown cancelled.");
      return true;
    } catch (err) {
      setAlertDialog({ title: "Failed to Cancel Shutdown", message: formatError(err) });
      return false;
    }
  }, [writeUiLog]);

  const resetAppDefaults = useCallback(async (): Promise<boolean> => {
    if (shutdownPending) {
      const cancelled = await cancelShutdown();
      if (!cancelled) return false;
    }
    probeGenerationRef.current += 1;
    setQueue([]);
    setSelectedIndices(new Set());
    setLastSelectedIndex(-1);
    setSettings(createDefaultSettings());
    setIsRunning(false);
    setIsPaused(false);
    setShutdownPending(false);
    setLogLines([]);
    setBadge("READY");
    setEtaText("--");
    return true;
  }, [cancelShutdown, shutdownPending]);

  const requestClearQueue = useCallback(() => {
    if (isRunningRef.current) return;
    if (queueRef.current.length === 0) {
      resetAppDefaults().then((ok) => {
        if (ok) toast.info("Settings restored to defaults.");
      });
      return;
    }
    setConfirmClearOpen(true);
  }, [resetAppDefaults]);

  const confirmClearQueue = useCallback(async () => {
    setConfirmClearOpen(false);
    const ok = await resetAppDefaults();
    if (ok) toast.info("Queue cleared and settings reset.");
  }, [resetAppDefaults]);

  const resetSelected = useCallback(() => {
    if (isRunningRef.current || selectedRef.current.size === 0) return;
    setQueue((prev) =>
      resetSelectedItems(prev, selectedRef.current, settingsRef.current, false)
    );
    setEtaText("--");
    setBadge("READY");
    writeUiLog("Selected item(s) reset to Ready.");
    toast.info("Selected item(s) reset to Ready.");
  }, [writeUiLog]);

  const retryUnfinished = useCallback(() => {
    if (isRunningRef.current) return;
    setQueue((prev) => retryUnfinishedItems(prev, false));
    setBadge("READY");
    toast.info("Failed and stopped items are ready to retry.");
  }, []);

  const saveQueue = useCallback(async () => {
    try {
      const ok = await tauriApi.saveQueue({
        version: "EncodeX 0.4",
        savedAt: new Date().toISOString(),
        settings: settingsRef.current,
        queue: queueRef.current,
      });
      if (ok) {
        writeUiLog("Queue saved.");
        toast.success("Queue saved to JSON.");
      }
    } catch (err) {
      toast.error("Failed to save queue", { description: formatError(err) });
    }
  }, [writeUiLog]);

  const loadQueue = useCallback(async () => {
    if (isRunningRef.current) return;
    try {
      const data = await tauriApi.loadQueue();
      if (!data || !Array.isArray(data.queue)) return;
      const normalized = normalizeLoadedQueue(data);
      probeGenerationRef.current += 1;
      setSettings(normalized.settings);
      setQueue(normalized.queue);
      setSelectedIndices(new Set());
      setLastSelectedIndex(-1);
      setBadge("READY");
      writeUiLog(`Queue loaded (${normalized.queue.length} item(s)).`);
      toast.success(`Loaded ${normalized.queue.length} item(s).`);
    } catch (err) {
      toast.error("Failed to load queue", { description: formatError(err) });
    }
  }, [writeUiLog]);

  const stopQueue = useCallback(async () => {
    try {
      await tauriApi.stopQueue();
      writeUiLog("Stop requested.");
    } catch (err) {
      setAlertDialog({ title: "Stop Failed", message: formatError(err) });
    }
  }, [writeUiLog]);

  const togglePause = useCallback(async () => {
    try {
      if (!isPaused) {
        const ok = await tauriApi.pauseQueue();
        if (ok) {
          setIsPaused(true);
          setBadge("PAUSED");
        }
      } else {
        const ok = await tauriApi.resumeQueue();
        if (ok) {
          setIsPaused(false);
          setBadge("ENCODING");
        }
      }
    } catch (err) {
      setAlertDialog({
        title: isPaused ? "Resume Failed" : "Pause Failed",
        message: formatError(err),
      });
    }
  }, [isPaused]);

  const openOutput = useCallback(async (index: number) => {
    const item = queueRef.current[index];
    if (!item || !item.output) return;
    try {
      const opened = await tauriApi.openOutputPath(item.output);
      if (!opened) {
        toast.error("Output file or folder not found", {
          description: item.output,
        });
      }
    } catch (err) {
      toast.error("Failed to open output", { description: formatError(err) });
    }
  }, []);

  const clearRealtimeLog = useCallback(() => {
    setLogLines([]);
  }, []);

  const showItemError = useCallback((item: QueueItem) => {
    if (!item.error) return;
    setAlertDialog({
      title: `Error Details — ${baseName(item.source)}`,
      message: item.error,
    });
  }, []);

  return {
    settings,
    queue,
    selectedIndices,
    isRunning,
    isPaused,
    badge,
    etaText,
    shutdownPending,
    logLines,
    logAutoScroll,
    setLogAutoScroll,
    confirmClearOpen,
    setConfirmClearOpen,
    alertDialog,
    setAlertDialog,
    availableUpdate,
    updateDialogOpen,
    setUpdateDialogOpen,
    checkingUpdate,
    checkForUpdates,
    openReleaseUrl,
    addFiles,
    addFolder,
    removeSelected,
    requestClearQueue,
    confirmClearQueue,
    resetSelected,
    retryUnfinished,
    saveQueue,
    loadQueue,
    startQueue,
    stopQueue,
    togglePause,
    cancelShutdown,
    selectRow,
    openOutput,
    showItemError,
    clearRealtimeLog,
    setFormat,
    setPreset,
    setExportVideo,
    setExportAudio,
    setRenderer,
    setOutputMode,
    setCustomFolderInput,
    chooseOutputFolder,
    setResolutionMode,
    setCustomDimensions,
    setFpsMode,
    setCustomFps,
    setExistingAction,
    setConcurrentJobs,
    setAutoShutdown,
  };
}
