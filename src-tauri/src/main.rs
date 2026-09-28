#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
use objc2_app_kit::NSRunningApplication;
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::{fd::AsRawFd, unix::process::CommandExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "windows")]
use std::{
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    process::ChildStdin,
};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(any(target_os = "macos", target_os = "linux"))]
const LAUNCHER_STOP_TIMEOUT: Duration = Duration::from_secs(36);
#[cfg(any(target_os = "macos", target_os = "linux"))]
const TASKBOARD_LISTEN_FD: i32 = 5;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherSnapshot {
    phase: String,
    message: String,
    update_message: String,
    update_available: bool,
    version: String,
    app_path: Option<String>,
    child_pid: Option<u32>,
    open_signal_pid: Option<u32>,
    open_request_pending: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPidRecord {
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
}

#[derive(Deserialize)]
struct LauncherRuntimeDescriptor {
    url: String,
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct ManagedCodexProcess {
    pid: u32,
    attempt_id: String,
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowsCodexPackage {
    app_path: PathBuf,
    version: String,
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsCodexPackageOutput {
    app_path: String,
    version: String,
}

struct LauncherState {
    child: Mutex<Option<u32>>,
    snapshot: Mutex<LauncherSnapshot>,
    status_menu: Mutex<Option<MenuItem<tauri::Wry>>>,
    intentional_stop: AtomicBool,
    generation: AtomicU64,
    lifecycle: Mutex<()>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    taskboard_listener: Mutex<Option<TcpListener>>,
    #[cfg(target_os = "windows")]
    child_control: Mutex<Option<ChildStdin>>,
    #[cfg(target_os = "windows")]
    codex_package: Mutex<Option<WindowsCodexPackage>>,
    #[cfg(target_os = "windows")]
    managed_codex: Mutex<Option<ManagedCodexProcess>>,
    _instance_lock: File,
    data_directory: PathBuf,
    log_path: PathBuf,
    pid_record_path: PathBuf,
}

impl LauncherState {
    fn new(
        data_directory: PathBuf,
        log_directory: PathBuf,
        version: String,
        instance_lock: File,
    ) -> Self {
        Self {
            child: Mutex::new(None),
            snapshot: Mutex::new(LauncherSnapshot {
                phase: "starting".into(),
                message: "正在启动任务面板…".into(),
                update_message: "本地硬化版本已禁用自动更新。".into(),
                update_available: false,
                version,
                app_path: None,
                child_pid: None,
                open_signal_pid: None,
                open_request_pending: false,
            }),
            status_menu: Mutex::new(None),
            intentional_stop: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            taskboard_listener: Mutex::new(None),
            #[cfg(target_os = "windows")]
            child_control: Mutex::new(None),
            #[cfg(target_os = "windows")]
            codex_package: Mutex::new(None),
            #[cfg(target_os = "windows")]
            managed_codex: Mutex::new(None),
            _instance_lock: instance_lock,
            pid_record_path: data_directory.join("launcher-child.json"),
            data_directory,
            log_path: log_directory.join("agent-desk-launcher.log"),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn acquire_instance_lock(path: &Path) -> Result<Option<File>, std::io::Error> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(Some(file))
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
fn acquire_instance_lock(path: &Path) -> Result<Option<File>, std::io::Error> {
    match OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
    {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.raw_os_error() == Some(32) => Ok(None),
        Err(error) => Err(error),
    }
}

fn loopback_listener() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn restrict_windows_data_acl(directory: &Path) -> Result<(), std::io::Error> {
    let username = match (
        std::env::var("USERDOMAIN")
            .ok()
            .filter(|value| !value.is_empty()),
        std::env::var("USERNAME")
            .ok()
            .filter(|value| !value.is_empty()),
    ) {
        (Some(domain), Some(user)) => format!("{domain}\\{user}"),
        (None, Some(user)) => user,
        _ => {
            return Err(std::io::Error::other(
                "Cannot resolve the current Windows user",
            ))
        }
    };
    let user_grant = format!("{username}:(OI)(CI)F");
    let status = hidden_windows_command("icacls.exe")
        .arg(directory)
        .args([
            "/inheritance:r",
            "/grant:r",
            &user_grant,
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F",
            "/c",
        ])
        .status()?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| std::io::Error::other("Failed to restrict Agent Desk data ACLs"))?;
    for entry in fs::read_dir(directory)? {
        let status = hidden_windows_command("icacls.exe")
            .arg(entry?.path())
            .args(["/reset", "/t", "/c"])
            .status()?;
        if !status.success() {
            return Err(std::io::Error::other(
                "Failed to inherit Agent Desk data ACLs",
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn grant_windows_runtime_read_acl(directory: &Path) -> Result<(), std::io::Error> {
    let status = hidden_windows_command("icacls.exe")
        .arg(directory)
        .args(["/grant:r", "CodexSandboxUsers:(OI)(CI)RX", "/t", "/c"])
        .status()?;
    status.success().then_some(()).ok_or_else(|| {
        std::io::Error::other("Failed to grant Codex sandbox read access to Taskboard runtime")
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn taskboard_listener(state: &LauncherState) -> Result<(Option<i32>, u16), String> {
    let mut listener = state.taskboard_listener.lock().unwrap();
    if listener.is_none() {
        *listener = Some(loopback_listener()?);
    }
    let listener = listener.as_ref().unwrap();
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    Ok((Some(listener.as_raw_fd()), port))
}

#[cfg(target_os = "windows")]
fn taskboard_listener(_state: &LauncherState) -> Result<(Option<i32>, u16), String> {
    let listener = loopback_listener()?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    Ok((None, port))
}

fn update_snapshot(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: impl FnOnce(&mut LauncherSnapshot),
) -> LauncherSnapshot {
    let snapshot = {
        let mut snapshot = state.snapshot.lock().unwrap();
        update(&mut snapshot);
        snapshot.clone()
    };
    let status_menu = state.status_menu.lock().unwrap().clone();
    if let Some(status_menu) = status_menu {
        let status_state = Arc::clone(state);
        let _ = app.run_on_main_thread(move || {
            let status = {
                let snapshot = status_state.snapshot.lock().unwrap();
                match snapshot.phase.as_str() {
                    "running" => "运行状态：正常",
                    "error" => "运行状态：异常",
                    "stopped" => "运行状态：已停止",
                    _ => "运行状态：启动中",
                }
            };
            let _ = status_menu.set_text(status);
        });
    }
    let _ = app.emit("launcher-status", snapshot.clone());
    snapshot
}

fn append_log(state: &LauncherState, line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.log_path)
    {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        let _ = writeln!(file, "{timestamp_ms} {line}");
    }
}

#[cfg(target_os = "windows")]
fn managed_codex_spawn(line: &str) -> Option<ManagedCodexProcess> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let diagnostic = value.get("launchDiagnostic")?;
    if diagnostic.get("event")?.as_str()? != "spawn-returned" {
        return None;
    }
    let pid = u32::try_from(diagnostic.get("pid")?.as_u64()?).ok()?;
    let attempt_id = diagnostic.get("attemptId")?.as_str()?;
    Uuid::parse_str(attempt_id).ok()?;
    Some(ManagedCodexProcess {
        pid,
        attempt_id: attempt_id.to_string(),
    })
}

#[cfg(target_os = "windows")]
fn append_managed_codex_observation(
    state: &LauncherState,
    managed: &ManagedCodexProcess,
    elapsed_seconds: u32,
) {
    let running = process_group_is_running(managed.pid);
    let version = state.snapshot.lock().unwrap().version.clone();
    let at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let line = serde_json::json!({
        "launchDiagnostic": {
            "atMs": at_ms,
            "event": "managed-process-after-injector-exit",
            "attemptId": managed.attempt_id,
            "agentDeskVersion": version,
            "pid": managed.pid,
            "elapsedSeconds": elapsed_seconds,
            "running": running,
        }
    });
    let diagnostic_path = state.log_path.with_file_name("agent-desk-startup.jsonl");
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(diagnostic_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn show_error_dialog(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("关闭".into()))
        .blocking_show();
}

#[cfg(target_os = "macos")]
fn find_codex_app(home_directory: &Path) -> Option<PathBuf> {
    [
        PathBuf::from("/Applications/ChatGPT.app"),
        home_directory.join("Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
        home_directory.join("Applications/Codex.app"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_dir())
}

#[cfg(target_os = "macos")]
fn ordinary_codex_process(app_path: &Path) -> Result<Option<u32>, String> {
    let app_name = app_path
        .file_stem()
        .ok_or_else(|| "无法识别 Codex App 名称".to_string())?;
    let executable = app_path.join("Contents/MacOS").join(app_name);
    let output = StdCommand::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,command="])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查正在运行的 Codex".to_string());
    }

    let executable = executable.to_string_lossy();
    let mut ordinary_pid = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim_start();
        let Some(separator) = line.find(char::is_whitespace) else {
            continue;
        };
        let command = line[separator..].trim_start();
        if command != executable && !command.starts_with(&format!("{executable} ")) {
            continue;
        }
        ordinary_pid = line[..separator].parse().ok();
    }
    Ok(ordinary_pid)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_is_running(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(target_os = "macos")]
fn quit_codex_normally(pid: u32) -> Result<(), String> {
    let application =
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid as libc::pid_t)
            .ok_or_else(|| "无法找到正在运行的 Codex".to_string())?;
    if !application.terminate() {
        return Err("Codex 没有接受退出请求".to_string());
    }
    let deadline = Instant::now() + LAUNCHER_STOP_TIMEOUT;
    while process_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    if process_is_running(pid) {
        return Err("Codex 尚未退出，任务面板没有启动".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn hidden_windows_command(program: &str) -> StdCommand {
    let mut command = StdCommand::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(target_os = "windows")]
fn find_codex_package(hint: Option<&Path>) -> Result<WindowsCodexPackage, String> {
    let output = hidden_windows_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$script:validationFailures = @()
function Test-CodexPackage([string]$candidate, [string]$registeredRoot) {
  if ([string]::IsNullOrWhiteSpace($candidate)) { $script:validationFailures += 'emptyCandidate'; return $null }
  try {
    $candidate = [IO.Path]::GetFullPath($candidate)
    if ([IO.Path]::GetFileName($candidate) -cne 'ChatGPT.exe') { $script:validationFailures += 'fileName'; return $null }
    $appDirectory = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($candidate))
    if ($appDirectory.Name -cne 'app') { $script:validationFailures += 'appDirectory'; return $null }
    $packageRoot = $appDirectory.Parent
    if ($null -eq $packageRoot -or $packageRoot.Parent.Name -cne 'WindowsApps') { $script:validationFailures += 'windowsAppsRoot'; return $null }
    if ($packageRoot.Name -notmatch '^OpenAI\.Codex_(?<version>\d+\.\d+\.\d+\.\d+)_(?<architecture>x64|arm64)__2p2nqsd0c76g0$') { $script:validationFailures += 'packageFolder'; return $null }
    if (-not [string]::IsNullOrWhiteSpace($registeredRoot) -and
        [IO.Path]::GetFullPath($registeredRoot) -ne $packageRoot.FullName) { $script:validationFailures += 'registeredRoot'; return $null }
    $manifestPath = Join-Path $packageRoot.FullName 'AppxManifest.xml'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { $script:validationFailures += 'manifestMissing'; return $null }
    [xml]$manifest = Get-Content -Raw -LiteralPath $manifestPath
    $identity = $manifest.Package.Identity
    if ([string]$identity.Name -cne 'OpenAI.Codex' -or
        [string]$identity.Publisher -cne 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B' -or
        [string]$identity.Version -cne $Matches.version -or
        [string]$identity.ProcessorArchitecture -cne $Matches.architecture) { $script:validationFailures += 'manifestIdentity'; return $null }
    $codex = Join-Path $packageRoot.FullName 'app\resources\codex.exe'
    foreach ($file in @($candidate, $codex)) {
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $script:validationFailures += "missing:$([IO.Path]::GetFileName($file))"; return $null }
      $signatureStatus = [string](Get-AuthenticodeSignature -LiteralPath $file).Status
      if ($signatureStatus -ne 'Valid') { $script:validationFailures += "signature:$([IO.Path]::GetFileName($file)):$signatureStatus"; return $null }
    }
    return [pscustomobject]@{ appPath = $candidate; version = [string]$identity.Version }
  } catch { $script:validationFailures += "exception:$($_.Exception.GetType().Name)"; return $null }
}

$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
  Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' -and [string]$_.SignatureKind -eq 'Store' } |
  Sort-Object Version -Descending | Select-Object -First 1
$resolved = $null
if ($null -ne $package) {
  $resolved = Test-CodexPackage (Join-Path $package.InstallLocation 'app\ChatGPT.exe') $package.InstallLocation
}
if ($null -eq $resolved) {
  $processPaths = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.Path } catch { $null }
  }
  foreach ($processPath in $processPaths) {
    $resolved = Test-CodexPackage $processPath $null
    if ($null -ne $resolved) { break }
  }
}
if ($null -eq $resolved) {
  $resolved = Test-CodexPackage $env:CODEX_TASKBOARD_CODEX_APP_HINT $null
}
if ($null -eq $resolved) {
  $appxFound = $null -ne $package
  $processPathCount = @($processPaths).Count
  $hintPresent = -not [string]::IsNullOrWhiteSpace($env:CODEX_TASKBOARD_CODEX_APP_HINT)
  $failures = @($script:validationFailures | Select-Object -Unique) -join ','
  [Console]::Error.Write("appxFound=$appxFound;processPathCount=$processPathCount;hintPresent=$hintPresent;validationFailures=$failures")
  exit 2
}
[Console]::Out.Write(($resolved | ConvertTo-Json -Compress))"#,
        ])
        .env(
            "CODEX_TASKBOARD_CODEX_APP_HINT",
            hint.unwrap_or_else(|| Path::new("")),
        )
        .output()
        .map_err(|error| format!("无法启动官方 Codex 包校验：{error}"))?;
    if !output.status.success() {
        let diagnostics = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "未找到可验证的官方 Codex 包（校验退出码 {}；{}）",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".into()),
            diagnostics.trim()
        ));
    }
    let package: WindowsCodexPackageOutput = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("官方 Codex 包校验输出无效：{error}"))?;
    let app_path = PathBuf::from(package.app_path);
    if package.version.is_empty() {
        return Err("官方 Codex 包校验返回了空版本".into());
    }
    Ok(WindowsCodexPackage {
        app_path,
        version: package.version,
    })
}

#[cfg(target_os = "windows")]
fn resolve_codex_package(state: &LauncherState) -> Result<WindowsCodexPackage, String> {
    let hint = state
        .codex_package
        .lock()
        .unwrap()
        .as_ref()
        .map(|package| package.app_path.clone());
    let package = find_codex_package(hint.as_deref())?;
    *state.codex_package.lock().unwrap() = Some(package.clone());
    Ok(package)
}

#[cfg(target_os = "windows")]
fn ordinary_codex_process(app_path: &Path) -> Result<Option<u32>, String> {
    let output = hidden_windows_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop; $app = [IO.Path]::GetFullPath($env:CODEX_TASKBOARD_CODEX_APP_PATH); $name = [IO.Path]::GetFileNameWithoutExtension($app); $process = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -ne $process) { [Console]::Out.Write($process.Id) }; exit 0",
        ])
        .env("CODEX_TASKBOARD_CODEX_APP_PATH", app_path)
        .output()
        .map_err(|error| format!("无法启动 Codex 进程检查：{error}"))?;
    if !output.status.success() {
        let diagnostics = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "无法检查正在运行的 Codex（检查退出码 {}；{}）",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".into()),
            diagnostics.trim()
        ));
    }
    let pid = String::from_utf8_lossy(&output.stdout);
    let pid = pid.trim();
    if pid.is_empty() {
        return Ok(None);
    }
    pid.parse()
        .map(Some)
        .map_err(|_| "Codex 进程检查返回了无效进程编号".to_string())
}

#[cfg(target_os = "linux")]
fn find_codex_app(_home_directory: &Path) -> Option<PathBuf> {
    let candidate = PathBuf::from("/usr/lib/chatgpt/ChatGPT");
    candidate.is_file().then_some(candidate)
}

#[cfg(target_os = "linux")]
fn ordinary_codex_process(app_path: &Path) -> Result<Option<u32>, String> {
    let output = StdCommand::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,ppid=,command="])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查正在运行的 Codex".to_string());
    }

    let executable = app_path.to_string_lossy();
    let mut processes = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim_start();
        let Some(pid_separator) = line.find(char::is_whitespace) else {
            continue;
        };
        let Some(pid) = line[..pid_separator].parse::<u32>().ok() else {
            continue;
        };
        let parent_and_command = line[pid_separator..].trim_start();
        let Some(parent_separator) = parent_and_command.find(char::is_whitespace) else {
            continue;
        };
        let Some(parent_pid) = parent_and_command[..parent_separator].parse::<u32>().ok() else {
            continue;
        };
        let command = parent_and_command[parent_separator..].trim_start();
        if command != executable && !command.starts_with(&format!("{executable} ")) {
            continue;
        }
        processes.push((pid, parent_pid, command.to_string()));
    }

    Ok(processes
        .iter()
        .find(|(pid, parent_pid, command)| {
            !processes
                .iter()
                .any(|(candidate_pid, _, _)| candidate_pid == parent_pid && candidate_pid != pid)
                && !command.contains(" --remote-debugging-pipe")
        })
        .map(|(pid, _, _)| *pid))
}

