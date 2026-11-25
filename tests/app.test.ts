import { describe, expect, it } from "vitest";
import { buildOutputPreview, normalizeFolderInput } from "../src/lib/paths";
import {
  clampConcurrentJobs,
  createDefaultSettings,
  formatInfoText,
  formatSizeText,
} from "../src/lib/presets";
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
} from "../src/lib/queueLogic";
import type { QueueItem } from "../src/lib/types";

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  const defaults = createDefaultSettings();
  return {
    source: "D:\\Videos\\clip.mov",
    info: {},
    format: defaults.format,
    formatLabel: defaults.formatLabel,
    preset: defaults.preset,
    presetLabel: defaults.presetLabel,
    exportVideo: true,
    exportAudio: true,
    outputMode: "source_output",
    customFolder: "",
    resolutionMode: "source",
    customWidth: "",
    customHeight: "",
    fpsMode: "source",
    customFps: "",
    output: "D:\\Videos\\Videos_OUTPUT\\clip.mp4",
    sizeBefore: "",
    sizeAfter: "",
    savedPercent: "",
    status: "Ready",
    progress: 0,
    eta: "--",
    ...overrides,
  };
}

describe("EncodeX 0.4.0 core queue & path logic", () => {
  it("defaults start with H.265 High Quality, NVENC, FolderName_OUTPUT, Auto Rename, 1 job", () => {
    const s = createDefaultSettings();
    expect(s.format).toBe("h265_mp4");
    expect(s.preset).toBe("h265_high");
    expect(s.renderer).toBe("nvidia");
    expect(s.outputMode).toBe("source_output");
    expect(s.existingAction).toBe("autorename");
    expect(s.concurrentJobs).toBe(1);
    expect(s.autoShutdown).toBe(false);
  });

  it("triggers Space/Enter start shortcut only when safe and queue has items", () => {
    const bodyTarget = { tagName: "BODY", closest: () => null } as unknown as EventTarget;
    expect(
      shouldTriggerStartShortcut({
        key: " ",
        target: bodyTarget,
        isRunning: false,
        hasOpenDialog: false,
        queueLength: 2,
      })
    ).toBe(true);
    expect(
      shouldTriggerStartShortcut({
        key: "Enter",
        target: bodyTarget,
        isRunning: false,
        hasOpenDialog: false,
        queueLength: 1,
      })
    ).toBe(true);
    expect(
      shouldTriggerStartShortcut({
        key: " ",
        target: { tagName: "INPUT" } as unknown as EventTarget,
        isRunning: false,
        hasOpenDialog: false,
        queueLength: 1,
      })
    ).toBe(false);
    expect(
      shouldTriggerStartShortcut({
        key: "Enter",
        target: bodyTarget,
        isRunning: true,
        hasOpenDialog: false,
        queueLength: 1,
      })
    ).toBe(false);
    expect(
      shouldTriggerStartShortcut({
        key: " ",
        target: bodyTarget,
        isRunning: false,
        hasOpenDialog: true,
        queueLength: 1,
      })
    ).toBe(false);
  });

  it("clamps concurrent jobs between 1 and 5", () => {
    expect(clampConcurrentJobs(0)).toBe(1);
    expect(clampConcurrentJobs(-5)).toBe(1);
    expect(clampConcurrentJobs("3")).toBe(3);
    expect(clampConcurrentJobs(5)).toBe(5);
    expect(clampConcurrentJobs(100)).toBe(5);
    expect(clampConcurrentJobs("invalid")).toBe(1);
  });

  it("mirrors Rust output path rules for same_folder and drive roots (Bug #6)", () => {
    const defaults = createDefaultSettings();
    const sameFolder = buildOutputPreview(
      {
        source: "D:\\Footage\\shot01.mov",
        format: "h264_mp4",
        outputMode: "same_folder",
        customFolder: "",
      },
      defaults
    );
    expect(sameFolder).toBe("D:\\Footage\\shot01_encoded.mp4");

    const driveRoot = buildOutputPreview(
      {
        source: "D:\\clip.mp4",
        format: "h264_mp4",
        outputMode: "source_output",
        customFolder: "",
      },
      defaults
    );
    expect(driveRoot).toBe("D:\\_OUTPUT\\clip.mp4");
  });

  it("normalizes pasted folder paths and reverts empty folder to FolderName_OUTPUT", () => {
    expect(normalizeFolderInput('  "Y:/Footage mới/Output"  ')).toBe("Y:\\Footage mới\\Output");
    expect(resolveCustomFolderUpdate('  "Y:/Out" ')).toEqual({
      outputMode: "custom_folder",
      customFolder: "Y:\\Out",
    });
    expect(resolveCustomFolderUpdate("   ")).toEqual({
      outputMode: "source_output",
      customFolder: "",
    });
  });

  it("applies pasted folder only to selected unfinished items and never rewrites Done/Skipped", () => {
    const s = createDefaultSettings();
    const queue = [
      makeItem({ source: "D:\\src\\a.mov", status: "Ready" }),
      makeItem({ source: "D:\\src\\b.mov", status: "Ready", output: "D:\\src\\src_OUTPUT\\b.mp4" }),
      makeItem({ source: "D:\\src\\c.mov", status: "Done", output: "D:\\original\\c.mp4" }),
    ];

    const updated = applyOutputToSelected(
      queue,
      new Set([0, 2]),
      "custom_folder",
      '"Y:/Footage mới/Output"',
      s,
      false
    );
    expect(updated[0].outputMode).toBe("custom_folder");
    expect(updated[0].customFolder).toBe("Y:\\Footage mới\\Output");
    expect(updated[0].output).toBe("Y:\\Footage mới\\Output\\a.mp4");
    expect(updated[1].output).toBe("D:\\src\\src_OUTPUT\\b.mp4");
    expect(updated[2].output).toBe("D:\\original\\c.mp4");
  });

  it("ignores empty or duplicate file additions without clearing existing queue (Bug #2)", () => {
    const s = createDefaultSettings();
    const existing = [makeItem({ source: "D:\\a.mp4", status: "Ready" })];

    const cancelResult = createQueueItemsFromPaths(existing, [], s);
    expect(cancelResult.addedPaths).toEqual([]);
    expect(cancelResult.nextQueue).toBe(existing);

    const dupResult = createQueueItemsFromPaths(existing, ["D:\\a.mp4"], s);
    expect(dupResult.addedPaths).toEqual([]);
    expect(dupResult.nextQueue.length).toBe(1);
  });

  it("updates Info, Size and exits Waiting on probe success or probe failure (Bugs #2 & #4)", () => {
    const s = createDefaultSettings();
    const { nextQueue } = createQueueItemsFromPaths([], ["D:\\a.mp4", "D:\\b.mp4"], s);
    expect(nextQueue[0].status).toBe("Waiting");

    const afterSuccess = applyProbeResult(nextQueue, "D:\\a.mp4", {
      resolution: "1920x1080",
      fps: "30.00",
      duration: "00:01:12",
      size: "24.5 MB",
    });
    expect(afterSuccess[0].status).toBe("Ready");
    expect(formatInfoText(afterSuccess[0])).toBe("1920x1080 · 30.00 fps · 00:01:12");
    expect(formatSizeText(afterSuccess[0])).toBe("24.5 MB");

    const afterFailure = applyProbeResult(afterSuccess, "D:\\b.mp4", {}, "ffprobe failed");
    expect(afterFailure[1].status).toBe("Ready");
    expect(afterFailure[1].error).toBe("ffprobe failed");
  });

  it("guards keyboard shortcuts when typing inside inputs or log console (Bug #5)", () => {
    expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" } as unknown as EventTarget)).toBe(true);
    expect(
      isEditableTarget({
        tagName: "PRE",
        closest: (sel: string) => sel.includes("#realtimeLog"),
      } as unknown as EventTarget)
    ).toBe(true);
    expect(isEditableTarget({ tagName: "BODY", closest: () => null } as unknown as EventTarget)).toBe(
      false
    );
  });

  it("locks edits, removals, and resets while queue is running", () => {
    const s = createDefaultSettings();
    const queue = [makeItem({ source: "D:\\a.mp4", preset: "h264_high" })];
    const modified = { ...s, preset: "h264_small", presetLabel: "Small File" };

    expect(applySettingsToSelected(queue, new Set([0]), modified, true)[0].preset).toBe("h264_high");
    expect(removeSelectedItems(queue, new Set([0]), true).length).toBe(1);
    expect(resetSelectedItems([makeItem({ status: "Done" })], new Set([0]), s, true)[0].status).toBe(
      "Done"
    );
  });

  it("manual Load Queue preserves Done/Skipped/Failed and resets interrupted items", () => {
    const loaded = normalizeLoadedQueue({
      version: "EncodeX 0.4",
      savedAt: "2026-11-25T00:00:00Z",
      settings: { concurrentJobs: 9, format: "mp3", exportVideo: true },
      queue: [
        { source: "D:\\a.mp4", status: "Done", progress: 100 },
        { source: "D:\\b.mp4", status: "Encoding", progress: 52 },
      ],
    });
    expect(loaded.settings.concurrentJobs).toBe(5);
    expect(loaded.settings.exportVideo).toBe(false);
    expect(loaded.queue[0].status).toBe("Done");
    expect(loaded.queue[1].status).toBe("Ready");
    expect(loaded.queue[1].progress).toBe(0);
  });

  it("retry resets only Failed/Stopped and auto-shutdown triggers only on clean success", () => {
    const queue = [
      makeItem({ source: "a", status: "Done" }),
      makeItem({ source: "b", status: "Failed", error: "boom" }),
      makeItem({ source: "c", status: "Stopped" }),
    ];
    const retried = retryUnfinishedItems(queue, false);
    expect(retried.map((x) => x.status)).toEqual(["Done", "Ready", "Ready"]);
    expect(retried[1].error).toBeUndefined();

    expect(shouldScheduleAutoShutdown([makeItem({ status: "Failed" })], { completed: 1 }, true)).toBe(
      false
    );
    expect(
      shouldScheduleAutoShutdown([makeItem({ status: "Done" })], { stopped: true, completed: 1 }, true)
    ).toBe(false);
    expect(
      shouldScheduleAutoShutdown([makeItem({ status: "Done" })], { stopped: false, completed: 0 }, true)
    ).toBe(false);
    expect(
      shouldScheduleAutoShutdown([makeItem({ status: "Done" })], { stopped: false, completed: 1 }, true)
    ).toBe(true);
  });

  it("caps realtime log buffer at 2000 plain-text lines", () => {
    let lines: string[] = [];
    for (let i = 0; i < 2100; i++) {
      lines = appendLogLine(lines, { time: "12:00:00", message: String(i) }, 2000);
    }
    expect(lines.length).toBe(2000);
    expect(lines[0]).toBe("[12:00:00] 100");
    expect(lines[1999]).toBe("[12:00:00] 2099");
  });
});
