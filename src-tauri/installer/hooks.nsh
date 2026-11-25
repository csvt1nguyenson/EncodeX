!define ENCODEX_FFMPEG_SCRIPT "${__FILEDIR__}\..\src\install_ffmpeg.ps1"

; Keep fresh defaults and prepare media tools before reporting install success.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$LOCALAPPDATA\EncodeX\recovery.json"
  Delete "$LOCALAPPDATA\EncodeX\recovery.tmp"
  InitPluginsDir
  File "/oname=$PLUGINSDIR\install_ffmpeg.ps1" "${ENCODEX_FFMPEG_SCRIPT}"
  Push $0
  Push $1
  StrCpy $1 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${RunningX64}
    StrCpy $1 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  encodex_prepare_ffmpeg:
    DetailPrint "Checking FFmpeg/FFprobe; missing tools will be downloaded automatically..."
    nsExec::ExecToLog '"$1" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install_ffmpeg.ps1" -AppDirectory "$INSTDIR"'
    Pop $0
    ${If} $0 != "0"
      ${IfNot} ${Silent}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "FFmpeg/FFprobe could not be prepared. Check your Internet connection and click Retry. See the installation details for the error." IDRETRY encodex_prepare_ffmpeg
      ${EndIf}
      Pop $1
      Pop $0
      SetErrorLevel 1
      Abort "FFmpeg/FFprobe preparation failed."
    ${EndIf}
  Pop $1
  Pop $0
!macroend