#[cfg(target_os = "linux")]
fn quit_codex_normally(pid: u32) -> Result<(), String> {
    if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
        return Err("Codex 没有接受退出请求".to_string());
    }
    let deadline = Instant::now() + LAUNCHER_STOP_TIMEOUT;
    while process_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    if process_is_running(pid) {
        return Err("Codex 尚未退出，任务面板没有启动".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn missing_codex_app_message() -> String {
    "未找到官方 ChatGPT.app 或 Codex.app。请先安装到 Applications 文件夹。".to_string()
}

#[cfg(target_os = "linux")]
fn missing_codex_app_message() -> String {
    "未找到官方 ChatGPT App。请先安装 Ubuntu x64 .deb。".to_string()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn send_process_group_signal(pid: u32, signal: i32) {
    unsafe {
        if libc::kill(-(pid as i32), signal) != 0 {
            libc::kill(pid as i32, signal);
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_group_is_running(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), 0) == 0 }
}

#[cfg(target_os = "windows")]
fn process_group_is_running(pid: u32) -> bool {
    hidden_windows_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
            ),
        ])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn signal_pending_taskboard_open(state: &LauncherState) -> Result<(), String> {
    let mut snapshot = state.snapshot.lock().unwrap();
    if !snapshot.open_request_pending {
        return Ok(());
    }
    let Some(pid) = snapshot.open_signal_pid else {
        return Ok(());
    };
    if unsafe { libc::kill(pid as i32, libc::SIGUSR2) } != 0 {
        snapshot.open_signal_pid = None;
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn signal_pending_taskboard_open(state: &LauncherState) -> Result<(), String> {
    let mut snapshot = state.snapshot.lock().unwrap();
    if !snapshot.open_request_pending {
        return Ok(());
    }
    if snapshot.open_signal_pid.is_none() {
        return Ok(());
    }
    let result = state
        .child_control
        .lock()
        .unwrap()
        .as_mut()
        .ok_or_else(|| "Launcher control pipe is unavailable".to_string())
        .and_then(|control| {
            control
                .write_all(b"open\n")
                .and_then(|_| control.flush())
                .map_err(|error| error.to_string())
        });
    if result.is_err() {
        snapshot.open_signal_pid = None;
    }
    result
}

fn wait_for_process_group_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_group_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    !process_group_is_running(pid)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn terminate_process_group(pid: u32) {
    send_process_group_signal(pid, libc::SIGTERM);
    if !wait_for_process_group_exit(pid, STOP_TIMEOUT) {
        send_process_group_signal(pid, libc::SIGKILL);
        let _ = wait_for_process_group_exit(pid, Duration::from_secs(1));
    }
}

#[cfg(target_os = "windows")]
fn terminate_process_group(pid: u32) {
    if process_group_is_running(pid) {
        let _ = hidden_windows_command("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

#[cfg(target_os = "windows")]
fn terminate_process_only(pid: u32) {
    if process_group_is_running(pid) {
        let _ = hidden_windows_command("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn stop_launcher_process_group(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    if !wait_for_process_group_exit(pid, LAUNCHER_STOP_TIMEOUT) {
        send_process_group_signal(pid, libc::SIGKILL);
        let _ = wait_for_process_group_exit(pid, Duration::from_secs(1));
    }
}

#[cfg(target_os = "windows")]
fn stop_launcher_process_group(pid: u32) {
    terminate_process_group(pid);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_matches_record(record: &LauncherPidRecord) -> bool {
    let output = StdCommand::new("/bin/ps")
        .args(["-p", &record.pid.to_string(), "-o", "command="])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout);
    let command = command.trim_start();
    command.starts_with(&*record.node_path.to_string_lossy())
        && command.contains(&*record.injector_path.to_string_lossy())
}

#[cfg(target_os = "windows")]
fn process_matches_record(record: &LauncherPidRecord) -> bool {
    let output = hidden_windows_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "(Get-CimInstance Win32_Process -Filter 'ProcessId = {}').CommandLine",
                record.pid
            ),
        ])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout);
    command.contains(&*record.node_path.to_string_lossy())
        && command.contains(r"scripts\codex-injector.mjs")
}

fn recorded_child_is_running(state: &LauncherState) -> bool {
    fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok())
        .is_some_and(|record| process_matches_record(&record))
}

fn stop_recorded_child(state: &LauncherState) {
    let record = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok());
    if let Some(record) = record {
        if process_matches_record(&record) {
            stop_launcher_process_group(record.pid);
        }
    }
    let _ = fs::remove_file(&state.pid_record_path);
}

fn write_pid_record(
    state: &LauncherState,
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
) -> Result<(), String> {
    let record = LauncherPidRecord {
        pid,
        node_path,
        injector_path,
    };
    let content = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    fs::write(&state.pid_record_path, content).map_err(|error| error.to_string())
}

fn clear_pid_record(state: &LauncherState, pid: u32) {
    let matches = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok())
        .is_some_and(|record| record.pid == pid);
    if matches {
        let _ = fs::remove_file(&state.pid_record_path);
    }
}

