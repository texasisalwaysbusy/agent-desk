import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launcherSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const injectorSource = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const appServerSource = await readFile(new URL("../server/codex-app-server.mjs", import.meta.url), "utf8");
const prepareSource = await readFile(new URL("../scripts/prepare-tauri-app.mjs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const checkWorkflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");

test("the launcher uses one instance, serialized lifecycle changes, and a loopback-only service", () => {
  assert.match(launcherSource, /lifecycle: Mutex/);
  assert.match(launcherSource, /generation: AtomicU64/);
  assert.match(launcherSource, /TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/);
  assert.equal(launcherSource.match(/TcpListener::bind/g)?.length, 1);
  assert.match(launcherSource, /command\.args\(\["--launch", "--watch", "--open", "--cdp-pipe"\]\)/);
  assert.doesNotMatch(launcherSource, /remote-debugging-port|user-data-dir|tauri_plugin_updater/);
  assert.doesNotMatch(injectorSource, /remote-debugging-port|user-data-dir|WebSocket\s*\(/);
  assert.match(injectorSource, /\["--remote-debugging-pipe"\]/);
  assert.match(launcherSource, /for entry in fs::read_dir\(directory\)\?/);
  assert.match(launcherSource, /\.args\(\["\/reset", "\/t", "\/c"\]\)/);
});

test("only the runtime descriptor is readable by Codex sandbox processes", () => {
  const dataAclStart = launcherSource.indexOf("fn restrict_windows_data_acl");
  const runtimeAclStart = launcherSource.indexOf("fn grant_windows_runtime_read_acl");
  const listenerStart = launcherSource.indexOf("fn taskboard_listener", runtimeAclStart);
  const runtimeAclSource = launcherSource.slice(runtimeAclStart, listenerStart);
  const setupDataAcl = launcherSource.indexOf("restrict_windows_data_acl(&data_root)?");
  const setupRuntimeAcl = launcherSource.indexOf(
    "grant_windows_runtime_read_acl(&runtime_directory)?",
  );

  assert.ok(dataAclStart >= 0);
  assert.ok(runtimeAclStart > dataAclStart);
  assert.match(runtimeAclSource, /CodexSandboxUsers:\(OI\)\(CI\)RX/);
  assert.doesNotMatch(runtimeAclSource, /CodexSandboxUsers:[^\n]*F/);
  assert.match(launcherSource, /let runtime_directory = data_root\.join\("runtime"\)/);
  assert.ok(setupDataAcl >= 0);
  assert.ok(setupRuntimeAcl > setupDataAcl);
});

test("quitting Taskboard detaches cleanly and preserves the managed Codex process", () => {
  assert.match(launcherSource, /b"stop-keep-codex\\n"/);
  assert.match(launcherSource, /terminate_process_only\(pid\)/);
  assert.doesNotMatch(launcherSource, /无法保证在卸载注入后继续保持同一进程/);
  assert.match(injectorSource, /else if \(line\.trim\(\) === "stop-keep-codex"\)/);
  assert.match(injectorSource, /codexPreservedOnExit: true/);
  assert.match(injectorSource, /cleanup\(\{ preserveCodex: preserveCodexOnStop \}\)/);
});

test("Windows launcher and managed children do not expose a console window", () => {
  assert.match(launcherSource, /const CREATE_NO_WINDOW: u32 = 0x08000000/);
  assert.match(launcherSource, /fn hidden_windows_command\(program: &str\) -> StdCommand/);
  assert.match(launcherSource, /command\.creation_flags\(CREATE_NO_WINDOW\)/);
  assert.match(injectorSource, /startTaskboard[\s\S]*?windowsHide: process\.platform === "win32"/);
  assert.match(injectorSource, /launchCodexWithPipe[\s\S]*?windowsHide: process\.platform === "win32"/);
  assert.match(appServerSource, /windowsHide: process\.platform === "win32"/);
});

test("startup never kills a stale launcher tree before protecting a running Codex", () => {
  const runningCodexCheck = launcherSource.indexOf("let ordinary_codex_pid = ordinary_codex_process");
  const runningCodexGuard = launcherSource.indexOf("if let Some(codex_pid) = ordinary_codex_pid", runningCodexCheck);
  const staleChildCleanup = launcherSource.indexOf("stop_recorded_child(state);", runningCodexGuard);
  assert.ok(runningCodexCheck >= 0);
  assert.ok(runningCodexGuard > runningCodexCheck);
  assert.ok(staleChildCleanup > runningCodexGuard);
  assert.match(launcherSource, /let stale_managed_session = recorded_child_is_running\(state\)/);
  assert.match(launcherSource, /if !stale_managed_session \{[\s\S]*?\.dialog\(\)/);
  assert.match(launcherSource, /升级已安装；请正常退出当前 Codex，再从托盘重新打开。/);
});

test("Windows Codex discovery keeps package identity and signature checks when AppX lookup is unavailable", () => {
  assert.match(launcherSource, /PackageFamilyName -eq 'OpenAI\.Codex_2p2nqsd0c76g0'/);
  assert.match(launcherSource, /SignatureKind -eq 'Store'/);
  assert.match(launcherSource, /AppxManifest\.xml/);
  assert.match(launcherSource, /Publisher -cne 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'/);
  assert.match(launcherSource, /Get-AuthenticodeSignature -LiteralPath \$file/);
  assert.match(launcherSource, /\$PSHOME 'Modules\\Microsoft\.PowerShell\.Security\\Microsoft\.PowerShell\.Security\.psd1'/);
  assert.match(launcherSource, /Get-Process -Name ChatGPT/);
  assert.match(launcherSource, /CODEX_TASKBOARD_CODEX_APP_HINT/);
  assert.match(launcherSource, /appxFound=\$appxFound;processPathCount=\$processPathCount;hintPresent=\$hintPresent/);
  assert.match(launcherSource, /validationFailures=\$failures/);
  assert.match(launcherSource, /未找到可验证的官方 Codex 包（校验退出码/);
  assert.doesNotMatch(launcherSource, /Get-CimInstance Win32_Process -Filter \\\"Name/);
  assert.doesNotMatch(launcherSource, /package\.version\.is_empty\(\) \|\| !app_path\.is_file\(\)/);
  assert.match(launcherSource, /Get-Process -Name \$name -ErrorAction SilentlyContinue \| Select-Object -First 1/);
  assert.match(launcherSource, /Import-Module -Name \(Join-Path \$PSHOME/);
  assert.match(launcherSource, /Microsoft\.PowerShell\.Management\.psd1/);
  assert.match(
    launcherSource,
    /if \(\$null -ne \$process\) \{ \[Console\]::Out\.Write\(\$process\.Id\) \}; exit 0/,
  );
  assert.match(launcherSource, /无法检查正在运行的 Codex（检查退出码/);
});

test("automatic updates are absent from the hardened launcher", () => {
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, false);
  assert.doesNotMatch(launcherSource, /UpdaterExt|check_for_startup_update|download_update|install_update/);
  assert.match(launcherSource, /本地硬化版本已禁用自动更新/);
});

test("Windows CI runs the Node suite and builds an unsigned NSIS installer", () => {
  assert.match(
    checkWorkflow,
    /windows-launcher:[\s\S]*?run: npm test[\s\S]*?run: npm run app:build:windows/,
  );
  assert.match(
    checkWorkflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
  );
});

test("the packaged launcher includes every local renderer compatibility module", () => {
  assert.match(injectorSource, /from "\.\/codex-renderer-compatibility\.mjs"/);
  assert.match(prepareSource, /"codex-renderer-compatibility\.mjs"/);
});

test("the Windows installer is current-user and never claims release signing", async () => {
  const windowsConfig = JSON.parse(
    await readFile(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"),
  );
  assert.equal(windowsConfig.bundle.windows.nsis.installMode, "currentUser");
  assert.doesNotMatch(launcherSource, /if \(!autolaunch\.is_enabled\(\)\)/);
  assert.match(launcherSource, /"autostart" =>/);
});
