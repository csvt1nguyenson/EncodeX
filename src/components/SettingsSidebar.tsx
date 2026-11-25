import { version } from "../../package.json";
import { FolderSearch, PowerOff, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  CONCURRENT_OPTIONS,
  EXISTING_ACTION_OPTIONS,
  FORMAT_OPTIONS,
  FPS_OPTIONS,
  OUTPUT_MODE_OPTIONS,
  PRESETS,
  RENDERER_OPTIONS,
  RESOLUTION_OPTIONS,
  isAudioOnlyFormat,
} from "@/lib/presets";
import type {
  ExistingAction,
  ExportSettings,
  FormatId,
  OutputMode,
  RendererMode,
} from "@/lib/types";

interface SettingsSidebarProps {
  settings: ExportSettings;
  isRunning: boolean;
  shutdownPending: boolean;
  onFormatChange: (format: FormatId) => void;
  onPresetChange: (preset: string) => void;
  onExportVideoChange: (enabled: boolean) => void;
  onExportAudioChange: (enabled: boolean) => void;
  onRendererChange: (renderer: RendererMode) => void;
  onOutputModeChange: (mode: OutputMode) => void;
  onCustomFolderChange: (value: string) => void;
  onChooseOutputFolder: () => void;
  onResolutionModeChange: (mode: string) => void;
  onCustomDimensionsChange: (patch: { customWidth?: string; customHeight?: string }) => void;
  onFpsModeChange: (mode: string) => void;
  onCustomFpsChange: (value: string) => void;
  onExistingActionChange: (action: ExistingAction) => void;
  onConcurrentJobsChange: (value: string) => void;
  onAutoShutdownChange: (checked: boolean) => void;
  onCancelShutdown: () => void;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-[11px] font-medium text-zinc-400">{children}</label>;
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800/90 bg-zinc-950/60 p-3 space-y-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        {title}
      </div>
      {children}
    </section>
  );
}

export function SettingsSidebar(props: SettingsSidebarProps) {
  const { settings, isRunning, shutdownPending } = props;
  const audioOnly = isAudioOnlyFormat(settings.format);
  const presetList = PRESETS[settings.format] ?? [];

  return (
    <aside className="flex min-h-0 flex-col rounded-xl border border-zinc-800 bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3.5 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-100">
          <SlidersHorizontal className="size-3.5 text-zinc-400" />
          Export Settings
        </div>
        <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
          {settings.renderer === "nvidia" ? "NVENC" : "CPU"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        <SectionCard title="Format & Codec">
          <div>
            <FieldLabel>Format</FieldLabel>
            <Select
              value={settings.format}
              onValueChange={(v) => props.onFormatChange(v as FormatId)}
              disabled={isRunning}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <FieldLabel>Preset</FieldLabel>
            <Select
              value={settings.preset}
              onValueChange={props.onPresetChange}
              disabled={isRunning}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presetList.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-0.5">
            <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
              <span className="text-[11px] font-medium text-zinc-200">Video</span>
              <Switch
                checked={audioOnly ? false : settings.exportVideo}
                onCheckedChange={props.onExportVideoChange}
                disabled={isRunning || audioOnly}
                aria-label="Export Video"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
              <span className="text-[11px] font-medium text-zinc-200">Audio</span>
              <Switch
                checked={settings.exportAudio}
                onCheckedChange={props.onExportAudioChange}
                disabled={isRunning}
                aria-label="Export Audio"
              />
            </div>
          </div>

          <div>
            <FieldLabel>Renderer</FieldLabel>
            <Select
              value={settings.renderer}
              onValueChange={(v) => props.onRendererChange(v as RendererMode)}
              disabled={isRunning}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RENDERER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SectionCard>

        <SectionCard title="Output">
          <div>
            <FieldLabel>Output Mode</FieldLabel>
            <Select
              value={settings.outputMode}
              onValueChange={(v) => props.onOutputModeChange(v as OutputMode)}
              disabled={isRunning}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OUTPUT_MODE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <FieldLabel>Custom Output Folder</FieldLabel>
            <div className="flex gap-1.5">
              <Input
                value={settings.customFolder}
                onChange={(e) => props.onCustomFolderChange(e.target.value)}
                placeholder="Paste output folder path..."
                disabled={isRunning}
              />
              <Button
                size="icon"
                variant="secondary"
                onClick={props.onChooseOutputFolder}
                disabled={isRunning}
                title="Browse output folder"
              >
                <FolderSearch />
              </Button>
            </div>
          </div>

          <div>
            <FieldLabel>If Output Exists</FieldLabel>
            <Select
              value={settings.existingAction}
              onValueChange={(v) => props.onExistingActionChange(v as ExistingAction)}
              disabled={isRunning}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXISTING_ACTION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SectionCard>

        <SectionCard title="Video & Frame Rate">
          <div>
            <FieldLabel>Resolution</FieldLabel>
            <Select
              value={settings.resolutionMode}
              onValueChange={props.onResolutionModeChange}
              disabled={isRunning || audioOnly}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESOLUTION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {settings.resolutionMode === "custom" && !audioOnly && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <FieldLabel>Width</FieldLabel>
                <Input
                  type="number"
                  min={16}
                  step={2}
                  placeholder="1920"
                  value={settings.customWidth}
                  onChange={(e) => props.onCustomDimensionsChange({ customWidth: e.target.value })}
                  disabled={isRunning}
                />
              </div>
              <div>
                <FieldLabel>Height</FieldLabel>
                <Input
                  type="number"
                  min={16}
                  step={2}
                  placeholder="1080"
                  value={settings.customHeight}
                  onChange={(e) => props.onCustomDimensionsChange({ customHeight: e.target.value })}
                  disabled={isRunning}
                />
              </div>
            </div>
          )}

          <div>
            <FieldLabel>Frame Rate (FPS)</FieldLabel>
            <Select
              value={settings.fpsMode}
              onValueChange={props.onFpsModeChange}
              disabled={isRunning || audioOnly}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FPS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {settings.fpsMode === "custom" && !audioOnly && (
            <div>
              <FieldLabel>Custom FPS</FieldLabel>
              <Input
                type="number"
                min={1}
                max={240}
                step="0.001"
                placeholder="30"
                value={settings.customFps}
                onChange={(e) => props.onCustomFpsChange(e.target.value)}
                disabled={isRunning}
              />
            </div>
          )}
        </SectionCard>

        <SectionCard title="Queue & System">
          <div>
            <FieldLabel>Concurrent Jobs</FieldLabel>
            <Select
              value={String(settings.concurrentJobs)}
              onValueChange={props.onConcurrentJobsChange}
              disabled={isRunning}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONCURRENT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
            <span className="text-[11px] leading-snug text-zinc-300">
              Auto shutdown when done (60s)
            </span>
            <Switch
              checked={settings.autoShutdown}
              onCheckedChange={props.onAutoShutdownChange}
              aria-label="Auto shutdown"
            />
          </div>

          {shutdownPending && (
            <Button variant="destructive" className="w-full" onClick={props.onCancelShutdown}>
              <PowerOff /> Cancel Shutdown
            </Button>
          )}
        </SectionCard>

        <p className="px-1 text-center text-[10px] text-zinc-600">EncodeX {version} · Tauri v2</p>
      </div>
    </aside>
  );
}
