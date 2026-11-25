use std::time::Instant;

use crate::state::{write_log, AppState};

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Put FFmpeg in a kill-on-close job so it cannot outlive a crashed app.
#[cfg(target_os = "windows")]
pub fn kill_with_app(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB: OnceLock<usize> = OnceLock::new();
    unsafe {
        // The handle is intentionally never closed: Windows closes it when the app dies.
        let job = *JOB.get_or_init(|| {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            job as usize
        });
        AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn kill_with_app(_child: &std::process::Child) {}

#[cfg(target_os = "windows")]
extern "system" {
    fn GetModuleHandleA(lpModuleName: *const u8) -> isize;
    fn GetProcAddress(
        hModule: isize,
        lpProcName: *const u8,
    ) -> Option<unsafe extern "system" fn() -> isize>;
}

#[cfg(target_os = "windows")]
pub fn suspend_process(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME};

    type NtSuspendProcessFn = unsafe extern "system" fn(handle: HANDLE) -> i32;

    unsafe {
        let ntdll = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        if ntdll == 0 {
            return false;
        }
        let nt_suspend = GetProcAddress(ntdll, b"NtSuspendProcess\0".as_ptr());
        if nt_suspend.is_none() {
            return false;
        }
        let nt_suspend: NtSuspendProcessFn = std::mem::transmute(nt_suspend);

        let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        if handle.is_null() {
            return false;
        }
        let status = nt_suspend(handle);
        CloseHandle(handle);
        status >= 0
    }
}

#[cfg(not(target_os = "windows"))]
pub fn suspend_process(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn resume_process(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME};

    type NtResumeProcessFn = unsafe extern "system" fn(handle: HANDLE) -> i32;

    unsafe {
        let ntdll = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        if ntdll == 0 {
            return false;
        }
        let nt_resume = GetProcAddress(ntdll, b"NtResumeProcess\0".as_ptr());
        if nt_resume.is_none() {
            return false;
        }
        let nt_resume: NtResumeProcessFn = std::mem::transmute(nt_resume);

        let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        if handle.is_null() {
            return false;
        }
        let status = nt_resume(handle);
        CloseHandle(handle);
        status >= 0
    }
}

#[cfg(not(target_os = "windows"))]
pub fn resume_process(_pid: u32) -> bool {
    false
}

pub fn stop_all(state: &AppState) {
    let mut inner = state.0.lock().unwrap();
    inner.stop_requested = true;
    let paused = inner.is_paused;
    for child in inner.children.values_mut() {
        if paused {
            let _ = resume_process(child.id());
        }
        let _ = child.kill();
    }
    if let Some(started) = inner.paused_since.take() {
        inner.paused_total = inner.paused_total.saturating_add(started.elapsed());
    }
    inner.is_paused = false;
}

pub fn set_queue_paused(state: &AppState, paused: bool) -> bool {
    {
        let mut inner = state.0.lock().unwrap();
        if !inner.running || inner.stop_requested || inner.is_paused == paused {
            return false;
        }
        let mut changed = Vec::new();
        for child in inner.children.values_mut() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                continue;
            }
            let pid = child.id();
            let ok = if paused {
                suspend_process(pid)
            } else {
                resume_process(pid)
            };
            if ok {
                changed.push(pid);
            } else {
                // Roll back partial success so global state matches every child.
                for rollback_pid in changed {
                    if paused {
                        let _ = resume_process(rollback_pid);
                    } else {
                        let _ = suspend_process(rollback_pid);
                    }
                }
                return false;
            }
        }
        inner.is_paused = paused;
        if paused {
            inner.paused_since = Some(Instant::now());
        } else if let Some(started) = inner.paused_since.take() {
            inner.paused_total = inner.paused_total.saturating_add(started.elapsed());
        }
    }
    write_log(state, if paused { "Queue paused." } else { "Queue resumed." });
    true
}
