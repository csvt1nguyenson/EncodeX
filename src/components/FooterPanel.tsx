import { useEffect, useRef } from "react";
import { Eraser, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatFpsSummary, formatResolutionSummary } from "@/lib/presets";
import type { ExportSettings } from "@/lib/types";

interface FooterPanelProps {
  settings: ExportSettings;
  selectedCount: number;
  logLines: string[];
  logAutoScroll: boolean;
  onLogAutoScrollChange: (enabled: boolean) => void;
  onClearLog: () => void;
}

export function FooterPanel({
  settings,
  selectedCount,
  logLines,
  logAutoScroll,
  onLogAutoScrollChange,
  onClearLog,
}: FooterPanelProps) {
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!logAutoScroll || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines, logAutoScroll]);

  const outputLabel =
    settings.outputMode === "source_output"
      ? "FolderName_OUTPUT"
      : settings.outputMode === "same_folder"
        ? "Same Folder"
        : "Custom Folder";

  const existsLabel =
    settings.existingAction === "autorename"
      ? "Auto Rename"
      : settings.existingAction === "overwrite"
        ? "Overwrite"
        : "Skip";

  return (
    <div className="grid h-44 shrink-0 grid-cols-[250px_minmax(0,1fr)] gap-3">
      <div className="flex flex-col justify-between overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-200">
        <div className="space-y-0.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Active Preset
          </div>
          <p>
            <span className="text-zinc-500">Format:</span> {settings.formatLabel}
          </p>
          <p>
            <span className="text-zinc-500">Preset:</span> {settings.presetLabel}
          </p>
          <p>
            <span className="text-zinc-500">Selected:</span> {selectedCount} job(s)
          </p>
          <p>
            <span className="text-zinc-500">Output:</span> {outputLabel}
          </p>
          <p>
            <span className="text-zinc-500">Video:</span> {formatResolutionSummary(settings)} ·{" "}
            {formatFpsSummary(settings)}
          </p>
          <p>
            <span className="text-zinc-500">Exists:</span> {existsLabel} ·{" "}
            <span className="text-cyan-400 font-medium">{settings.concurrentJobs} job</span>
          </p>
          <p>
            <span className="text-zinc-500">Streams:</span> Video{" "}
            {settings.exportVideo ? "On" : "Off"} · Audio {settings.exportAudio ? "On" : "Off"}
          </p>
        </div>
      </div>

      <section
        aria-label="Realtime Log"
        className="flex min-w-0 flex-col rounded-lg border border-zinc-800 bg-zinc-950 p-2.5"
      >
        <div className="mb-1.5 flex items-center gap-3">
          <div className="mr-auto flex items-center gap-1.5 text-xs font-medium text-zinc-200">
            <Terminal className="size-3.5 text-zinc-400" />
            Realtime Log
            <span className="text-[10px] font-normal text-zinc-500">
              ({logLines.length}/2000)
            </span>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
            <Switch
              checked={logAutoScroll}
              onCheckedChange={onLogAutoScrollChange}
              aria-label="Auto-scroll log"
            />
            Auto-scroll
          </label>
          <Button size="sm" variant="ghost" onClick={onClearLog}>
            <Eraser /> Clear
          </Button>
        </div>
        <pre
          id="realtimeLog"
          ref={logRef}
          aria-label="Encode log"
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/50 p-2 font-mono text-[11px] leading-relaxed text-zinc-400 select-text"
        >
          {logLines.length > 0 ? logLines.join("\n") : "No logs yet."}
        </pre>
      </section>
    </div>
  );
}