fn stop_managed_child_locked(app: &AppHandle, state: &Arc<LauncherState>, preserve_codex: bool) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.intentional_stop.store(true, Ordering::SeqCst);
    #[cfg(target_os = "windows")]
    if let Some(mut control) = state.child_control.lock().unwrap().take() {
        let command = if preserve_codex {
            b"stop-keep-codex\n".as_slice()
        } else {
            b"stop\n".as_slice()
        };
        let _ = control.write_all(command).and_then(|_| control.flush());
    }
    if let Some(pid) = state.child.lock().unwrap().take() {
        append_log(state, &format!("Stopping launcher child {pid}"));
        #[cfg(target_os = "windows")]
        if !wait_for_process_group_exit(pid, STOP_TIMEOUT) {
            if preserve_codex {
                terminate_process_only(pid);
            } else {
                terminate_process_group(pid);
            }
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        stop_launcher_process_group(pid);
        clear_pid_record(state, pid);
    }
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "stopped".into();
        snapshot.message = "任务面板已停止。".into();
        snapshot.child_pid = None;
        snapshot.open_signal_pid = None;
    });
}

fn stop_managed_child(app: &AppHandle, state: &Arc<LauncherState>) {
    let _lifecycle = state.lifecycle.lock().unwrap();
    stop_managed_child_locked(app, state, true);
}

