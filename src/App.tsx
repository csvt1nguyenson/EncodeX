import { FooterPanel } from "@/components/FooterPanel";
import { HeaderToolbar } from "@/components/HeaderToolbar";
import { QueueTable } from "@/components/QueueTable";
import { SettingsSidebar } from "@/components/SettingsSidebar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEncodeX } from "@/hooks/useEncodeX";

export function App() {
  const app = useEncodeX();

  return (
    <TooltipProvider delayDuration={300}>
      <div className="grid h-screen grid-rows-[auto_minmax(0,1fr)] gap-2.5 p-2.5 overflow-hidden bg-background">
        <HeaderToolbar
          isRunning={app.isRunning}
          isPaused={app.isPaused}
          hasSelection={app.selectedIndices.size > 0}
          availableUpdate={app.availableUpdate}
          checkingUpdate={app.checkingUpdate}
          onOpenUpdateDialog={() => app.setUpdateDialogOpen(true)}
          onCheckForUpdates={() => void app.checkForUpdates(false)}
          onAddFiles={app.addFiles}
          onAddFolder={app.addFolder}
          onRemoveSelected={app.removeSelected}
          onClearQueue={app.requestClearQueue}
          onResetSelected={app.resetSelected}
          onRetryUnfinished={app.retryUnfinished}
          onSaveQueue={app.saveQueue}
          onLoadQueue={app.loadQueue}
          onTogglePause={app.togglePause}
          onStopQueue={app.stopQueue}
          onStartQueue={app.startQueue}
        />

        <main className="grid min-h-0 grid-cols-[320px_minmax(0,1fr)] gap-2.5 overflow-hidden">
          <SettingsSidebar
            settings={app.settings}
            isRunning={app.isRunning}
            shutdownPending={app.shutdownPending}
            onFormatChange={app.setFormat}
            onPresetChange={app.setPreset}
            onExportVideoChange={app.setExportVideo}
            onExportAudioChange={app.setExportAudio}
            onRendererChange={app.setRenderer}
            onOutputModeChange={app.setOutputMode}
            onCustomFolderChange={app.setCustomFolderInput}
            onChooseOutputFolder={app.chooseOutputFolder}
            onResolutionModeChange={app.setResolutionMode}
            onCustomDimensionsChange={app.setCustomDimensions}
            onFpsModeChange={app.setFpsMode}
            onCustomFpsChange={app.setCustomFps}
            onExistingActionChange={app.setExistingAction}
            onConcurrentJobsChange={app.setConcurrentJobs}
            onAutoShutdownChange={app.setAutoShutdown}
            onCancelShutdown={app.cancelShutdown}
          />

          <section className="flex min-h-0 min-w-0 flex-col gap-2.5 rounded-xl border border-zinc-800 bg-card p-3 overflow-hidden">
            <QueueTable
              queue={app.queue}
              settings={app.settings}
              selectedIndices={app.selectedIndices}
              badge={app.badge}
              etaText={app.etaText}
              isRunning={app.isRunning}
              onAddFiles={app.addFiles}
              onSelectRow={app.selectRow}
              onOpenOutput={app.openOutput}
              onShowError={app.showItemError}
            />

            <FooterPanel
              settings={app.settings}
              selectedCount={app.selectedIndices.size}
              logLines={app.logLines}
              logAutoScroll={app.logAutoScroll}
              onLogAutoScrollChange={app.setLogAutoScroll}
              onClearLog={app.clearRealtimeLog}
            />
          </section>
        </main>
      </div>

      <AlertDialog open={app.confirmClearOpen} onOpenChange={app.setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Clear Queue</AlertDialogTitle>
          <AlertDialogDescription>
            Clear all items from the queue and restore export settings to defaults? Exported media
            and log files on disk will not be deleted.
          </AlertDialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogCancel asChild>
              <Button variant="secondary">Cancel</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" onClick={app.confirmClearQueue}>
                Clear Queue
              </Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(app.alertDialog)}
        onOpenChange={(open) => {
          if (!open) app.setAlertDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{app.alertDialog?.title ?? "Notice"}</AlertDialogTitle>
          <AlertDialogDescription>{app.alertDialog?.message}</AlertDialogDescription>
          <div className="mt-5 flex justify-end">
            <AlertDialogAction asChild>
              <Button variant="primary" onClick={() => app.setAlertDialog(null)}>
                Close
              </Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={app.updateDialogOpen && Boolean(app.availableUpdate)}
        onOpenChange={app.setUpdateDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            Update Available — v{app.availableUpdate?.latestVersion}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {`A newer version of EncodeX is available (v${app.availableUpdate?.currentVersion} → v${app.availableUpdate?.latestVersion}).`}
            {app.availableUpdate?.notes ? `\n\n${app.availableUpdate.notes}` : ""}
          </AlertDialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogCancel asChild>
              <Button variant="secondary">Later</Button>
            </AlertDialogCancel>
            {app.availableUpdate &&
              app.availableUpdate.releaseUrl !== app.availableUpdate.downloadUrl && (
                <Button
                  variant="secondary"
                  onClick={() => void app.openReleaseUrl(app.availableUpdate!.releaseUrl)}
                >
                  View Release
                </Button>
              )}
            <AlertDialogAction asChild>
              <Button
                variant="primary"
                onClick={() => {
                  if (app.availableUpdate) {
                    void app.openReleaseUrl(app.availableUpdate.downloadUrl);
                  }
                }}
              >
                Download Installer
              </Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <Toaster />
    </TooltipProvider>
  );
}

export default App;
