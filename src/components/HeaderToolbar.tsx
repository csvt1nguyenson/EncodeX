import {
  ArrowUpCircle,
  Download,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Trash2,
  X,
} from "lucide-react";
import logoUrl from "@/assets/logo.png";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { UpdateCheckResult } from "@/lib/types";

interface HeaderToolbarProps {
  isRunning: boolean;
  isPaused: boolean;
  hasSelection: boolean;
  availableUpdate: UpdateCheckResult | null;
  checkingUpdate: boolean;
  onOpenUpdateDialog: () => void;
  onCheckForUpdates: () => void;
  onAddFiles: () => void;
  onAddFolder: () => void;
  onRemoveSelected: () => void;
  onClearQueue: () => void;
  onResetSelected: () => void;
  onRetryUnfinished: () => void;
  onSaveQueue: () => void;
  onLoadQueue: () => void;
  onTogglePause: () => void;
  onStopQueue: () => void;
  onStartQueue: () => void;
}

export function HeaderToolbar(props: HeaderToolbarProps) {
  const { isRunning, isPaused, hasSelection, availableUpdate, checkingUpdate } = props;

  return (
    <header className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-card px-3.5 py-2">
      <div className="flex items-center gap-2.5">
        <img src={logoUrl} alt="EncodeX" className="h-7 w-auto object-contain" />
        <div className="hidden sm:flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-zinc-100">EncodeX</span>
          <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
            0.4.0
          </span>
          {availableUpdate && (
            <button
              type="button"
              onClick={props.onOpenUpdateDialog}
              className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/15 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 transition-colors hover:bg-cyan-500/25 cursor-pointer"
              title={`Download EncodeX v${availableUpdate.latestVersion}`}
            >
              <ArrowUpCircle className="size-3" />
              Update v{availableUpdate.latestVersion}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={props.onAddFiles} disabled={isRunning}>
          <FilePlus2 /> Add Files
        </Button>
        <Button variant="secondary" onClick={props.onAddFolder} disabled={isRunning}>
          <FolderPlus /> Add Folder
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="icon" title="Queue actions" aria-label="Queue actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              onSelect={props.onRemoveSelected}
              disabled={isRunning || !hasSelection}
            >
              <X /> Remove Selected
              <span className="ml-auto text-[10px] text-zinc-500">Del</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={props.onResetSelected}
              disabled={isRunning || !hasSelection}
            >
              <RotateCcw /> Reset Selected
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={props.onRetryUnfinished} disabled={isRunning}>
              <RefreshCw /> Retry Unfinished
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={props.onClearQueue}
              disabled={isRunning}
              className="text-rose-300 data-[highlighted]:text-rose-200"
            >
              <Trash2 className="!text-rose-400" /> Clear Queue
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={props.onSaveQueue}>
              <Save /> Save Queue...
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={props.onLoadQueue} disabled={isRunning}>
              <FolderOpen /> Load Queue...
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={props.onCheckForUpdates} disabled={checkingUpdate}>
              <Download /> {checkingUpdate ? "Checking Updates..." : "Check for Updates"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="mx-0.5 h-5 w-px bg-zinc-800" />

        <Button
          variant={isPaused ? "warning" : "secondary"}
          onClick={props.onTogglePause}
          disabled={!isRunning}
        >
          {isPaused ? (
            <>
              <Play /> Resume
            </>
          ) : (
            <>
              <Pause /> Pause
            </>
          )}
        </Button>
        <Button variant="destructive" onClick={props.onStopQueue} disabled={!isRunning}>
          <Square /> Stop
        </Button>
        <Button
          variant="primary"
          onClick={props.onStartQueue}
          disabled={isRunning}
          title="Start Queue (Space or Enter)"
        >
          <Play className="fill-current" /> Start Queue
          <kbd className="ml-1 rounded bg-zinc-950/20 px-1 py-0.5 font-mono text-[10px] font-semibold text-zinc-950/80">
            Space
          </kbd>
        </Button>
      </div>
    </header>
  );
}