fn watch_launcher_output<R: std::io::Read + Send + 'static>(
    reader: R,
    is_stderr: bool,
    app: AppHandle,
    state: Arc<LauncherState>,
    pid: u32,
    generation: u64,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            append_log(&state, &line);
            #[cfg(target_os = "windows")]
            if !is_stderr && state.generation.load(Ordering::SeqCst) == generation {
                if let Some(managed) = managed_codex_spawn(&line) {
                    *state.managed_codex.lock().unwrap() = Some(managed);
                }
            }
            if is_stderr && line.contains("Waiting for Codex") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "starting".into();
                        snapshot.message = "正在等待 Codex 窗口…".into();
                    }
                });
            } else if !is_stderr && line.contains("Agent Desk listening") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "starting".into();
                        snapshot.message = "任务面板服务已启动，正在注入 Codex…".into();
                    }
                });
            } else if !is_stderr && line.contains("\"openTaskboardSignalReady\":true") {
                let snapshot = update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.open_signal_pid = Some(pid);
                    }
                });
                if snapshot.child_pid == Some(pid) && snapshot.open_signal_pid == Some(pid) {
                    if let Err(error) = signal_pending_taskboard_open(&state) {
                        append_log(&state, &format!("Taskboard open signal failed: {error}"));
                    }
                }
            } else if !is_stderr && line.contains("\"openTaskboardSignalQueued\":true") {
                let mut snapshot = state.snapshot.lock().unwrap();
                if state.generation.load(Ordering::SeqCst) == generation
                    && snapshot.child_pid == Some(pid)
                    && snapshot.open_signal_pid == Some(pid)
                {
                    snapshot.open_request_pending = false;
                }
            } else if !is_stderr && line.contains("\"openedTaskboardInExistingCodex\":true") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "running".into();
                        snapshot.message = "任务面板已在现有 Codex 的浏览面板中打开。".into();
                    }
                });
            } else if !is_stderr
                && line.contains("\"rendererInjection\":")
                && line.contains("\"injected\":true")
            {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "running".into();
                        snapshot.message = "任务面板已在 Codex 客户端中打开。".into();
                    }
                });
            } else if !is_stderr
                && line.contains("\"rendererInjection\":")
                && line.contains("\"injected\":false")
            {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                        && snapshot.phase != "running"
                    {
                        snapshot.phase = "starting".into();
                        snapshot.message = "Codex 已启动，工作台尚未通过侧栏兼容检查。".into();
                    }
                });
            } else if !is_stderr
                && line.contains("\"rendererDiscovery\":")
                && line.contains("\"eligible\":0")
            {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                        && snapshot.phase != "running"
                    {
                        snapshot.phase = "starting".into();
                        snapshot.message = "Codex 已启动，正在寻找可用的主界面…".into();
                    }
                });
            } else if !is_stderr && line.contains("\"rendererReloadRejected\":true") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "error".into();
                        snapshot.message =
                            "Codex 界面变化后未通过兼容检查；工作台已停止注入。".into();
                    }
                });
            } else if !is_stderr && line.contains("\"event\":\"renderer-timeout\"") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "error".into();
                        snapshot.message =
                            "Codex 未提供可用主界面，已停止等待。详情见启动诊断日志。".into();
                    }
                });
            } else if !is_stderr && line.contains("\"event\":\"startup-failed\"") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "error".into();
                        snapshot.message =
                            "Codex 未完成启动，Agent Desk 已停止自动重试。请查看官方错误提示。"
                                .into();
                    }
                });
            }
        }
    });
}

