import { AlertCircle, ExternalLink, Film } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { baseName, buildOutputPreview } from "@/lib/paths";
import { formatInfoText, formatSizeText } from "@/lib/presets";
import type { AppBadgeState, ExportSettings, JobStatus, QueueItem } from "@/lib/types";
import { cn } from "@/lib/utils";

interface QueueTableProps {
  queue: QueueItem[];
  settings: ExportSettings;
  selectedIndices: Set<number>;
  badge: AppBadgeState;
  etaText: string;
  isRunning: boolean;
  onAddFiles: () => void;
  onSelectRow: (
    index: number,
    modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }
  ) => void;
  onOpenOutput: (index: number) => void;
  onShowError: (item: QueueItem) => void;
}

function appBadgeTone(badge: AppBadgeState) {
  switch (badge) {
    case "ENCODING":
      return "cyan" as const;
    case "DONE":
      return "emerald" as const;
    case "PAUSED":
    case "WAITING...":
      return "amber" as const;
    case "STOPPED":
      return "orange" as const;
    case "COMPLETED WITH ERRORS":
      return "rose" as const;
    default:
      return "neutral" as const;
  }
}

function jobStatusTone(status: JobStatus) {
  switch (status) {
    case "Encoding":
    case "Finishing...":
      return "cyan" as const;
    case "Done":
      return "emerald" as const;
    case "Waiting":
    case "Skipped":
      return "amber" as const;
    case "Stopped":
      return "orange" as const;
    case "Failed":
      return "rose" as const;
    default:
      return "neutral" as const;
  }
}

export function QueueTable({
  queue,
  settings,
  selectedIndices,
  badge,
  etaText,
  isRunning,
  onAddFiles,
  onSelectRow,
  onOpenOutput,
  onShowError,
}: QueueTableProps) {
  const doneCount = queue.filter((x) => x.status === "Done" || x.status === "Skipped").length;
  const failedCount = queue.filter((x) => x.status === "Failed").length;

  const handleEmptyAreaDoubleClick = () => {
    if (!isRunning) {
      onAddFiles();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-200">Queue</h2>
          {selectedIndices.size > 0 && (
            <span className="text-[11px] font-medium text-cyan-400">
              {selectedIndices.size} selected
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">Total: {queue.length}</Badge>
          <Badge tone={doneCount > 0 ? "emerald" : "neutral"}>Done: {doneCount}</Badge>
          <Badge tone={failedCount > 0 ? "rose" : "neutral"}>Failed: {failedCount}</Badge>
          <Badge tone={etaText !== "--" ? "cyan" : "neutral"}>ETA: {etaText}</Badge>
          <Badge tone={appBadgeTone(badge)} className="uppercase tracking-wide">
            {badge === "ENCODING" && (
              <span className="size-1.5 rounded-full bg-cyan-400 animate-pulse" />
            )}
            {badge}
          </Badge>
        </div>
      </div>

      {/* Double-clicking empty queue area opens Add Files dialog, like Adobe Media Encoder */}
      <div
        onDoubleClick={handleEmptyAreaDoubleClick}
        className="min-h-0 flex-1 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950"
      >
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr
              onDoubleClick={(e) => e.stopPropagation()}
              className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/95 text-left text-[11px] font-medium text-zinc-400"
            >
              <th className="w-10 px-3 py-2">#</th>
              <th className="px-3 py-2">Format</th>
              <th className="px-3 py-2">Preset</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Output</th>
              <th className="px-3 py-2">Info</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2">Status</th>
              <th className="w-32 px-3 py-2">Progress</th>
            </tr>
          </thead>
          <tbody>
            {queue.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-24 text-center select-none">
                  <div className="mx-auto flex max-w-xs flex-col items-center gap-2 text-zinc-400">
                    <div className="flex size-10 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-300">
                      <Film className="size-4" />
                    </div>
                    <p className="text-xs font-medium text-zinc-200">Queue is empty</p>
                    <p className="text-[11px] text-zinc-500">
                      Double-click here to add files, or press{" "}
                      <kbd className="rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 font-mono text-[10px] text-zinc-300">
                        Space
                      </kbd>{" "}
                      /{" "}
                      <kbd className="rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 font-mono text-[10px] text-zinc-300">
                        Enter
                      </kbd>{" "}
                      to start once files are ready.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              queue.map((item, index) => {
                const selected = selectedIndices.has(index);
                const outputPath = item.output || buildOutputPreview(item, settings);
                const isOpenable =
                  (item.status === "Done" || item.status === "Skipped") && Boolean(outputPath);
                const progressTone =
                  item.status === "Done"
                    ? "emerald"
                    : item.status === "Failed"
                      ? "rose"
                      : "cyan";

                return (
                  <tr
                    key={item.source}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) =>
                      onSelectRow(index, {
                        shiftKey: e.shiftKey,
                        ctrlKey: e.ctrlKey,
                        metaKey: e.metaKey,
                      })
                    }
                    className={cn(
                      "cursor-pointer border-b border-zinc-900 transition-colors",
                      selected
                        ? "bg-cyan-500/12 shadow-[inset_2px_0_0_0_#22d3ee]"
                        : "hover:bg-zinc-900/70"
                    )}
                  >
                    <td className="px-3 py-2 font-mono text-[11px] text-zinc-500">
                      {index + 1}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-200">
                      {item.formatLabel}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                      {item.presetLabel}
                    </td>
                    <td
                      className={cn(
                        "max-w-[240px] truncate px-3 py-2 font-medium",
                        selected ? "text-cyan-200" : "text-zinc-100"
                      )}
                      title={item.source}
                    >
                      {baseName(item.source)}
                    </td>
                    <td className="max-w-[240px] truncate px-3 py-2" title={outputPath}>
                      {isOpenable ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenOutput(index);
                          }}
                          className="inline-flex max-w-full items-center gap-1 truncate text-cyan-400 hover:text-cyan-300 hover:underline cursor-pointer"
                        >
                          <span className="truncate">{baseName(outputPath)}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </button>
                      ) : (
                        <span className="text-zinc-400">
                          {outputPath ? baseName(outputPath) : "Auto"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                      {formatInfoText(item)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                      {formatSizeText(item)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {item.error ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onShowError(item);
                          }}
                          title={item.error}
                          className="cursor-pointer"
                        >
                          <Badge tone={jobStatusTone(item.status)}>
                            <AlertCircle className="size-3" />
                            {item.status}
                          </Badge>
                        </button>
                      ) : (
                        <Badge tone={jobStatusTone(item.status)}>{item.status}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Progress value={item.progress} tone={progressTone} className="w-20" />
                        <span className="w-8 text-right font-mono text-[10px] text-zinc-400">
                          {Math.round(item.progress)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