fn start_launcher_locked(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<LauncherSnapshot, String> {
    if state.child.lock().unwrap().is_some() {
        return Ok(state.snapshot.lock().unwrap().clone());
    }

    #[cfg(target_os = "windows")]
    let codex_package = resolve_codex_package(state)?;
    #[cfg(target_os = "windows")]
    let codex_app = codex_package.app_path;
    #[cfg(target_os = "windows")]
    let codex_package_version = codex_package.version;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let home_directory = app.path().home_dir().map_err(|error| error.to_string())?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let codex_app = find_codex_app(&home_directory).ok_or_else(missing_codex_app_message)?;
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let app_root = resource_directory.join("app");
    let injector_path = app_root.join("scripts/codex-injector.mjs");
    let node_path = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or_else(|| "无法定位 App 可执行文件目录".to_string())?
        .join(if cfg!(target_os = "windows") {
            "node.exe"
        } else if cfg!(target_os = "linux") {
            "codex-taskboard-node"
        } else {
            "node"
        });
    #[cfg(target_os = "macos")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app)?;
    #[cfg(target_os = "windows")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app)?;
    #[cfg(target_os = "linux")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app)?;
    if let Some(codex_pid) = ordinary_codex_pid {
        let stale_managed_session = recorded_child_is_running(state);
        if !stale_managed_session {
            app
                .dialog()
                .message("Codex 已经由其他方式启动。请先在 Codex 中正常退出，然后从托盘菜单选择“重新打开 Codex”。Agent Desk 不会终止或附加到现有进程。")
                .title("Agent Desk")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::Ok)
                .blocking_show();
        }
        append_log(
            state,
            &format!(
                "Refused to attach to running Codex PID {codex_pid}; stale managed session: {stale_managed_session}"
            ),
        );
        return Ok(update_snapshot(app, state, |snapshot| {
            snapshot.phase = "stopped".into();
            snapshot.message = if stale_managed_session {
                "升级已安装；请正常退出当前 Codex，再从托盘重新打开。".into()
            } else {
                "请正常退出现有 Codex，再从托盘重新打开。".into()
            };
            snapshot.app_path = Some(codex_app.display().to_string());
            snapshot.open_signal_pid = None;
            snapshot.open_request_pending = false;
        }));
    }
    stop_recorded_child(state);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.intentional_stop.store(false, Ordering::SeqCst);
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "正在启动任务面板服务…".into();
        snapshot.app_path = Some(codex_app.display().to_string());
        snapshot.open_signal_pid = None;
    });

    #[cfg(target_os = "macos")]
    let path_value = format!(
        "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        resource_directory.join("bin").display()
    );
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let path_value = {
        let current_path = std::env::var_os("PATH").unwrap_or_default();
        std::env::join_paths(
            std::iter::once(resource_directory.join("bin"))
                .chain(std::env::split_paths(&current_path)),
        )
        .map_err(|error| error.to_string())?
    };
    let (_taskboard_listener_fd, taskboard_port) = taskboard_listener(state)?;
    let instance_token = Uuid::new_v4().to_string();
    let instance_secret = Uuid::new_v4().to_string();
    let version = state.snapshot.lock().unwrap().version.clone();
    let manage_taskboard_skill_path = app_root.join("skills/manage-taskboard/SKILL.md");
    let mut command = StdCommand::new(&node_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    command.arg(&injector_path);
    #[cfg(target_os = "windows")]
    command.arg(r"scripts\codex-injector.mjs");
    #[cfg(target_os = "windows")]
    command.args(["--launch", "--watch", "--open", "--windows-registered"]);
    #[cfg(not(target_os = "windows"))]
    command.args(["--launch", "--watch", "--open", "--cdp-pipe"]);
    command
        .args(["--startup-token", &instance_token, "--app-path"])
        .arg(&codex_app)
        .env("CODEX_TASKBOARD_DATA_DIR", &state.data_directory)
        .env(
            "CODEX_TASKBOARD_RUNTIME_FILE",
            state
                .data_directory
                .parent()
                .unwrap_or(&state.data_directory)
                .join("runtime/launcher-runtime.json"),
        )
        .env("CODEX_TASKBOARD_HOST", "127.0.0.1")
        .env("CODEX_TASKBOARD_PORT", taskboard_port.to_string())
        .env("CODEX_TASKBOARD_INSTANCE_TOKEN", &instance_token)
        .env("CODEX_TASKBOARD_INSTANCE_SECRET", &instance_secret)
        .env("CODEX_TASKBOARD_VERSION", &version);
    #[cfg(target_os = "windows")]
    command
        .env("CODEX_TASKBOARD_CODEX_VERSION", &codex_package_version)
        .env("AGENT_DESK_WINDOWS_TRANSPORT", "registered-loopback")
        .env_remove("AGENT_DESK_LOOPBACK_CANDIDATE");
    command
        .env("CODEX_TASKBOARD_SKILL_PATH", &manage_taskboard_skill_path)
        .env_remove("CODEX_API_KEY")
        .env_remove("CODEX_TASKBOARD_CODEX_PROFILE")
        .env_remove("CODEX_TASKBOARD_CODEX_SOURCE_PROFILE")
        .env("HOST", "127.0.0.1")
        .env("PATH", path_value)
        .current_dir(&app_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.stdin(Stdio::piped());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    unsafe {
        let taskboard_listener_fd = _taskboard_listener_fd.unwrap();
        command
            .env("CODEX_TASKBOARD_LISTEN_FD", TASKBOARD_LISTEN_FD.to_string())
            .process_group(0);
        command.pre_exec(move || {
            if libc::dup2(taskboard_listener_fd, TASKBOARD_LISTEN_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(TASKBOARD_LISTEN_FD, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    #[cfg(target_os = "windows")]
    {
        *state.managed_codex.lock().unwrap() = None;
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    #[cfg(target_os = "windows")]
    let child_control = child.stdin.take();
    if let Err(error) = write_pid_record(state, pid, node_path, injector_path) {
        terminate_process_group(pid);
        let _ = child.wait();
        return Err(error);
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(pid);
    #[cfg(target_os = "windows")]
    {
        *state.child_control.lock().unwrap() = child_control;
    }
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.child_pid = Some(pid);
    });
    append_log(
        state,
        &format!(
            "Started launcher child {pid} on Taskboard {taskboard_port} using a validated Codex debug transport"
        ),
    );
    if let Some(stdout) = stdout {
        watch_launcher_output(stdout, false, app.clone(), state.clone(), pid, generation);
    }
    if let Some(stderr) = stderr {
        watch_launcher_output(stderr, true, app.clone(), state.clone(), pid, generation);
    }

    let event_app = app.clone();
    let event_state = state.clone();
    thread::spawn(move || {
        let status = child.wait();
        let recovery_token = {
            let mut current_child = event_state.child.lock().unwrap();
            if *current_child != Some(pid) {
                None
            } else {
                let recovery_token = generation + 1;
                if event_state
                    .generation
                    .compare_exchange(
                        generation,
                        recovery_token,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    *current_child = None;
                    Some(recovery_token)
                } else {
                    None
                }
            }
        };
        #[cfg(target_os = "windows")]
        if recovery_token.is_some() {
            let _ = event_state.child_control.lock().unwrap().take();
        }
        let Some(recovery_token) = recovery_token else {
            append_log(
                &event_state,
                &format!("Launcher child {pid} exited: {status:?}"),
            );
            terminate_process_group(pid);
            return;
        };
        let intentional = event_state.intentional_stop.load(Ordering::SeqCst);
        let failed = !status.as_ref().is_ok_and(|exit| exit.success());
        #[cfg(target_os = "windows")]
        let managed_codex = event_state.managed_codex.lock().unwrap().take();
        update_snapshot(&event_app, &event_state, |snapshot| {
            if event_state.generation.load(Ordering::SeqCst) == recovery_token
                && snapshot.child_pid == Some(pid)
            {
                snapshot.child_pid = None;
                snapshot.open_signal_pid = None;
                if !intentional {
                    let had_specific_error = snapshot.phase == "error";
                    snapshot.phase = if failed { "error" } else { "stopped" }.into();
                    snapshot.message = if failed && had_specific_error {
                        snapshot.message.clone()
                    } else if failed {
                        "Codex 调试连接中断，已停止自动重试。请正常退出 Codex 后从托盘重新打开。"
                            .into()
                    } else {
                        "Codex 已正常退出；从托盘重新打开时将重新验证当前安装版本。".into()
                    };
                }
            }
        });
        append_log(
            &event_state,
            &format!("Launcher child {pid} exited: {status:?}"),
        );
        terminate_process_group(pid);
        clear_pid_record(&event_state, pid);
        #[cfg(target_os = "windows")]
        if failed && !intentional {
            if let Some(managed) = managed_codex {
                append_managed_codex_observation(&event_state, &managed, 0);
                let observation_state = event_state.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(2));
                    append_managed_codex_observation(&observation_state, &managed, 2);
                    thread::sleep(Duration::from_secs(3));
                    append_managed_codex_observation(&observation_state, &managed, 5);
                });
            }
        }
        if intentional || failed {
            return;
        }
        // A normal Codex exit stays stopped. A manual tray restart resolves the
        // current registered package and validates its renderer again.
    });
    Ok(snapshot)
}

fn start_launcher(app: &AppHandle, state: &Arc<LauncherState>) -> Result<LauncherSnapshot, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.intentional_stop.load(Ordering::SeqCst) {
        return Ok(state.snapshot.lock().unwrap().clone());
    }
    start_launcher_locked(app, state)
}

fn restart_launcher(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<LauncherSnapshot, String> {
    let (result, result_generation) = {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state.intentional_stop.load(Ordering::SeqCst) {
            return Ok(state.snapshot.lock().unwrap().clone());
        }
        stop_managed_child_locked(app, state, false);
        let result = start_launcher_locked(app, state);
        state.intentional_stop.store(false, Ordering::SeqCst);
        let generation = state.generation.load(Ordering::SeqCst);
        (result, generation)
    };
    if let Err(error) = &result {
        let error = error.clone();
        update_snapshot(app, state, |snapshot| {
            if state.generation.load(Ordering::SeqCst) == result_generation
                && snapshot.child_pid.is_none()
            {
                snapshot.phase = "error".into();
                snapshot.message = format!("任务面板启动失败：{error}");
                snapshot.open_signal_pid = None;
            }
        });
    }
    result
}

fn open_taskboard(state: &LauncherState) -> Result<(), String> {
    state.snapshot.lock().unwrap().open_request_pending = true;
    signal_pending_taskboard_open(state)
}

fn open_taskboard_in_browser(state: &LauncherState) -> Result<(), String> {
    let descriptor = fs::read_to_string(
        state
            .data_directory
            .parent()
            .unwrap_or(&state.data_directory)
            .join("runtime/launcher-runtime.json"),
    )
    .map_err(|error| error.to_string())?;
    let descriptor: LauncherRuntimeDescriptor =
        serde_json::from_str(&descriptor).map_err(|error| error.to_string())?;
    let url = format!("{}/", descriptor.url.trim_end_matches('/'));
    #[cfg(target_os = "macos")]
    let status = StdCommand::new("/usr/bin/open")
        .arg(&url)
        .status()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    let status = hidden_windows_command("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .status()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    let status = StdCommand::new("xdg-open")
        .arg(&url)
        .status()
        .map_err(|error| error.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "系统默认浏览器没有打开任务面板".to_string())
}

// Data compatibility is intentional: never silently fork an existing user's store.
fn select_data_root(
    base: &Path,
    current_exists: bool,
    legacy_exists: bool,
) -> std::io::Result<PathBuf> {
    if current_exists && legacy_exists {
        return Err(std::io::Error::other("Both AgentDesk and DashiTaskboard data roots exist; resolve the conflict before starting Agent Desk"));
    }
    Ok(base.join(if legacy_exists {
        "DashiTaskboard"
    } else {
        "AgentDesk"
    }))
}
#[cfg(target_os = "windows")]
fn resolve_data_root(base: &Path) -> std::io::Result<PathBuf> {
    select_data_root(
        base,
        base.join("AgentDesk").try_exists()?,
        base.join("DashiTaskboard").try_exists()?,
    )
}
#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn data_root_preserves_legacy_and_rejects_ambiguous_stores() {
        let base = Path::new("fixture");
        assert_eq!(
            select_data_root(base, false, false).unwrap(),
            base.join("AgentDesk")
        );
        assert_eq!(
            select_data_root(base, true, false).unwrap(),
            base.join("AgentDesk")
        );
        assert_eq!(
            select_data_root(base, false, true).unwrap(),
            base.join("DashiTaskboard")
        );
        assert!(select_data_root(base, true, true).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn managed_codex_pid_uses_only_bounded_spawn_diagnostics() {
        let attempt = "f1ed7d9f-cfa5-4e47-b760-d4352398218c";
        let line = format!(
            "{{\"launchDiagnostic\":{{\"event\":\"spawn-returned\",\"pid\":31824,\"attemptId\":\"{attempt}\"}}}}"
        );
        let managed = managed_codex_spawn(&line).unwrap();
        assert_eq!(managed.pid, 31824);
        assert_eq!(managed.attempt_id, attempt);
        assert!(managed_codex_spawn(&line.replace("spawn-returned", "renderer-timeout")).is_none());
        assert!(managed_codex_spawn(&line.replace(attempt, "not-a-uuid")).is_none());
        assert!(managed_codex_spawn("not json").is_none());
    }
}

fn main() {
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            let home_directory = app.path().home_dir()?;
            #[cfg(target_os = "macos")]
            let data_directory = home_directory.join("Library/Application Support/Agent Desk");
            #[cfg(target_os = "macos")]
            let log_directory = home_directory.join("Library/Logs/Agent Desk");
            #[cfg(target_os = "windows")]
            let data_root = resolve_data_root(
                &std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .ok_or_else(|| std::io::Error::other("LOCALAPPDATA is unavailable"))?,
            )?;
            #[cfg(target_os = "windows")]
            let data_directory = data_root.join("data");
            #[cfg(target_os = "windows")]
            let log_directory = data_root.join("logs");
            #[cfg(target_os = "windows")]
            let runtime_directory = data_root.join("runtime");
            #[cfg(target_os = "linux")]
            let data_directory = std::env::var_os("XDG_DATA_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home_directory.join(".local/share"))
                .join("Agent Desk");
            #[cfg(target_os = "linux")]
            let log_directory = std::env::var_os("XDG_STATE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home_directory.join(".local/state"))
                .join("Agent Desk");
            fs::create_dir_all(&data_directory)?;
            fs::create_dir_all(&log_directory)?;
            #[cfg(target_os = "windows")]
            fs::create_dir_all(&runtime_directory)?;
            #[cfg(target_os = "windows")]
            restrict_windows_data_acl(&data_root)?;
            #[cfg(target_os = "windows")]
            grant_windows_runtime_read_acl(&runtime_directory)?;
            let Some(instance_lock) = acquire_instance_lock(&data_directory.join("launcher.lock"))?
            else {
                app.handle().exit(0);
                return Ok(());
            };
            let version = app.package_info().version.to_string();
            let state = Arc::new(LauncherState::new(
                data_directory,
                log_directory,
                version.clone(),
                instance_lock,
            ));
            app.manage(state.clone());

            let app_info = MenuItem::with_id(
                app,
                "app-info",
                format!("Agent Desk - {version}"),
                false,
                None::<&str>,
            )?;
            let launcher_status = MenuItem::with_id(
                app,
                "launcher-status",
                "运行状态：启动中",
                false,
                None::<&str>,
            )?;
            *state.status_menu.lock().unwrap() = Some(launcher_status.clone());
            let open_taskboard_item = MenuItem::with_id(
                app,
                "open-taskboard",
                "打开智能体工作台",
                true,
                None::<&str>,
            )?;
            let open_taskboard_web = MenuItem::with_id(
                app,
                "open-taskboard-web",
                "在网页打开智能体工作台",
                true,
                None::<&str>,
            )?;
            let restart_codex =
                MenuItem::with_id(app, "restart-codex", "重新打开 Codex", true, None::<&str>)?;
            let autolaunch = app.autolaunch();
            let autostart_enabled = autolaunch.is_enabled()?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "开机自启动",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &app_info,
                    &launcher_status,
                    &open_taskboard_item,
                    &open_taskboard_web,
                    &restart_codex,
                    &autostart,
                    &quit,
                ],
            )?;
            let autostart_menu = autostart.clone();
            let autostart_confirmed = Arc::new(AtomicBool::new(autostart_enabled));
            TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/agent-desk.png"))
                .icon_as_template(true)
                .tooltip("Agent Desk · 智能体工作台")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open-taskboard" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = open_taskboard(&state) {
                                append_log(&state, &format!("Launcher menu open failed: {error}"));
                                show_error_dialog(
                                    &app,
                                    "Agent Desk 打开失败",
                                    &format!("{error}\n\n请确认 Codex 正在运行。"),
                                );
                            }
                        });
                    }
                    "open-taskboard-web" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = open_taskboard_in_browser(&state) {
                                append_log(
                                    &state,
                                    &format!("Launcher menu browser open failed: {error}"),
                                );
                                show_error_dialog(&app, "Agent Desk 网页打开失败", &error);
                            }
                        });
                    }
                    "restart-codex" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = restart_launcher(&app, &state) {
                                append_log(
                                    &state,
                                    &format!("Launcher menu restart failed: {error}"),
                                );
                                show_error_dialog(
                                    &app,
                                    "Agent Desk 启动失败",
                                    &format!("{error}\n\n请确认官方 Codex/ChatGPT App 已安装。"),
                                );
                            }
                        });
                    }
                    "autostart" => {
                        let manager = app.autolaunch();
                        let previous = autostart_confirmed.load(Ordering::SeqCst);
                        let mut confirmed_before = previous;
                        let operation_error = match manager.is_enabled() {
                            Ok(enabled) => {
                                confirmed_before = enabled;
                                autostart_confirmed.store(enabled, Ordering::SeqCst);
                                let result = if enabled {
                                    manager.disable()
                                } else {
                                    manager.enable()
                                };
                                result.err().map(|error| error.to_string())
                            }
                            Err(error) => Some(error.to_string()),
                        };
                        let sync_error = match manager.is_enabled() {
                            Ok(enabled) => {
                                autostart_confirmed.store(enabled, Ordering::SeqCst);
                                autostart_menu.set_checked(enabled).unwrap();
                                None
                            }
                            Err(error) => {
                                autostart_menu.set_checked(confirmed_before).unwrap();
                                autostart_confirmed.store(confirmed_before, Ordering::SeqCst);
                                Some(error.to_string())
                            }
                        };
                        if let Some(error) = operation_error.or(sync_error) {
                            show_error_dialog(app, "Agent Desk 自启动设置失败", &error);
                        }
                    }
                    "quit" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let lifecycle = state.lifecycle.lock().unwrap();
                        stop_managed_child_locked(app, &state, true);
                        drop(lifecycle);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_launcher(&app_handle, &state) {
                    append_log(&state, &format!("Launcher startup failed: {error}"));
                    update_snapshot(&app_handle, &state, |snapshot| {
                        snapshot.phase = "error".into();
                        snapshot.message = error.clone();
                    });
                    show_error_dialog(
                        &app_handle,
                        "Agent Desk 启动失败",
                        &format!(
                            "{error}\n\n请确认官方 Codex/ChatGPT App 已安装。详情见启动日志。"
                        ),
                    );
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Agent Desk");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let Some(state) = app_handle.try_state::<Arc<LauncherState>>() else {
                return;
            };
            let result = start_launcher(app_handle, &state).and_then(|_| open_taskboard(&state));
            if let Err(error) = result {
                append_log(&state, &format!("Launcher panel reopen failed: {error}"));
                show_error_dialog(
                    app_handle,
                    "Agent Desk 打开失败",
                    &format!("{error}\n\n请确认官方 Codex/ChatGPT App 已安装。"),
                );
            }
        }
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if let Some(state) = app_handle.try_state::<Arc<LauncherState>>() {
                let _lifecycle = state.lifecycle.lock().unwrap();
                let _ = (code, api);
                stop_managed_child_locked(app_handle, &state, true);
            }
        }
        tauri::RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<Arc<LauncherState>>() {
                stop_managed_child(app_handle, &state);
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                unsafe {
                    libc::flock(state._instance_lock.as_raw_fd(), libc::LOCK_UN);
                }
            }
        }
        _ => {}
    });
}
