#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolvePort } from "../server/app.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { managedCodexExitAction } from "../shared/codex-startup-state.mjs";
import {
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
  taskboardAutomationPolicyOperation,
} from "../shared/taskboard-automation.mjs";
import {
  createHostHeartbeatPump,
  handleHostBindingPayload,
  reconcileInjectionRuntime,
} from "./codex-injector-runtime.mjs";
import {
  evaluateCodexRateLimits,
  normalizeCodexRateLimitsForDisplay,
} from "./codex-rate-limits.mjs";
import {
  classifyWindowsCodexCompatibility,
  guardRendererInjectionSource,
  minimumWindowsCodexVersion,
  probeRendererContract,
} from "./codex-renderer-compatibility.mjs";
import { createTaskboardSupervisor } from "./taskboard-supervisor.mjs";
import { CdpPipeBrowser } from "./codex-cdp-pipe.mjs";
import { RendererRejectionCache } from "./codex-renderer-rejections.mjs";
import {
  normalizeSidebarDiagnostic,
  sidebarDiagnosticExpression,
} from "./codex-sidebar-diagnostic.mjs";
import {
  activateRegisteredCodex,
  createLoopbackCandidateRuntime,
  reserveLoopbackPort,
  watchRegisteredProcess,
} from "./codex-cdp-loopback-candidate.mjs";
import { readNativeModelCatalog } from "./codex-model-catalog.mjs";
import { createApprovalAdapter } from "./handoff-approval.mjs";
import { createQuotaObserver } from "./codex-quota-observer.mjs";
import { createQuotaTraceBudget, sanitizeQuotaTrace } from "../shared/quota-trace.mjs";
import { createWorkbenchTraceBudget, sanitizeWorkbenchTrace } from "../shared/workbench-trace.mjs";

const injectorPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(injectorPath), "..");
const injectionPath = path.join(projectRoot, "inject", "codex-taskboard.user.js");
const quotaDisplayPath = path.join(projectRoot, "inject", "codex-quota-display.user.js");
const taskboardDataDirectory = process.env.CODEX_TASKBOARD_DATA_DIR
  ? path.resolve(process.env.CODEX_TASKBOARD_DATA_DIR)
  : path.join(projectRoot, ".data");
const startupDiagnosticPath = process.env.CODEX_TASKBOARD_DATA_DIR
  ? path.join(path.dirname(taskboardDataDirectory), "logs", "agent-desk-startup.jsonl")
  : null;
const taskboardRuntimeFile = process.env.CODEX_TASKBOARD_RUNTIME_FILE
  ? path.resolve(process.env.CODEX_TASKBOARD_RUNTIME_FILE)
  : path.join(taskboardDataDirectory, "launcher-runtime.json");
const handoffApproval = createApprovalAdapter(path.join(taskboardDataDirectory, "handoff-bridge.json"));
const taskboardListenFd = process.env.CODEX_TASKBOARD_LISTEN_FD === undefined
  ? null
  : Number(process.env.CODEX_TASKBOARD_LISTEN_FD);
if (taskboardListenFd !== null && (
  !Number.isInteger(taskboardListenFd)
  || taskboardListenFd < 3
  || taskboardListenFd > 255
)) {
  throw new Error("CODEX_TASKBOARD_LISTEN_FD must be an inherited file descriptor");
}
const automationPoliciesPath = path.join(
  taskboardDataDirectory,
  "codex-automation-policies.json",
);
const taskboardInstanceToken = (
  process.env.CODEX_TASKBOARD_INSTANCE_TOKEN?.trim() || randomUUID()
);
process.env.CODEX_TASKBOARD_INSTANCE_TOKEN = taskboardInstanceToken;
const taskboardInstanceSecret = (
  process.env.CODEX_TASKBOARD_INSTANCE_SECRET?.trim() || randomBytes(32).toString("hex")
);
process.env.CODEX_TASKBOARD_INSTANCE_SECRET = taskboardInstanceSecret;
const taskboardVersion = process.env.CODEX_TASKBOARD_VERSION?.trim() || "development";
process.env.CODEX_TASKBOARD_VERSION = taskboardVersion;
const codexPackageVersion = process.env.CODEX_TASKBOARD_CODEX_VERSION?.trim() || "unknown";
const rendererDiscoveryTimeoutMs = 75_000;
let startupAttemptId = null;
let rendererOrdinal = 0;
let emitQuotaTrace = createQuotaTraceBudget((trace) => logLaunchDiagnostic("quota-trace", { trace }));
let emitWorkbenchTrace = createWorkbenchTraceBudget((trace) => logLaunchDiagnostic("workbench-trace", { trace }));
const codexCompatibility = classifyWindowsCodexCompatibility({
  platform: process.platform,
  version: codexPackageVersion,
});
function logLaunchDiagnostic(event, details = {}) {
  if (![
    "spawn-started", "spawn-returned", "codex-exited", "cdp-output-ended",
    "cdp-handshake", "cdp-ready", "renderer-discovery", "renderer-waiting",
    "renderer-probe-start", "renderer-contract", "renderer-timeout",
    "injection-result", "startup-failed",
    "activation-started", "activation-ready",
    "activation-refused", "activation-failed", "codex-exit-unobserved", "codex-observation-stopping",
    "quota-trace",
    "workbench-trace",
    "workbench-health",
    "frame-bootstrap", "process-observation", "renderer-discovery-health",
  ].includes(event)) return;
  const line = JSON.stringify({
    launchDiagnostic: {
      at: new Date().toISOString(),
      event,
      ...(["ready", "timeout", "invalidated", "contract-refused", "frame-refused", "failed", "busy"].includes(details.bootstrap)
        ? { bootstrap: details.bootstrap } : {}),
      ...(["timeout", "recovered", "failed"].includes(details.observation)
        ? { observation: details.observation } : {}),
      ...(Number.isInteger(details.observationFailures) && details.observationFailures >= 0 && details.observationFailures <= 3
        ? { observationFailures: details.observationFailures } : {}),
      ...(Number.isInteger(details.discoveryFailures) && details.discoveryFailures >= 0 && details.discoveryFailures <= 6
        ? { discoveryFailures: details.discoveryFailures } : {}),
      ...(Number.isInteger(details.elapsedMs) && details.elapsedMs >= 0 && details.elapsedMs <= 30_000
        ? { elapsedMs: details.elapsedMs } : {}),
      ...(event === "quota-trace" ? { trace: sanitizeQuotaTrace(details.trace) } : {}),
      ...(event === "workbench-trace" ? { trace: sanitizeWorkbenchTrace(details.trace) } : {}),
      ...(event === "workbench-health" && ["ready", "loading", "error", "inactive"].includes(details.health)
        ? { health: details.health } : {}),
      ...(Number.isSafeInteger(details.renderer) && details.renderer > 0 && details.renderer <= 1000000
        ? { renderer: details.renderer } : {}),
      ...(startupAttemptId ? { attemptId: startupAttemptId } : {}),
      agentDeskVersion: taskboardVersion,
      codexVersion: codexPackageVersion,
      ...(Number.isInteger(details.pid) ? { pid: details.pid } : {}),
      ...(["selection", "package", "activation-preparation", "activation-call", "process-validation", "listener-validation"].includes(details.activationStage)
        ? { activationStage: details.activationStage } : {}),
      ...(["codex-running", "mode-not-selected", "invalid-port", "package-not-found", "manifest-missing",
        "package-identity-mismatch", "signature-invalid", "port-taken", "process-not-visible",
        "process-path-unavailable", "path-mismatch", "listener-misowned", "listener-timeout", "helper-error"].includes(details.activationReason)
        ? { activationReason: details.activationReason } : {}),
      ...(Number.isInteger(details.exitCode) ? { exitCode: details.exitCode } : {}),
      ...(["registered-process-handle", "child-process"].includes(details.exitCodeSource)
        ? { exitCodeSource: details.exitCodeSource } : {}),
      ...(Number.isInteger(details.elapsedSeconds) && details.elapsedSeconds >= 0 && details.elapsedSeconds <= 120
        ? { elapsedSeconds: details.elapsedSeconds }
        : {}),
      ...Object.fromEntries(["total", "pages", "appPages", "eligible"]
        .filter((key) => Number.isInteger(details[key]) && details[key] >= 0 && details[key] <= 10_000)
        .map((key) => [key, details[key]])),
      ...(typeof details.injected === "boolean" ? { injected: details.injected } : {}),
      ...(typeof details.frameLoaded === "boolean" ? { frameLoaded: details.frameLoaded } : {}),
      ...(typeof details.compatible === "boolean" ? { compatible: details.compatible } : {}),
      ...(details.checks && typeof details.checks === "object" ? {
        checks: Object.fromEntries([
          "appProtocol", "topFrame", "sidebarScroll", "sidebar", "pageMount",
          "referenceButton", "nativeBridge", "legacyScroll", "modernScroll",
          "legacyReference", "modernButton", "modernLink", "modernReferenceInChosenScroll",
          "headerReference",
        ].filter((key) => typeof details.checks[key] === "boolean")
          .map((key) => [key, details.checks[key]])),
      } : {}),
      ...(details.shape && typeof details.shape === "object" ? {
        shape: {
          ...(typeof details.shape.sameScroll === "boolean"
            ? { sameScroll: details.shape.sameScroll } : {}),
          ...Object.fromEntries([
            "navigationElements", "navigationButtons", "navigationLinks", "navigationRoleButtons",
            "scrollButtons", "scrollLinks", "scrollRoleButtons", "scrollSidebarItems",
            "scrollElements", "scrollDirectChildren", "navigationDirectChildren", "headerNativeRows",
          ].filter((key) => Number.isInteger(details.shape[key])
            && details.shape[key] >= 0 && details.shape[key] <= 1000)
            .map((key) => [key, details.shape[key]])),
        },
      } : {}),
      ...(typeof details.reason === "string" && [
        "before-injection", "connection-lost", "renderer-contract-mismatch",
        "invalid-probe-result", "probe-evaluation-failed", "probe-transport-failed",
        "codex-running", "activation-failed", "launcher-stopped",
      ].includes(details.reason)
        ? { reason: details.reason }
        : {}),
      ...(typeof details.stage === "string" && ["browser-version", "target-discovery", "target-fetch", "target-body"].includes(details.stage)
        ? { stage: details.stage }
        : {}),
      ...(typeof details.signal === "string" && /^SIG[A-Z0-9]{1,24}$/.test(details.signal)
        ? { signal: details.signal }
        : {}),
    },
  });
  console.log(line);
  if (startupDiagnosticPath) {
    try {
      mkdirSync(path.dirname(startupDiagnosticPath), { recursive: true, mode: 0o700 });
      appendFileSync(startupDiagnosticPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.error(`Startup diagnostic write failed (${error.code || "unknown"})`);
    }
  }
}
const taskboardOrigin = `http://127.0.0.1:${resolvePort()}`;
const taskboardHealthUrl = `${taskboardOrigin}/health`;
const taskboardBaseUrl = `${taskboardOrigin}/${encodeURIComponent(taskboardInstanceToken)}`;
const taskboardPageUrl = `${taskboardBaseUrl}/?host=codex`;
const hostBindingName = "__codexTaskboardHostV1";
const hostRequestMessage = "__codexTaskboardHostRequestV1";
const hostResponseMessage = "__codexTaskboardHostResponseV1";
const hostHeartbeatMessage = "__codexTaskboardHostHeartbeatV1";
const hostStartupTokenName = "__codexTaskboardHostStartupTokenV1";
const hostCapability = randomUUID();
const injectionSourceHashName = "__CODEX_TASKBOARD_SOURCE_HASH__";
const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__";
const codexAutomationMethods = new Set([
  "list-automations",
  "automation-create",
  "automation-update",
]);
let codexAutomationRequestSequence = 0;
let codexAppServerRequestSequence = 0;
const taskConversationOperations = new Map();
const taskConversationFailureTtlMs = 120_000;
const quotaPolicyTimers = new Map();
const quotaPolicyRecords = new Map();
const quotaPolicyQueues = new Map();
const quotaPolicyCdps = new Set();
const restoredQuotaPolicyCdps = new WeakSet();
const quotaPolicyRestorePromises = new WeakMap();
let quotaPoliciesLoadPromise = null;
let quotaPoliciesWritePromise = Promise.resolve();
const taskConversationAppServerTimeoutMs = 30_000;
const quotaDisplayRefreshMs = 60_000;
const quotaDisplayUnavailableAfterMs = 15 * 60_000;
const quotaDisplayRetryDelaysMs = [5_000, 15_000, 30_000];
let quotaDisplaySnapshot = null;
let quotaDisplayUnavailable = null;
let quotaDisplayRefreshPromise = null;
let quotaDisplayNextRefreshAt = 0;
let quotaDisplayFailureCount = 0;

function parseArgs(argv) {
  const options = {
    cdpPipe: false,
    windowsLoopbackCandidate: false,
    windowsRegistered: false,
    sidebarDiagnosticOnly: false,
    launch: false,
    watch: false,
    open: false,
    startupToken: null,
    screenshot: null,
    appPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--launch") options.launch = true;
    else if (arg === "--cdp-pipe") options.cdpPipe = true;
    else if (arg === "--windows-loopback-candidate") options.windowsLoopbackCandidate = true;
    else if (arg === "--windows-registered") options.windowsRegistered = true;
    else if (arg === "--sidebar-diagnostic-only") options.sidebarDiagnosticOnly = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--startup-token") {
      options.startupToken = argv[++index];
      if (!/^[a-z0-9-]{1,100}$/i.test(options.startupToken || "")) {
        throw new Error("--startup-token must be an identifier");
      }
    }
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++index]);
    else if (arg === "--app-path") options.appPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.launch || [options.cdpPipe, options.windowsLoopbackCandidate, options.windowsRegistered].filter(Boolean).length !== 1) {
    throw new Error("Select exactly one Codex transport for --launch");
  }
  if (options.windowsLoopbackCandidate &&
    (process.platform !== "win32" || process.env.AGENT_DESK_LOOPBACK_CANDIDATE !== "1")) {
    throw new Error("The Windows loopback candidate requires explicit source-test opt-in");
  }
  if (options.windowsRegistered && (process.platform !== "win32"
    || process.env.AGENT_DESK_WINDOWS_TRANSPORT !== "registered-loopback")) {
    throw new Error("Registered Codex transport must be selected by the Windows launcher");
  }
  if (options.sidebarDiagnosticOnly && !options.windowsLoopbackCandidate) {
    throw new Error("Sidebar diagnostics require the supervised source candidate");
  }
  if (!options.appPath) throw new Error("--app-path is required");
  return options;
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function isTaskboardReachable() {
  const challenge = randomBytes(32).toString("hex");
  try {
    const response = await fetch(taskboardHealthUrl, {
      headers: { "x-codex-taskboard-challenge": challenge },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    const proof = createHmac("sha256", taskboardInstanceSecret)
      .update(challenge)
      .digest("hex");
    return body?.status === "ok"
      && body.product === "codex-taskboard"
      && body.version === taskboardVersion
      && body.proof === proof;
  } catch {
    return false;
  }
}

async function waitUntilReachable(url, timeoutMs, shouldStop = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) throw new Error(`Stopped waiting for ${url}`);
    if (await isReachable(url)) return;
    if (shouldStop()) throw new Error(`Stopped waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitUntilTaskboardReachable(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTaskboardReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for authenticated ${taskboardHealthUrl}`);
}

function startTaskboard({ detached }) {
  const stdio = taskboardListenFd === null
    ? (detached ? "ignore" : "inherit")
    : Array.from(
      { length: taskboardListenFd + 1 },
      (_, fd) => (fd === taskboardListenFd ? "inherit" : (fd < 3 && !detached ? "inherit" : "ignore")),
    );
  return spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached,
    stdio,
    windowsHide: process.platform === "win32",
  });
}

async function publishTaskboardRuntime() {
  if (!taskboardRuntimeFile) return;
  const temporaryPath = `${taskboardRuntimeFile}.${process.pid}.tmp`;
  await mkdir(path.dirname(taskboardRuntimeFile), { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, pid: process.pid, url: taskboardBaseUrl })}\n`,
    { mode: 0o600 },
  );
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, taskboardRuntimeFile);
  await chmod(taskboardRuntimeFile, 0o600);
}

async function removeTaskboardRuntime() {
  if (!taskboardRuntimeFile) return;
  try {
    const descriptor = JSON.parse(await readFile(taskboardRuntimeFile, "utf8"));
    if (descriptor.pid === process.pid && descriptor.url === taskboardBaseUrl) {
      await unlink(taskboardRuntimeFile);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function codexExecutablePath(appPath) {
  if (process.platform === "linux") {
    return appPath === "/usr/bin/chatgpt" ? "/usr/lib/chatgpt/ChatGPT" : appPath;
  }
  if (process.platform !== "darwin") return appPath;
  return path.join(
    appPath,
    "Contents",
    "MacOS",
    path.basename(appPath, ".app"),
  );
}

async function launchCodexWithPipe(appPath) {
  startupAttemptId = randomUUID();
  rendererOrdinal = 0;
  emitQuotaTrace = createQuotaTraceBudget((trace) => logLaunchDiagnostic("quota-trace", { trace }));
  emitWorkbenchTrace = createWorkbenchTraceBudget((trace) => logLaunchDiagnostic("workbench-trace", { trace }));
  logLaunchDiagnostic("spawn-started");
  const child = spawn(
    codexExecutablePath(appPath),
    ["--remote-debugging-pipe"],
    {
      env: withoutTaskboardLauncherEnvironment(process.env),
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      windowsHide: false,
    },
  );
  logLaunchDiagnostic("spawn-returned", { pid: child.pid });
  child.once("exit", (exitCode, signal) => {
    logLaunchDiagnostic("codex-exited", { pid: child.pid, exitCode, signal, exitCodeSource: "child-process" });
  });
  child.stdio[4].once("end", () => {
    logLaunchDiagnostic("cdp-output-ended", { pid: child.pid });
  });
  const browser = new CdpPipeBrowser(child);
  child.once("error", (error) => browser.fail(error));
  try {
    await browser.open((stage) => logLaunchDiagnostic("cdp-handshake", { pid: child.pid, stage }));
    logLaunchDiagnostic("cdp-ready", { pid: child.pid });
    return { child, browser };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

function isCodexTarget(target) {
  return (
      target.type === "page" &&
      !target.url?.includes("initialRoute=%2Fglobal-dictation") &&
      !target.url?.includes("initialRoute=%2Favatar-overlay") &&
      target.url?.startsWith("app://")
  );
}

function pipeCdpRuntime(browser) {
  let previousDiscovery = null;
  return {
    targets: async () => {
      const targets = await browser.targets();
      const eligible = targets.filter(isCodexTarget);
      const discovery = {
        total: targets.length,
        pages: targets.filter((target) => target.type === "page").length,
        appPages: targets.filter((target) => target.type === "page" && target.url?.startsWith("app://")).length,
        eligible: eligible.length,
      };
      const fingerprint = JSON.stringify(discovery);
      if (fingerprint !== previousDiscovery) {
        console.log(JSON.stringify({ rendererDiscovery: discovery }));
        logLaunchDiagnostic("renderer-discovery", discovery);
        previousDiscovery = fingerprint;
      }
      return eligible.map((target) => ({ ...target, id: target.targetId }));
    },
    connect: (target) => browser.connect(target.id),
    isHealthy: () => !browser.closed,
    close: () => browser.close(),
  };
}

function frameTreeContains(frameTree, expectedUrl) {
  if (frameTree.frame?.url === expectedUrl) return true;
  return frameTree.childFrames?.some((child) => frameTreeContains(child, expectedUrl)) || false;
}

async function waitForFrame(cdp, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ targetInfos }, { frameTree }] = await Promise.all([
      cdp.send("Target.getTargets"),
      cdp.send("Page.getFrameTree"),
    ]);
    if (
      targetInfos.some((target) => target.type === "iframe" && target.url === expectedUrl) ||
      frameTreeContains(frameTree, expectedUrl)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function findFrameByName(frameTree, frameName) {
  if (frameTree.frame?.name === frameName) return frameTree.frame;
  for (const child of frameTree.childFrames ?? []) {
    const match = findFrameByName(child, frameName);
    if (match) return match;
  }
  return null;
}

async function verifiedTaskboardDocument(frameCapability) {
  const challenge = randomBytes(32).toString("hex");
  const response = await fetch(taskboardPageUrl, {
    signal: AbortSignal.timeout(2_000),
    cache: "no-store",
    headers: {
      origin: "app://-",
      "x-codex-taskboard-challenge": challenge,
    },
  });
  if (!response.ok) throw new Error(`Taskboard HTTP ${response.status}`);
  const proof = response.headers.get("x-codex-taskboard-proof") ?? "";
  const expectedProof = createHmac("sha256", taskboardInstanceSecret)
    .update(challenge)
    .digest("hex");
  if (proof !== expectedProof) throw new Error("Taskboard service identity check failed");
  const html = await response.text();
  const head = "<head>";
  if (!html.includes(head)) throw new Error("Taskboard document has no head element");
  const origin = new URL(taskboardPageUrl).origin;
  const nonce = randomBytes(24).toString("base64");
  // Document replacement does not transfer the verified server's CSP header.
  // Give the owned opaque document its own local-only policy, with one nonce
  // for its fixed capability bootstrap; native host policy stays untouched.
  const policy = `default-src 'none'; script-src ${origin} 'nonce-${nonce}'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin}; connect-src ${origin}; frame-src 'none'; object-src 'none'; base-uri ${origin}; form-action ${origin}`;
  return html.replace(
    head,
    `${head}<meta http-equiv="Content-Security-Policy" content=${JSON.stringify(policy)}><base href=${JSON.stringify(taskboardPageUrl)}><script nonce=${JSON.stringify(nonce)}>globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__=${JSON.stringify(frameCapability)};</script>`,
  );
}

async function loadTaskboardFrameViaCdp(cdp, frameName, frameCapability) {
  const emit = (bootstrap) => {
    cdp.taskboardBootstrapRecords = (cdp.taskboardBootstrapRecords || 0) + 1;
    if (cdp.taskboardBootstrapRecords <= 24) logLaunchDiagnostic("frame-bootstrap", { bootstrap });
  };
  if (cdp.taskboardFrameLoadInFlight) {
    emit("busy");
    throw new Error("An isolated Taskboard frame is already loading");
  }
  cdp.taskboardFrameLoadInFlight = true;
  try {
    const result = await initializeTaskboardFrameViaCdp(cdp, frameName, frameCapability);
    emit("ready");
    return result;
  } catch (error) {
    const reasons = new Map([
      ["Isolated Taskboard bootstrap timed out", "timeout"],
      ["Taskboard bootstrap document changed or expired", "invalidated"],
      ["Current renderer contract does not allow frame loading", "contract-refused"],
      ["Taskboard frame recreation refused", "frame-refused"],
      ["Taskboard frame is not a fresh direct child", "frame-refused"],
      ["Recreated Taskboard frame is not a fresh direct child", "frame-refused"],
    ]);
    emit(reasons.get(error.message) || "failed");
    throw error;
  }
  finally { cdp.taskboardFrameLoadInFlight = false; }
}

async function initializeTaskboardFrameViaCdp(cdp, frameName, frameCapability) {
  const loadDeadline = Date.now() + 10_000;
  const html = await verifiedTaskboardDocument(frameCapability);
  const probe = await probeRendererContract((method, params) => cdp.send(method, params), { timeoutMs: 0 });
  if (!probe.compatible || !probe.capabilities.fullPanel) throw new Error("Current renderer contract does not allow frame loading");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const targetFrame = findFrameByName(frameTree, frameName);
    if (targetFrame) {
      if (targetFrame.parentId !== frameTree.frame.id || targetFrame.url !== "about:blank") {
        throw new Error("Taskboard frame is not a fresh direct child");
      }
      // setDocumentContent retains about:blank's inherited native CSP. The
      // initial startup bypass has already been restored on subsequent opens.
      // Keep the window bounded to our verified document's module bootstrap;
      // the marker is diagnostic only, never proof of bridge authorization.
      let invalidated = false;
      const restore = () => { invalidated = true; void cdp.send("Page.setBypassCSP", { enabled: false }).catch(() => {}); };
      const cancel = cdp.on("Page.frameNavigated", ({ frame }) => { if (frame && !frame.parentId) restore(); });
      const safetyTimer = setTimeout(restore, Math.max(1, Math.min(8_000, loadDeadline - Date.now())));
      let ownedFrameId = null;
      try {
        await cdp.send("Page.setBypassCSP", { enabled: true });
        if (invalidated) throw new Error("Taskboard bootstrap document changed or expired");
        // Chromium applies the bypass when the child browsing context is
        // created, not retroactively to its inherited policy. Recreate only
        // our still-blank iframe; keep its element/listeners and fresh authority.
        const recreated = await cdp.send("Runtime.evaluate", { expression: `(() => {
          const page = document.getElementById("codex-taskboard-page");
          const frame = document.getElementById("codex-taskboard-frame");
          if (!page?.isConnected || page.getAttribute("data-codex-taskboard-owned") !== "true"
            || !frame || frame.parentElement !== page || frame.name !== ${JSON.stringify(frameName)}
            || frame.getAttribute("src") !== "about:blank"
            || frame.getAttribute("sandbox") !== "allow-scripts allow-forms allow-modals allow-downloads") return false;
          frame.remove(); page.appendChild(frame); return true;
        })()`, returnByValue: true });
        if (recreated.result?.value !== true || invalidated) throw new Error("Taskboard frame recreation refused");
        const freshTree = await cdp.send("Page.getFrameTree");
        const freshFrame = findFrameByName(freshTree.frameTree, frameName);
        if (!freshFrame || freshFrame.parentId !== freshTree.frameTree.frame.id || freshFrame.url !== "about:blank") {
          throw new Error("Recreated Taskboard frame is not a fresh direct child");
        }
        ownedFrameId = freshFrame.id;
        await cdp.send("Page.setDocumentContent", { frameId: freshFrame.id, html });
        const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
          frameId: freshFrame.id, worldName: "agent-desk-frame-bootstrap",
        });
        const bootstrapDeadline = Math.min(Date.now() + 8_000, loadDeadline);
        while (Date.now() < bootstrapDeadline) {
          const boot = await cdp.send("Runtime.evaluate", { contextId: executionContextId,
            expression: 'document.getElementById("root")?.getAttribute("data-agent-desk-frame-boot") === "awaiting-challenge"',
            returnByValue: true });
          if (invalidated) throw new Error("Taskboard bootstrap document changed or expired");
          if (boot.result?.value === true) return { loaded: true };
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Isolated Taskboard bootstrap timed out");
      } finally {
        clearTimeout(safetyTimer);
        cancel();
        await cdp.send("Page.setBypassCSP", { enabled: false });
        if (ownedFrameId) {
          await restoreOwnedFrameCsp(cdp, ownedFrameId);
          const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
            frameId: ownedFrameId, worldName: "agent-desk-frame-policy",
          });
          // Meta policies parsed during the bypass window were ignored. Apply
          // the fixed verified policy after restoring, inside our own document.
          const policy = await cdp.send("Runtime.evaluate", { contextId: executionContextId,
            expression: `(() => {
              const original = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
              if (!original) return false;
              const policy = document.createElement("meta");
              policy.httpEquiv = "Content-Security-Policy"; policy.content = original.content;
              document.head.appendChild(policy); return true;
            })()`, returnByValue: true });
          if (policy.result?.value !== true) throw new Error("Owned frame policy restoration refused");
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the isolated Taskboard frame");
}

async function restoreOwnedFrameCsp(cdp, ownedFrameId) {
  // Opaque out-of-process frames inherit the flag at target creation. Restoring
  // the parent's Page flag alone does not update an already-created OOPIF.
  // Attach a short-lived protocol session ONLY to the exact owned frame ID to
  // disable bypass; never enable it, evaluate code or discover a new app here.
  const { targetInfos } = await cdp.send("Target.getTargets");
  if (!Array.isArray(targetInfos)) throw new Error("Owned frame CSP target observation failed");
  if (!targetInfos.some(target => target.targetId === ownedFrameId && target.type === "iframe")) return;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: ownedFrameId, flatten: false });
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Owned frame CSP restoration failed");
  let cancel, timer;
  try {
    const restored = new Promise((resolve, reject) => {
      cancel = cdp.on("Target.receivedMessageFromTarget", (event) => {
        if (event.sessionId !== sessionId) return;
        let reply; try { reply = JSON.parse(event.message); } catch { return; }
        if (reply.id !== 1) return;
        if (reply.error) reject(new Error("Owned frame CSP restoration failed"));
        else resolve();
      });
      timer = setTimeout(() => reject(new Error("Owned frame CSP restoration timed out")), 2_000);
    });
    // A failed send still needs a handled timer rejection during cleanup.
    void restored.catch(() => {});
    await cdp.send("Target.sendMessageToTarget", { sessionId,
      message: JSON.stringify({ id: 1, method: "Page.setBypassCSP", params: { enabled: false } }) });
    await restored;
  } finally {
    clearTimeout(timer); cancel?.();
    await cdp.send("Target.detachFromTarget", { sessionId });
  }
}

async function openWithDefaultApplication(target) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32"
        ? "explorer.exe"
        : process.platform === "linux" ? "xdg-open" : "/usr/bin/open",
      [target],
      {
        detached: true,
        env: withoutTaskboardLauncherEnvironment(process.env),
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function revealAttachmentInFinder(attachmentPath, directory) {
  if (process.platform === "linux") {
    await openWithDefaultApplication(directory);
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/open", ["-R", attachmentPath], {
        env: withoutTaskboardLauncherEnvironment(process.env),
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Finder could not reveal the attachment"));
      });
    });
  } catch {
    await openWithDefaultApplication(directory);
  }
}

async function openExternalUrl(request) {
  await openWithDefaultApplication(request.url);
  return { opened: true };
}

async function openAttachment(request) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/attachments/${encodeURIComponent(request.attachmentId)}/content`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Attachment content returned HTTP ${response.status}`);
  const directory = path.join(
    taskboardDataDirectory,
    "opened-attachments",
    request.attachmentId,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const attachmentPath = path.join(directory, request.filename);
  await writeFile(attachmentPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  await revealAttachmentInFinder(attachmentPath, directory);
  return { opened: true };
}

async function requestCodexAutomationViaCdp(cdp, executionContextId, method, params) {
  if (!codexAutomationMethods.has(method)) {
    throw new Error(`Unsupported Codex automation method: ${method}`);
  }
  const requestId = [
    "taskboard-automation",
    process.pid,
    Date.now().toString(36),
    (++codexAutomationRequestSequence).toString(36),
  ].join("-");
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const method = ${JSON.stringify(method)};
      const params = ${JSON.stringify(params)};
      const requestId = ${JSON.stringify(requestId)};
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve({ ok: false, error: "当前 Codex 版本没有提供原生自动任务能力" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "fetch-response"
          || message.requestId !== requestId
        ) return;
        finish({
          ok: true,
          responseType: message.responseType,
          status: message.status,
          bodyJsonString: message.bodyJsonString,
        });
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, error: "Codex 自动任务接口没有响应" }),
        10_000,
      );
      window.addEventListener("message", onMessage);
      Promise.resolve(bridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "POST",
        url: \`vscode://codex/${method}\`,
        body: JSON.stringify(params),
      })).catch((error) => {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }))()`,
    ...(Number.isInteger(executionContextId) ? { contextId: executionContextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex automation request failed",
    );
  }
  const response = evaluation.result.value;
  if (!response?.ok) throw new Error(response?.error || "Codex automation request failed");
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`Codex automation request returned HTTP ${response.status}`);
  }
  if (typeof response.bodyJsonString !== "string" || response.bodyJsonString.length === 0) {
    return {};
  }
  try {
    return JSON.parse(response.bodyJsonString);
  } catch {
    throw new Error("Codex automation request returned invalid JSON");
  }
}

async function requestCodexAppServerViaCdp(
  cdp,
  executionContextId,
  hostId,
  method,
  params,
  timeoutMs = taskConversationAppServerTimeoutMs,
  source = "taskboard_thread_create",
) {
  const requestId = [
    "taskboard-thread",
    process.pid,
    Date.now().toString(36),
    (++codexAppServerRequestSequence).toString(36),
  ].join("-");
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const requestId = ${JSON.stringify(requestId)};
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve({ ok: false, error: "Codex App Server bridge is unavailable" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage, true);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "mcp-response"
          || message.hostId !== ${JSON.stringify(hostId)}
          || message.message?.id !== requestId
        ) return;
        event.stopImmediatePropagation();
        if (message.message.error) {
          finish({
            ok: false,
            error: message.message.error.message || "Codex App Server request failed",
          });
          return;
        }
        finish({ ok: true, result: message.message.result });
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, error: "Codex App Server request timed out" }),
        ${JSON.stringify(timeoutMs)},
      );
      window.addEventListener("message", onMessage, true);
      Promise.resolve(bridge.sendMessageFromView({
        type: "mcp-request",
        hostId: ${JSON.stringify(hostId)},
        request: {
          id: requestId,
          method: ${JSON.stringify(method)},
          params: ${JSON.stringify(params)},
        },
        priority: "interactive",
        source: ${JSON.stringify(source)},
        timeoutMs: ${JSON.stringify(timeoutMs)},
        expiresAtMs: Date.now() + ${JSON.stringify(timeoutMs)},
      })).catch((error) => {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }))()`,
    ...(Number.isInteger(executionContextId) ? { contextId: executionContextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex App Server request failed",
    );
  }
  const response = evaluation.result.value;
  if (!response?.ok) throw new Error(response?.error || "Codex App Server request failed");
  return response.result;
}

async function readCodexQuotaStatusViaCdp(model, hostId) {
  const checkedAt = Date.now();
  try {
    const cdp = currentQuotaPolicyCdp();
    const account = await requestCodexAppServerViaCdp(
      cdp,
      undefined,
      hostId,
      "account/read",
      { refreshToken: false },
      10_000,
    );
    if (account?.account?.type === "apiKey") {
      return { state: "unavailable", reason: "api-key", checkedAt };
    }
    if (account?.account?.type !== "chatgpt") {
      return { state: "unknown", checkedAt };
    }
    const result = await requestCodexAppServerViaCdp(
      cdp,
      undefined,
      hostId,
      "account/rateLimits/read",
      {},
      10_000,
    );
    return evaluateCodexRateLimits(result, model, checkedAt);
  } catch (error) {
    console.error(`Taskboard quota read failed: ${
      error instanceof Error ? error.message : String(error)
    }`);
    return { state: "unknown", checkedAt };
  }
}

async function readCodexQuotaSnapshotForDisplay(cdp) {
  const checkedAt = Date.now();
  cdp.taskboardQuotaReadState = { accountReadComplete: false, rateLimitsReadComplete: false,
    normalized: false };
  const account = await requestCodexAppServerViaCdp(
    cdp,
    undefined,
    "local",
    "account/read",
    { refreshToken: false },
    10_000,
    "taskboard_quota_display",
  );
  cdp.taskboardQuotaReadState.accountReadComplete = true;
  if (account?.account?.type === "apiKey") {
    throw new Error("Codex quota display requires a ChatGPT account");
  }
  if (account?.account?.type !== "chatgpt") {
    throw new Error("Codex quota account is unavailable");
  }
  const result = await requestCodexAppServerViaCdp(
    cdp,
    undefined,
    "local",
    "account/rateLimits/read",
    {},
    10_000,
    "taskboard_quota_display",
  );
  cdp.taskboardQuotaReadState.rateLimitsReadComplete = true;
  const snapshot = normalizeCodexRateLimitsForDisplay(result, checkedAt);
  cdp.taskboardQuotaReadState.normalized = true;
  return snapshot;
}

async function publishCodexQuotaDisplay(cdp) {
  const method = quotaDisplaySnapshot ? "update" : quotaDisplayUnavailable ? "unavailable" : "heartbeat";
  const payload = quotaDisplaySnapshot ?? quotaDisplayUnavailable;
  const expression = payload
    ? `window.__codexTaskboardQuotaDisplay__?.${method}(${JSON.stringify(payload)})`
    : "window.__codexTaskboardQuotaDisplay__?.heartbeat()";
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex quota display update failed",
    );
  }
  return evaluation.result.value;
}

async function refreshCodexQuotaDisplay(connections, { force = false } = {}) {
  const active = connections.filter((connection) => (
    connection
    && !connection.closed
    && connection.taskboardCompatibilityCapabilities?.quotaDisplay !== false
  ));
  if (active.length === 0) return null;
  if (!force && Date.now() < quotaDisplayNextRefreshAt) return quotaDisplaySnapshot;
  if (quotaDisplayRefreshPromise) return quotaDisplayRefreshPromise;

  quotaDisplayRefreshPromise = (async () => {
    try {
      active[0].taskboardQuotaReadAttempted = true;
      const snapshot = await readCodexQuotaSnapshotForDisplay(active[0]);
      quotaDisplaySnapshot = snapshot;
      quotaDisplayUnavailable = null;
      quotaDisplayFailureCount = 0;
      quotaDisplayNextRefreshAt = Date.now() + quotaDisplayRefreshMs;
    } catch (error) {
      quotaDisplayFailureCount += 1;
      const retryIndex = Math.min(
        quotaDisplayFailureCount - 1,
        quotaDisplayRetryDelaysMs.length - 1,
      );
      quotaDisplayNextRefreshAt = Date.now() + quotaDisplayRetryDelaysMs[retryIndex];
      if (
        !quotaDisplaySnapshot
        || Date.now() - quotaDisplaySnapshot.fetchedAtMs > quotaDisplayUnavailableAfterMs
      ) {
        quotaDisplaySnapshot = null;
        quotaDisplayUnavailable = {
          schemaVersion: 1,
          reasonCode: "E_RATE_LIMIT_UNAVAILABLE",
          atMs: Date.now(),
        };
      }
      console.error(`Codex quota display refresh failed: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    await Promise.allSettled(active.map(publishCodexQuotaDisplay));
    return quotaDisplaySnapshot;
  })();
  try {
    return await quotaDisplayRefreshPromise;
  } finally {
    quotaDisplayRefreshPromise = null;
  }
}

async function applyTaskboardAutomationPolicy(
  request,
  rpc,
  stillCurrent = () => true,
  { explicit = false, previousQuotaState } = {},
) {
  const quota = request.quotaAware
    ? await readCodexQuotaStatusViaCdp(request.model, request.codexHostId)
    : null;
  if (!stillCurrent()) return { quota, stale: true };
  let listed = null;
  let currentItem;
  if (!explicit && request.enabledByUser) {
    listed = await reconcileTaskboardAutomation({ ...request, operation: "list" }, rpc);
    const items = Array.isArray(listed.items) ? listed.items : [];
    currentItem = (
      request.automationId
        ? items.find((item) => item.id === request.automationId)
        : null
    ) ?? items[0];
  }
  const operation = taskboardAutomationPolicyOperation(request, {
    explicit,
    previousQuotaState,
    quotaState: quota?.state,
    currentStatus: currentItem?.status,
  });
  const result = operation === "list"
    ? { item: currentItem, items: listed.items }
    : await reconcileTaskboardAutomation({ ...request, operation }, rpc);
  if (result?.error === "not-found") {
    return { operation, ...(quota ? { quota } : {}) };
  }
  return { ...result, operation, ...(quota ? { quota } : {}) };
}

function storedAutomationPolicy(request) {
  return {
    taskboardProjectId: request.taskboardProjectId,
    codexProjectId: request.codexProjectId,
    codexProjectKind: request.codexProjectKind,
    codexHostId: request.codexHostId,
    projectName: request.projectName,
    workspacePath: request.workspacePath,
    remoteProjects: request.remoteProjects ?? [],
    skillPath: request.skillPath,
    ...(request.automationId ? { automationId: request.automationId } : {}),
    ...(request.controllerThreadId ? { controllerThreadId: request.controllerThreadId } : {}),
    enabledByUser: request.enabledByUser,
    quotaAware: request.quotaAware,
    intervalMinutes: request.intervalMinutes,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
  };
}

function restoredAutomationPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { quota, ...stored } = value;
  const request = parseTaskboardAutomationHostRequest({
    ...stored,
    id: "restored-policy",
    action: "automation",
    requestId: "restored-policy",
    operation: "apply-policy",
  });
  return request ? { request, ...(quota ? { quota } : {}) } : null;
}

async function ensureQuotaPoliciesLoaded() {
  if (quotaPoliciesLoadPromise) return quotaPoliciesLoadPromise;
  quotaPoliciesLoadPromise = (async () => {
    let stored = {};
    try {
      stored = JSON.parse(await readFile(automationPoliciesPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    for (const value of Object.values(stored)) {
      const restored = restoredAutomationPolicy(value);
      if (!restored) continue;
      quotaPolicyRecords.set(restored.request.taskboardProjectId, {
        version: 1,
        ...restored,
      });
    }
  })();
  return quotaPoliciesLoadPromise;
}

function persistQuotaPolicies() {
  const data = Object.fromEntries(
    [...quotaPolicyRecords.entries()].map(([projectId, record]) => [
      projectId,
      {
        ...storedAutomationPolicy(record.request),
        ...(record.quota ? { quota: record.quota } : {}),
      },
    ]),
  );
  quotaPoliciesWritePromise = quotaPoliciesWritePromise
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(automationPoliciesPath), { recursive: true });
      await writeFile(automationPoliciesPath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  return quotaPoliciesWritePromise;
}

function registerQuotaPolicyCdp(cdp) {
  quotaPolicyCdps.delete(cdp);
  quotaPolicyCdps.add(cdp);
}

function unregisterQuotaPolicyCdp(cdp) {
  quotaPolicyCdps.delete(cdp);
}

function currentQuotaPolicyCdp() {
  const candidates = [...quotaPolicyCdps].reverse();
  for (const cdp of candidates) {
    if (!cdp.closed) return cdp;
    quotaPolicyCdps.delete(cdp);
  }
  throw new Error("No live Codex renderer is available for quota automation");
}

function scheduleQuotaPolicyCheck(record, result) {
  const { request, version } = record;
  const key = request.taskboardProjectId;
  const previous = quotaPolicyTimers.get(key);
  if (previous) clearTimeout(previous);
  quotaPolicyTimers.delete(key);
  if (!request.enabledByUser || !request.quotaAware) return;

  const nextRunAt = Number(result.item?.nextRunAt);
  const nextRunDelay = Number.isFinite(nextRunAt) && nextRunAt > Date.now()
    ? Math.max(1_000, nextRunAt - Date.now() - 15_000)
    : 60_000;
  const resetDelay = result.quota?.state === "blocked"
    && Number.isFinite(result.quota.resetsAt)
    ? Math.max(1_000, result.quota.resetsAt * 1_000 - Date.now() + 1_000)
    : nextRunDelay;
  const timer = setTimeout(async () => {
    if (quotaPolicyRecords.get(key)?.version !== version) return;
    try {
      await enqueueCurrentQuotaPolicy(key);
    } catch (error) {
      console.error(`Taskboard quota policy check failed: ${error.message}`);
      const current = quotaPolicyRecords.get(key);
      if (current?.version === version) {
        scheduleQuotaPolicyCheck(current, { quota: { state: "unknown" } });
      }
    }
  }, Math.min(nextRunDelay, resetDelay));
  timer.unref();
  quotaPolicyTimers.set(key, timer);
}

function enqueueQuotaPolicyMutation(record, rpc, { explicit = false } = {}) {
  const key = record.request.taskboardProjectId;
  const previous = quotaPolicyQueues.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const current = quotaPolicyRecords.get(key);
      if (!current || current.version !== record.version) return { stale: true };
      const result = await applyTaskboardAutomationPolicy(
        current.request,
        rpc,
        () => quotaPolicyRecords.get(key)?.version === current.version,
        {
          explicit,
          previousQuotaState: current.quota?.state,
        },
      );
      if (result.stale) return result;
      if (result.item?.id) {
        current.request = { ...current.request, automationId: result.item.id };
      }
      if (current.request.quotaAware && result.quota) current.quota = result.quota;
      else delete current.quota;
      await persistQuotaPolicies();
      scheduleQuotaPolicyCheck(current, result);
      return result;
    });
  const tracked = run.finally(() => {
    if (quotaPolicyQueues.get(key) === tracked) quotaPolicyQueues.delete(key);
  });
  quotaPolicyQueues.set(key, tracked);
  return tracked;
}

async function updateAndApplyQuotaPolicy(request, rpc) {
  await ensureQuotaPoliciesLoaded();
  const previous = quotaPolicyRecords.get(request.taskboardProjectId);
  const record = {
    version: (previous?.version ?? 0) + 1,
    request,
    ...(request.quotaAware && previous?.quota ? { quota: previous.quota } : {}),
  };
  quotaPolicyRecords.set(request.taskboardProjectId, record);
  try {
    await persistQuotaPolicies();
    const result = await enqueueQuotaPolicyMutation(record, rpc, { explicit: true });
    const current = quotaPolicyRecords.get(request.taskboardProjectId);
    return {
      ...result,
      policy: storedAutomationPolicy(current.request),
      ...(current.quota ? { quota: current.quota } : {}),
    };
  } catch (error) {
    if (quotaPolicyRecords.get(request.taskboardProjectId)?.version === record.version) {
      if (previous) quotaPolicyRecords.set(request.taskboardProjectId, previous);
      else quotaPolicyRecords.delete(request.taskboardProjectId);
      await persistQuotaPolicies();
    }
    throw error;
  }
}

async function reconcileStoredAutomationPolicy(request, rpc) {
  await ensureQuotaPoliciesLoaded();
  const projectId = request.taskboardProjectId;
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return null;
  if (
    record.request.codexProjectId !== request.codexProjectId
    || record.request.codexProjectKind !== request.codexProjectKind
    || record.request.codexHostId !== request.codexHostId
    || record.request.workspacePath !== request.workspacePath
    || JSON.stringify(record.request.remoteProjects ?? []) !== JSON.stringify(request.remoteProjects ?? [])
    || (!record.request.controllerThreadId && Boolean(request.controllerThreadId))
  ) {
    return updateAndApplyQuotaPolicy({
      ...request,
      automationId: record.request.automationId,
      controllerThreadId: record.request.controllerThreadId ?? request.controllerThreadId,
      enabledByUser: record.request.enabledByUser,
      quotaAware: record.request.quotaAware,
      intervalMinutes: record.request.intervalMinutes,
      model: record.request.model,
      reasoningEffort: record.request.reasoningEffort,
    }, rpc);
  }
  const result = await enqueueQuotaPolicyMutation(record, rpc);
  const current = quotaPolicyRecords.get(projectId);
  return {
    ...result,
    policy: storedAutomationPolicy(current.request),
    ...(current.quota ? { quota: current.quota } : {}),
  };
}

async function enqueueCurrentQuotaPolicy(projectId) {
  await ensureQuotaPoliciesLoaded();
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return { stale: true };
  return enqueueQuotaPolicyMutation(
    record,
    (method, body) => requestCodexAutomationViaCdp(
      currentQuotaPolicyCdp(),
      undefined,
      method,
      body,
    ),
  );
}

async function restoreQuotaPolicies(cdp) {
  registerQuotaPolicyCdp(cdp);
  if (restoredQuotaPolicyCdps.has(cdp)) return;
  const pending = quotaPolicyRestorePromises.get(cdp);
  if (pending) return pending;
  const restoring = (async () => {
    await ensureQuotaPoliciesLoaded();
    for (const projectId of quotaPolicyRecords.keys()) {
      // A disabled policy is still an instruction: Codex must remain paused.
      // Reconcile every persisted policy so a renderer/process exit between the
      // local write and the Codex update cannot leave an ACTIVE automation behind.
      await enqueueCurrentQuotaPolicy(projectId);
    }
    restoredQuotaPolicyCdps.add(cdp);
  })();
  quotaPolicyRestorePromises.set(cdp, restoring);
  try {
    await restoring;
  } finally {
    quotaPolicyRestorePromises.delete(cdp);
  }
}

async function startTaskConversationViaCdp(cdp, executionContextId, request) {
  const {
    codexHostId,
    instruction,
    previousThreadId,
    projectless,
    targetRoot,
    title,
  } = request;
  const normalizeWorkspaceRoot = (value) => {
    const root = String(value || "").trim();
    if (!root) return "";
    const windowsPath = /^[A-Za-z]:[\\/]/.test(root) || root.includes("\\");
    const normalizedSlashes = windowsPath ? root.replace(/\\/g, "/") : root;
    const withoutTrailingSlash = normalizedSlashes.replace(/\/+$/, "")
      || (normalizedSlashes.startsWith("/") ? "/" : normalizedSlashes);
    if (!windowsPath || !/^[A-Za-z]:/.test(withoutTrailingSlash)) return withoutTrailingSlash;
    return `${withoutTrailingSlash[0].toLowerCase()}${withoutTrailingSlash.slice(1)}`;
  };
  const normalizedTargetRoot = normalizeWorkspaceRoot(targetRoot);
  const deadline = Date.now() + 8_000;
  let submitted = false;
  while (Date.now() < deadline) {
    const prepared = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const root = Array.from(document.querySelectorAll(
          '[data-codex-composer-root][data-composer-placement="home"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        const conversationId = root
          ?.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id')
          ?.trim() || "";
        const editor = Array.from(root?.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        ) || []).find((candidate) => candidate.getClientRects().length > 0);
        if (
          !root
          || conversationId
          || !editor
          || (editor.innerText || "") !== ${JSON.stringify(instruction)}
        ) return false;
        editor.focus();
        return true;
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (prepared.result.value !== true) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    submitted = true;
    break;
  }
  if (!submitted) throw new Error("Codex new conversation composer did not become ready");

  const threadDeadline = Date.now() + 12_000;
  let discoveredThreadId = "";
  try {
    while (Date.now() < threadDeadline) {
      const started = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const root = Array.from(document.querySelectorAll(
            '[data-codex-composer-root][data-composer-placement="thread"]'
          )).find((candidate) => candidate.getClientRects().length > 0);
          const threadId = root
            ?.querySelector('[data-above-composer-conversation-id]')
            ?.getAttribute('data-above-composer-conversation-id')
            ?.trim() || "";
          return threadId.replace(/^(?:local|cloud):/i, "");
        })()`,
        contextId: executionContextId,
        returnByValue: true,
      });
      const threadId = typeof started.result.value === "string" ? started.result.value : "";
      if (threadId && threadId !== previousThreadId) {
        discoveredThreadId = threadId;
        const readyDeadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < readyDeadline) {
          try {
            const result = await requestCodexAppServerViaCdp(
              cdp,
              executionContextId,
              codexHostId,
              "thread/read",
              { threadId, includeTurns: false },
              10_000,
            );
            if (
              result?.thread?.id === threadId
              && (
                projectless
                || normalizeWorkspaceRoot(result.thread.cwd) === normalizedTargetRoot
              )
            ) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        if (!ready) {
          throw new Error(projectless
            ? "Codex did not confirm the projectless task conversation"
            : "Codex did not confirm the task conversation workspace root");
        }

        try {
          await requestCodexAppServerViaCdp(
            cdp,
            executionContextId,
            codexHostId,
            "thread/name/set",
            { threadId, name: title },
            10_000,
          );
        } catch (error) {
          const message = error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();
          if (!message.includes("rollout") || !message.includes("is empty")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await requestCodexAppServerViaCdp(
            cdp,
            executionContextId,
            codexHostId,
            "thread/name/set",
            { threadId, name: title },
            10_000,
          );
        }

        const titleDeadline = Date.now() + 10_000;
        while (Date.now() < titleDeadline) {
          try {
            const result = await requestCodexAppServerViaCdp(
              cdp,
              executionContextId,
              codexHostId,
              "thread/read",
              { threadId, includeTurns: false },
              10_000,
            );
            if (result?.thread?.id === threadId && result.thread.name === title) {
              return { threadId, title };
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error("Codex did not confirm the task conversation title");
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error("Timed out while starting the Codex conversation");
  } catch (error) {
    if (error && typeof error === "object") {
      if (discoveredThreadId) error.threadId = discoveredThreadId;
      else if (submitted) error.uncertain = true;
    }
    throw error;
  }
}

function getOrStartTaskConversation(cdp, executionContextId, request) {
  const existing = taskConversationOperations.get(request.taskId);
  if (existing) return existing.promise;

  const operation = { promise: null };
  const promise = Promise.resolve().then(() => (
    startTaskConversationViaCdp(cdp, executionContextId, request)
  ));
  operation.promise = promise;
  taskConversationOperations.set(request.taskId, operation);
  const clearSettledOperation = () => {
    if (taskConversationOperations.get(request.taskId) === operation) {
      taskConversationOperations.delete(request.taskId);
    }
  };
  const retainCreatedOrUncertainFailure = (error) => {
    if (!(
      error
      && typeof error === "object"
      && (typeof error.threadId === "string" || error.uncertain === true)
    )) {
      clearSettledOperation();
      return;
    }
    const timer = setTimeout(() => {
      clearSettledOperation();
    }, taskConversationFailureTtlMs);
    timer.unref?.();
  };
  void promise.then(clearSettledOperation, retainCreatedOrUncertainFailure);
  return promise;
}

async function sendHostResponse(cdp, executionContextId, response) {
  await cdp.send("Runtime.evaluate", {
    expression: `window.postMessage({
      type: ${JSON.stringify(hostResponseMessage)},
      capability: ${JSON.stringify(hostCapability)},
      response: ${JSON.stringify(response)}
    }, window.location.origin)`,
    contextId: executionContextId,
    returnByValue: true,
  });
}

function installTaskboardHostBinding(cdp, supervisor, startupToken) {
  let activeContextId = null;
  let installInFlight = null;
  let heartbeatInFlight = null;
  let generation = 0;
  let disposed = false;
  const heartbeatPump = createHostHeartbeatPump(publishHeartbeat);
  const invalidate = () => {
    generation++;
    activeContextId = null;
    installInFlight = null;
    heartbeatInFlight = null;
    heartbeatPump.stop();
    cdp.taskboardCompatibilityCapabilities = null;
  };
  const listeners = [
    cdp.on("Runtime.executionContextsCleared", invalidate),
    cdp.on("Runtime.executionContextDestroyed", (params) => {
      if (params.executionContextId === activeContextId) invalidate();
    }),
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (frame && !frame.parentId) invalidate();
    }),
  ];

  listeners.push(cdp.on("Runtime.bindingCalled", async (params) => {
    if (params.name !== hostBindingName) return;
    if (disposed || activeContextId === null || params.executionContextId !== activeContextId) return;
    await handleHostBindingPayload(params, {
      isAuthorizedContext: (executionContextId) => executionContextId === activeContextId,
      parseAutomationRequest: parseTaskboardAutomationHostRequest,
      ensure: () => supervisor.ensure({ force: true }),
      handoffApproval: async (request) => {
        if (!cdp.taskboardCompatibilityCapabilities?.fullPanel) throw new Error("当前 Codex 界面无法安全显示审批中心");
        return handoffApproval(request);
      },
      readModelCatalog: async (request) => {
        if (!cdp.taskboardCompatibilityCapabilities?.taskNavigation) {
          throw new Error("Codex model catalog bridge is unavailable");
        }
        return readNativeModelCatalog((method, params, timeoutMs) => requestCodexAppServerViaCdp(
          cdp, undefined, request.codexHostId, method, params, timeoutMs, "taskboard_model_catalog",
        ));
      },
      loadFrame: (request) => loadTaskboardFrameViaCdp(
        cdp,
        request.frameName,
        request.frameCapability,
      ),
      openExternal: openExternalUrl,
      openAttachment,
      runAutomation: (request) => (
        (async () => {
          const rpc = (method, body) => requestCodexAutomationViaCdp(
            cdp,
            undefined,
            method,
            body,
          );
          if (request.operation === "list") {
            const stored = await reconcileStoredAutomationPolicy(
              request,
              rpc,
            );
            return stored ?? reconcileTaskboardAutomation(request, rpc);
          }
          return request.operation === "apply-policy"
            ? updateAndApplyQuotaPolicy(request, rpc)
            : reconcileTaskboardAutomation(request, rpc);
        })()
      ),
      startConversation: (request) => (
        getOrStartTaskConversation(cdp, undefined, request)
      ),
      sendResponse: (executionContextId, response) => (
        sendHostResponse(cdp, executionContextId, response)
      ),
    });
  }));

  async function install() {
    if (disposed || !cdp.taskboardCompatibilityCapabilities?.fullPanel) {
      throw new Error("The current document has no validated Taskboard host contract");
    }
    if (installInFlight) return installInFlight;
    if (activeContextId !== null) return activeContextId;
    const currentGeneration = generation;
    const checkCurrentDocument = () => {
      if (disposed || currentGeneration !== generation || !cdp.taskboardCompatibilityCapabilities?.fullPanel) {
        throw new Error("Taskboard host document changed during installation");
      }
    };
    const installation = (async () => {
      const { frameTree } = await cdp.send("Page.getFrameTree");
      checkCurrentDocument();
      const isolatedWorld = await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "codex-taskboard-host",
      });
      checkCurrentDocument();
      const contextId = isolatedWorld.executionContextId;
      await cdp.send("Runtime.addBinding", {
        name: hostBindingName,
        executionContextId: contextId,
      });
      checkCurrentDocument();
      const bindingResult = await cdp.send("Runtime.evaluate", {
        contextId,
        expression: `(() => {
          const capability = ${JSON.stringify(hostCapability)};
          if (globalThis.__codexTaskboardIsolatedBridgeV1 === capability) return;
          globalThis.__codexTaskboardIsolatedBridgeV1 = capability;
          window.addEventListener("message", (event) => {
            const message = event.data;
            if (
              event.source !== window
              || event.origin !== window.location.origin
              || !message
              || typeof message !== "object"
              || message.type !== ${JSON.stringify(hostRequestMessage)}
              || message.capability !== capability
            ) return;
            globalThis[${JSON.stringify(hostBindingName)}](JSON.stringify(message.payload));
          });
        })()`,
        returnByValue: true,
      });
      checkCurrentDocument();
      if (bindingResult?.exceptionDetails) throw new Error("Taskboard host binding evaluation failed");
      activeContextId = contextId;
      await restoreQuotaPolicies(cdp);
      checkCurrentDocument();
      heartbeatPump.start();
      return activeContextId;
    })();
    installInFlight = installation;
    try {
      return await installation;
    } catch (error) {
      if (currentGeneration === generation) invalidate();
      throw error;
    } finally {
      if (installInFlight === installation) installInFlight = null;
    }
  }

  async function publishHeartbeat() {
    if (disposed || activeContextId === null || !cdp.taskboardCompatibilityCapabilities?.fullPanel) {
      throw new Error("Taskboard host document is not validated");
    }
    if (heartbeatInFlight) return heartbeatInFlight;
    const publication = publishCurrentHeartbeat(activeContextId, generation);
    heartbeatInFlight = publication;
    try { return await publication; }
    finally { if (heartbeatInFlight === publication) heartbeatInFlight = null; }
  }

  async function publishCurrentHeartbeat(executionContextId, currentGeneration) {
    let timeout;
    try {
      await Promise.race([
        (async () => {
          if (disposed || generation !== currentGeneration) throw new Error("Taskboard host document changed");
          const result = await cdp.send("Runtime.evaluate", {
            contextId: executionContextId,
            expression: `window.postMessage({
              type: ${JSON.stringify(hostHeartbeatMessage)},
              capability: ${JSON.stringify(hostCapability)},
              at: Date.now(),
              startupToken: ${JSON.stringify(startupToken)}
            }, window.location.origin)`,
            returnByValue: true,
          });
          if (disposed || generation !== currentGeneration) throw new Error("Taskboard host document changed");
          if (result?.exceptionDetails) throw new Error("Taskboard host heartbeat evaluation failed");
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("Timed out publishing the Taskboard host heartbeat"));
          }, 3_000);
        }),
      ]);
    } catch (error) {
      if (!disposed && generation === currentGeneration) {
        invalidate();
        cdp.close();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    install, publishHeartbeat,
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
      for (const remove of listeners) remove?.();
    },
  };
}

async function readInjectionStatus(cdp) {
  const status = await cdp.send("Runtime.evaluate", {
    expression: `({
      version: window.__codexTaskboardInjection__?.version || null,
      sourceHash: window.__codexTaskboardInjection__?.sourceHash || null,
      scriptIdentifier: window[${JSON.stringify(injectionScriptIdentifierName)}] || null,
      entryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
      pageMounted: Boolean(document.getElementById("codex-taskboard-page")),
      pageVisible: window.__codexTaskboardInjection__?.diagnostics?.().events.at(-1)?.pageVisible === true,
      frameReady: window.__codexTaskboardInjection__?.ready === true
        && window.__codexTaskboardInjection__?.diagnostics?.().events.at(-1)?.frameLoadAcknowledged === true,
      frameUrl: document.getElementById("codex-taskboard-frame")?.src || null,
      quotaDirectNavigationChild: document.getElementById("codex-taskboard-quota-display")
        ?.parentElement?.matches('nav[role="navigation"][aria-label]') === true,
      scrollDirectNavigationChild: document.querySelector("[data-app-action-sidebar-scroll]")
        ?.parentElement?.matches('nav[role="navigation"][aria-label]') === true,
      quotaDisplay: window.__codexTaskboardQuotaDisplay__?.status?.() || null
    })`,
    returnByValue: true,
  });
  return status.result.value;
}

async function waitForInjectionStatus(cdp, shouldOpen, expectedSourceHash, timeoutMs, {
  heartbeat = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let nextHeartbeatAt = 0;
  let status = await readInjectionStatus(cdp);
  while (
    Date.now() < deadline
    && (
      status.sourceHash !== expectedSourceHash
      || !status.entryMounted
      || (shouldOpen && (!status.pageVisible || !status.frameUrl || !status.frameReady))
    )
  ) {
    if (heartbeat && Date.now() >= nextHeartbeatAt) {
      await heartbeat();
      nextHeartbeatAt = Date.now() + 2_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await readInjectionStatus(cdp);
  }
  return status;
}

function injectionReadinessSummary(status, expectedSourceHash, frameLoaded) {
  return {
    sourceActive: status?.sourceHash === expectedSourceHash,
    entryMounted: status?.entryMounted === true,
    pageMounted: status?.pageMounted === true,
    pageVisible: status?.pageVisible === true,
    frameCreated: Boolean(status?.frameUrl),
    frameReady: status?.frameReady === true,
    frameLoaded: frameLoaded === true,
    quotaMounted: status?.quotaDisplay?.mounted === true,
    quotaCleaned: status?.quotaDisplay?.cleaned === true,
    quotaDirectNavigationChild: status?.quotaDirectNavigationChild === true,
    scrollDirectNavigationChild: status?.scrollDirectNavigationChild === true,
  };
}

async function reportCandidateInjectionFailure(cdp, status, sourceHash, frameLoaded) {
  console.error(JSON.stringify({ injectionReadiness:
    injectionReadinessSummary(status, sourceHash, frameLoaded) }));
  if (process.env.AGENT_DESK_LOOPBACK_CANDIDATE !== "1") return;
  const diagnostic = {
    anchorProbeAvailable: false, childProbeAvailable: false,
    quotaReadAttempted: cdp.taskboardQuotaReadAttempted === true,
    quotaSnapshotAvailable: Boolean(quotaDisplaySnapshot),
    quotaAccountReadComplete: cdp.taskboardQuotaReadState?.accountReadComplete === true,
    quotaRateLimitsReadComplete: cdp.taskboardQuotaReadState?.rateLimitsReadComplete === true,
    quotaNormalized: cdp.taskboardQuotaReadState?.normalized === true,
  };
  try {
    const probe = await probeRendererContract(
      (method, params) => cdp.send(method, params),
      { timeoutMs: 0 },
    );
    if (probe.checks) {
      diagnostic.anchorProbeAvailable = true;
      diagnostic.anchorCompatible = probe.compatible;
      diagnostic.headerReference = probe.checks?.headerReference === true;
      diagnostic.sidebar = probe.checks?.sidebar === true;
      diagnostic.sidebarScroll = probe.checks?.sidebarScroll === true;
      diagnostic.pageMount = probe.checks?.pageMount === true;
    }
  } catch {}
  try {
    const nameResult = await cdp.send("Runtime.evaluate", {
      expression: 'document.getElementById("codex-taskboard-frame")?.name || null',
      returnByValue: true,
    });
    const frameName = nameResult.result?.value;
    if (typeof frameName === "string" && /^codex-taskboard-[0-9a-f-]{36}$/.test(frameName)) {
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const frame = findFrameByName(frameTree, frameName);
      diagnostic.childFrameMatched = Boolean(frame);
      if (frame) {
        const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
          frameId: frame.id,
          worldName: "agent-desk-readiness-diagnostic",
        });
        const child = await cdp.send("Runtime.evaluate", {
          contextId: executionContextId,
          expression: `(() => {
            let baseHostCodex = false;
            try { baseHostCodex = new URL(document.baseURI).searchParams.get("host") === "codex"; }
            catch {}
            const root = document.getElementById("root");
            return {
              documentComplete: document.readyState === "complete",
              baseHostCodex,
              modulePresent: Boolean(document.querySelector('script[type="module"][src]')),
              rootPresent: Boolean(root),
              rootPopulated: Boolean(root?.childElementCount),
            };
          })()`,
          returnByValue: true,
        });
        if (!child.exceptionDetails && child.result?.value) {
          diagnostic.childProbeAvailable = true;
          for (const key of ["documentComplete", "baseHostCodex", "modulePresent",
            "rootPresent", "rootPopulated"]) {
            diagnostic[key] = child.result.value[key] === true;
          }
        }
      }
    }
  } catch {}
  console.error(JSON.stringify({ injectionFailureShape: diagnostic }));
  if (diagnostic.anchorProbeAvailable && !diagnostic.anchorCompatible) {
    try {
      const shape = await cdp.send("Runtime.evaluate", {
        expression: sidebarDiagnosticExpression,
        returnByValue: true,
      });
      const summary = shape.exceptionDetails ? null : normalizeSidebarDiagnostic(shape.result?.value);
      console.error(JSON.stringify({ injectionSidebarShape: summary }));
    } catch {
      console.error(JSON.stringify({ injectionSidebarShape: null }));
    }
  }
}

async function evaluateInjectionSource(cdp, source) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description || "Taskboard injection failed",
    );
  }
}

async function publishInjectionScriptIdentifier(cdp, scriptIdentifier) {
  await cdp.send("Runtime.evaluate", {
    expression: `window[${JSON.stringify(injectionScriptIdentifierName)}] = ${JSON.stringify(scriptIdentifier)}`,
    returnByValue: true,
  });
}

async function registerInjectionSource(cdp, source) {
  const registration = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${source}\n//# sourceURL=codex-taskboard.user.js`,
  });
  return registration.identifier;
}

async function detachInjection(cdp, { audit = false } = {}) {
  cdp.quotaObserver?.mark("detach-start");
  cdp.hostBridge?.dispose();
  unregisterQuotaPolicyCdp(cdp);
  try {
    const cleanup = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        if (window.__CODEX_TASKBOARD_PENDING_INJECTION__) {
          window.__CODEX_TASKBOARD_PENDING_INJECTION__.cancelled = true;
        }
        window.__codexTaskboardQuotaDisplay__?.cleanup?.();
        window.__codexTaskboardInjection__?.destroy?.();
        return {
          quotaHostPresent: Boolean(document.getElementById("codex-taskboard-quota-display")),
          entryPresent: Boolean(document.getElementById("codex-taskboard-entry")),
          quotaObservation: location.protocol === "app:" && window.top === window ? {
            appProtocol: true, topFrame: true,
            apiPresent: typeof window.__codexTaskboardQuotaDisplay__?.diagnostics === "function",
            trace: window.__codexTaskboardQuotaDisplay__?.diagnostics?.(),
          } : null,
        };
      })()`,
      returnByValue: true,
    });
    if (!cleanup.exceptionDetails) cdp.quotaObserver?.capture(cleanup.result?.value?.quotaObservation);
    if (audit) console.error(JSON.stringify({ injectionCleanup: {
      evaluationOk: !cleanup.exceptionDetails,
      quotaHostPresent: cleanup.result?.value?.quotaHostPresent === true,
      entryPresent: cleanup.result?.value?.entryPresent === true,
    } }));
  } catch (_) {
    if (audit) console.error(JSON.stringify({ injectionCleanup: { transportFailed: true } }));
  }
  cdp.quotaObserver?.mark("detach-returned");
  cdp.quotaObserver?.dispose();
  if (cdp.taskboardScriptIdentifier) {
    try {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: cdp.taskboardScriptIdentifier,
      });
    } catch (_) {}
  }
  try {
    await cdp.send("Page.setBypassCSP", { enabled: false });
  } catch (_) {}
  cdp.close();
}

async function revalidateLoadedRenderer(cdp, allowedCapabilities) {
  const probe = await probeRendererContract((method, params) => cdp.send(method, params));
  cdp.quotaObserver?.mark("contract-result", { compatible: probe.compatible });
  if (!probe.compatible) {
    console.log(JSON.stringify({
      compatibilityMode: "shortcut-plugin-only",
      compatibilityReason: probe.reason,
      compatibilityChecks: probe.checks,
      rendererReloadRejected: true,
    }));
    await detachInjection(cdp);
    return false;
  }
  cdp.taskboardCompatibilityCapabilities = {
    fullPanel: true,
    quotaDisplay: allowedCapabilities.quotaDisplay && probe.capabilities.quotaDisplay,
    taskNavigation: allowedCapabilities.taskNavigation && probe.capabilities.taskNavigation,
  };
  return true;
}

async function injectTarget(
  runtime,
  target,
  shouldOpen,
  screenshotPath,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
  compatibility,
  sidebarDiagnosticOnly = false,
) {
  const renderer = ++rendererOrdinal;
  logLaunchDiagnostic("renderer-probe-start", { renderer });
  const cdp = await runtime.connect(target);
  let retained = false;
  let injectionStarted = false;
  try {
    await cdp.send("Runtime.enable");
    const contractProbe = await probeRendererContract((method, params) => cdp.send(method, params));
    logLaunchDiagnostic("renderer-contract", { ...contractProbe, renderer });
    if (sidebarDiagnosticOnly) {
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: sidebarDiagnosticExpression,
        returnByValue: true,
      });
      const diagnostic = evaluation.exceptionDetails ? null
        : normalizeSidebarDiagnostic(evaluation.result?.value);
      return {
        result: {
          injected: false,
          compatibilityMode: "diagnostic-only",
          compatibilityReason: contractProbe.reason,
          compatibilityChecks: contractProbe.checks,
          sidebarDiagnostic: diagnostic,
        },
        connection: null,
      };
    }
    if (!contractProbe.compatible) {
      retained = keepAlive;
      return {
        result: {
          injected: false,
          compatibilityMode: "shortcut-plugin-only",
          compatibilityReason: contractProbe.reason,
          compatibilityChecks: contractProbe.checks,
        },
        connection: null,
        rejectionConnection: retained ? cdp : null,
      };
    }
    const capabilities = contractProbe.capabilities;
    if (keepAlive) cdp.quotaObserver = createQuotaObserver(cdp, renderer, emitQuotaTrace, {
      emitWorkbench: emitWorkbenchTrace,
      reportHealth: (health, renderer) => logLaunchDiagnostic("workbench-health", { health, renderer }),
    });
    const { source, sourceHash } = await currentInjectionSource(capabilities);
    cdp.taskboardCompatibilityCapabilities = capabilities;
    const hostBridge = keepAlive
      ? installTaskboardHostBinding(cdp, supervisor, startupToken)
      : null;
    cdp.hostBridge = hostBridge;
    await cdp.send("Page.enable");
    await cdp.send("Page.setBypassCSP", { enabled: true });
    injectionStarted = true;
    if (keepAlive) await hostBridge.install();
    if (keepAlive && attachExisting) {
      const currentStatus = await readInjectionStatus(cdp);
      const reconciled = await reconcileInjectionRuntime({
        currentStatus,
        source,
        sourceHash,
        removeRegisteredSource: (identifier) => cdp.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier },
        ),
        registerCurrentSource: (currentSource) => registerInjectionSource(cdp, currentSource),
        evaluateCurrentSource: (currentSource) => evaluateInjectionSource(cdp, currentSource),
        publishRegistration: (identifier) => publishInjectionScriptIdentifier(cdp, identifier),
        reopen: () => cdp.send("Runtime.evaluate", {
          expression: "window.__codexTaskboardInjection__?.open()",
          returnByValue: true,
        }),
      });
      cdp.taskboardScriptIdentifier = reconciled.scriptIdentifier;
      cdp.on("Page.loadEventFired", async () => {
        if (!(await revalidateLoadedRenderer(cdp, capabilities))) return;
        await hostBridge.install();
        await publishInjectionScriptIdentifier(cdp, reconciled.scriptIdentifier);
        await hostBridge.publishHeartbeat();
        await publishCodexQuotaDisplay(cdp);
      });
      await hostBridge.publishHeartbeat();
      await refreshCodexQuotaDisplay([cdp]);
      await hostBridge.publishHeartbeat();
      await publishCodexQuotaDisplay(cdp);
      if (shouldOpen && !reconciled.shouldRemainOpen) {
        await cdp.send("Runtime.evaluate", {
          expression: "window.__codexTaskboardInjection__?.open()",
          returnByValue: true,
        });
      }
      const shouldRemainOpen = shouldOpen || reconciled.shouldRemainOpen;
      const status = await waitForInjectionStatus(
        cdp,
        shouldRemainOpen,
        sourceHash,
        15_000,
        { heartbeat: () => hostBridge.publishHeartbeat() },
      );
      if (status.sourceHash !== sourceHash || !status.entryMounted) {
        await reportCandidateInjectionFailure(cdp, status, sourceHash, false);
        throw new Error("Taskboard sidebar entry did not mount in the Codex renderer");
      }
      const frameLoaded = status.frameUrl
        ? await waitForFrame(cdp, status.frameUrl, 15_000)
        : false;
      if (shouldRemainOpen && (!status.frameReady || !frameLoaded)) {
        await reportCandidateInjectionFailure(cdp, status, sourceHash, frameLoaded);
        throw new Error("Taskboard frame did not report ready in the Codex renderer");
      }
      await cdp.send("Page.setBypassCSP", { enabled: false });
      retained = true;
      return {
        result: {
          ...status,
          injected: true,
          quotaReadAttempted: cdp.taskboardQuotaReadAttempted === true,
          quotaReadState: cdp.taskboardQuotaReadState,
          compatibilityMode: compatibility.mode,
          compatibilityCapabilities: capabilities,
          ...(contractProbe ? { compatibilityChecks: contractProbe.checks } : {}),
          cspBypassed: false,
          frameLoaded,
        },
        connection: cdp,
      };
    }
    const scriptIdentifier = await registerInjectionSource(cdp, source);
    cdp.taskboardScriptIdentifier = scriptIdentifier;
    cdp.on("Page.loadEventFired", async () => {
      if (!(await revalidateLoadedRenderer(cdp, capabilities))) return;
      if (keepAlive) await hostBridge.install();
      await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
      if (keepAlive) await hostBridge.publishHeartbeat();
      if (keepAlive) await publishCodexQuotaDisplay(cdp);
    });
    await evaluateInjectionSource(cdp, source);
    await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
    if (keepAlive) {
      await hostBridge.publishHeartbeat();
      // The validated native quota bridge does not depend on iframe readiness.
      await refreshCodexQuotaDisplay([cdp]);
      await hostBridge.publishHeartbeat();
      await publishCodexQuotaDisplay(cdp);
    }
    const heartbeat = keepAlive ? () => hostBridge.publishHeartbeat() : null;
    const entryStatus = await waitForInjectionStatus(cdp, false, sourceHash, 60_000, { heartbeat });
    if (entryStatus.sourceHash !== sourceHash || !entryStatus.entryMounted) {
      await reportCandidateInjectionFailure(cdp, entryStatus, sourceHash, false);
      throw new Error("Taskboard sidebar entry did not mount in the Codex renderer");
    }
    if (shouldOpen) {
      if (heartbeat) await heartbeat();
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          taskboard?.close();
          taskboard?.open();
        })()`,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const status = await waitForInjectionStatus(cdp, shouldOpen, sourceHash, 15_000, { heartbeat });
    if (status.sourceHash !== sourceHash || !status.entryMounted) {
      await reportCandidateInjectionFailure(cdp, status, sourceHash, false);
      throw new Error("Taskboard sidebar entry did not mount in the Codex renderer");
    }
    const frameLoaded = status.frameUrl
      ? await waitForFrame(cdp, status.frameUrl, 15_000)
      : false;
    if (shouldOpen && (!status.frameReady || !frameLoaded)) {
      await reportCandidateInjectionFailure(cdp, status, sourceHash, frameLoaded);
      throw new Error("Taskboard frame did not report ready in the Codex renderer");
    }
    await cdp.send("Page.setBypassCSP", { enabled: false });
    const result = {
      ...status,
      injected: true,
      quotaReadAttempted: cdp.taskboardQuotaReadAttempted === true,
      quotaReadState: cdp.taskboardQuotaReadState,
      compatibilityMode: compatibility.mode,
      compatibilityCapabilities: capabilities,
      ...(contractProbe ? { compatibilityChecks: contractProbe.checks } : {}),
      cspBypassed: false,
      frameLoaded,
    };
    if (screenshotPath) {
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
      result.screenshot = screenshotPath;
    }
    retained = keepAlive;
    return { result, connection: retained ? cdp : null };
  } finally {
    if (!retained) {
      if (injectionStarted) await detachInjection(cdp, { audit: true });
      else cdp.close();
    }
  }
}

async function injectAll(
  runtime,
  shouldOpen,
  screenshotPath,
  injectedTargets,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
  compatibility,
  rejectedTargets,
  sidebarDiagnosticOnly = false,
) {
  const targets = await runtime.targets();
  if (targets.length === 0) {
    if (keepAlive) return [];
    throw new Error("No Codex renderer target found");
  }

  const activeIds = new Set(targets.map((target) => target.id));
  for (const [id, connection] of injectedTargets) {
    if (!activeIds.has(id) || connection.closed) {
      await detachInjection(connection);
      injectedTargets.delete(id);
    }
  }
  for (const id of rejectedTargets.keys()) {
    if (!activeIds.has(id)) rejectedTargets.delete(id);
  }

  const results = [];
  for (const [targetIndex, target] of targets.entries()) {
    if (injectedTargets.has(target.id)) continue;
    const rejected = rejectedTargets.get(target.id);
    if (!rejectedTargets.shouldProbe(target.id)) continue;
    const firstTarget = injectedTargets.size === 0
      && !results.some((result) => result.injected === true);
    const { result, connection, rejectionConnection } = await injectTarget(
      runtime,
      target,
      shouldOpen && firstTarget,
      firstTarget ? screenshotPath : null,
      keepAlive,
      supervisor,
      attachExisting,
      startupToken,
      compatibility,
      sidebarDiagnosticOnly,
    );
    if (connection) {
      injectedTargets.set(target.id, connection);
      rejectedTargets.delete(target.id);
    } else if (result.injected === false) {
      if (sidebarDiagnosticOnly) {
        const fingerprint = JSON.stringify({
          checks: result.compatibilityChecks,
          structure: result.sidebarDiagnostic,
        });
        if (rejected?.diagnosticFingerprint !== fingerprint
          && (rejected?.diagnosticCount || 0) < 2) {
          console.log(JSON.stringify({
            sidebarDiagnostic: result.sidebarDiagnostic,
            compatibilityChecks: result.compatibilityChecks,
            diagnosticUnavailable: result.sidebarDiagnostic === null,
            candidateOrdinal: targetIndex + 1,
          }));
          result.diagnosticFingerprint = fingerprint;
          result.diagnosticCount = (rejected?.diagnosticCount || 0) + 1;
        }
      }
      rejectedTargets.remember(target.id, rejectionConnection, {
        diagnosticFingerprint: result.diagnosticFingerprint || rejected?.diagnosticFingerprint,
        diagnosticCount: result.diagnosticCount || rejected?.diagnosticCount || 0,
        reason: result.compatibilityReason,
      }, injectedTargets.size === 0);
    }
    results.push(result);
  }
  return results;
}

async function currentInjectionSource(capabilities) {
  const [quotaDisplayScript, userScript] = await Promise.all([
    capabilities.quotaDisplay ? readFile(quotaDisplayPath, "utf8") : Promise.resolve(""),
    readFile(injectionPath, "utf8"),
  ]);
  const runtimeSource = `window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ = ${JSON.stringify(taskboardOrigin)};
window.__CODEX_TASKBOARD_HOST_CAPABILITY__ = ${JSON.stringify(hostCapability)};
window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(taskboardPageUrl)};
if (window.__CODEX_TASKBOARD_COMPATIBILITY_CAPABILITIES__.quotaDisplay) {
${quotaDisplayScript}
}
${userScript}`;
  const guardedSource = guardRendererInjectionSource(runtimeSource, capabilities);
  const sourceHash = createHash("sha256").update(guardedSource).digest("hex");
  return {
    sourceHash,
    source: guardRendererInjectionSource(
      `window[${JSON.stringify(injectionSourceHashName)}] = ${JSON.stringify(sourceHash)};\n${runtimeSource}`,
      capabilities,
    ),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.startupToken ??= taskboardInstanceToken;
  process.env.CODEX_EXECUTABLE = resolveCodexExecutable({ appPath: options.appPath });

  let codexProcess = null;
  let cdpRuntime = null;
  let runtimePublishPromise = null;
  let idleAfterNormalExit = false;
  let rendererWaitStartedAt = 0;
  let rendererWaitReportAt = 0;
  let rendererSeen = false;
  let injectedOnce = false;
  let stopping = false;
  let openControl = null;
  let openRequestGeneration = options.open ? 1 : 0;
  let openedRequestGeneration = 0;
  const injectedTargets = new Map();
  const rejectedTargets = new RendererRejectionCache();
  let wakeStop;
  const stopRequested = new Promise((resolve) => { wakeStop = resolve; });
  const hasOpenPending = () => openedRequestGeneration < openRequestGeneration;
  const queueTaskboardOpen = () => {
    openRequestGeneration += 1;
    console.log(JSON.stringify({ openTaskboardSignalQueued: true }));
  };

  const supervisor = createTaskboardSupervisor({
    detached: !options.watch,
    isReachable: isTaskboardReachable,
    waitUntilReachable: waitUntilTaskboardReachable,
    start: () => startTaskboard({ detached: !options.watch }),
    onProcessError: (error) => console.error(`Taskboard process error: ${error.message}`),
    onUnexpectedExit: (code, signal) => {
      console.error(`Taskboard exited (${signal || code}); it will be restarted automatically.`);
    },
  });

  const publishRuntime = async () => {
    const pending = publishTaskboardRuntime();
    runtimePublishPromise = pending;
    try {
      await pending;
    } finally {
      if (runtimePublishPromise === pending) runtimePublishPromise = null;
    }
  };

  const requestTaskboardOpen = async () => {
    const generation = openRequestGeneration;
    if (generation <= openedRequestGeneration) return true;
    const connection = injectedTargets.values().next().value;
    if (!connection) return false;
    try {
      const evaluation = await connection.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          if (typeof taskboard?.open !== "function") return false;
          taskboard.open();
          return true;
        })()`,
        returnByValue: true,
      });
      if (evaluation.result.value !== true) throw new Error("Taskboard injection is not ready");
      await connection.send("Page.bringToFront");
      openedRequestGeneration = Math.max(openedRequestGeneration, generation);
      return true;
    } catch (error) {
      console.error(`Waiting to open Taskboard: ${error.message}`);
      return false;
    }
  };

  const detachAll = async () => {
    await Promise.all([...injectedTargets.values()].map(detachInjection));
    injectedTargets.clear();
    rejectedTargets.clear();
  };

  const launchManagedCodex = async () => {
    if (options.windowsLoopbackCandidate || options.windowsRegistered) {
      startupAttemptId = randomUUID();
      rendererOrdinal = 0;
      emitQuotaTrace = createQuotaTraceBudget((trace) => logLaunchDiagnostic("quota-trace", { trace }));
      emitWorkbenchTrace = createWorkbenchTraceBudget((trace) => logLaunchDiagnostic("workbench-trace", { trace }));
      logLaunchDiagnostic("activation-started");
      try {
        const port = await reserveLoopbackPort();
        const activated = activateRegisteredCodex({ port, appPath: options.appPath,
          mode: options.windowsRegistered ? "launcher" : "source-test" });
        if (activated.packageVersion !== codexPackageVersion) {
          throw new Error("Registered Codex version changed during candidate startup");
        }
        logLaunchDiagnostic("activation-ready", { pid: activated.pid });
        logLaunchDiagnostic("spawn-returned", { pid: activated.pid });
        // The registered process is not our child. Never send it a kill signal.
        codexProcess = { pid: activated.pid, exitCode: null, signalCode: null, unref() {} };
        const processObserver = watchRegisteredProcess(activated.pid);
        if (!await processObserver.ready) {
          processObserver.close();
          throw new Error("Could not observe the registered Codex lifecycle");
        }
        cdpRuntime = createLoopbackCandidateRuntime(port, activated.pid, {
          processObserver,
          onDiscovery: (discovery) => logLaunchDiagnostic("renderer-discovery", discovery),
          onObservation: (state) => logLaunchDiagnostic("process-observation", state),
          onDiscoveryObservation: (state) => logLaunchDiagnostic("renderer-discovery-health", state),
        });
      } catch (error) {
        const reason = error.diagnosticReason === "codex-running" ? "codex-running" : "activation-failed";
        logLaunchDiagnostic(reason === "codex-running" ? "activation-refused" : "activation-failed", {
          reason, activationReason: error.activationReason, activationStage: error.activationStage,
        });
        throw error;
      }
    } else {
      const launched = await launchCodexWithPipe(options.appPath);
      codexProcess = launched.child;
      cdpRuntime = pipeCdpRuntime(launched.browser);
    }
    rejectedTargets.clear();
    idleAfterNormalExit = false;
    rendererWaitStartedAt = Date.now();
    rendererWaitReportAt = 0;
    rendererSeen = false;
    injectedOnce = false;
  };

  let cleanupPromise = null;
  const cleanup = ({ preserveCodex = false } = {}) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if ((options.windowsRegistered || options.windowsLoopbackCandidate) && cdpRuntime) {
        const exitCode = cdpRuntime.exitCode?.();
        if (Number.isInteger(exitCode)) {
          logLaunchDiagnostic("codex-exited", { pid: codexProcess?.pid, exitCode,
            exitCodeSource: "registered-process-handle" });
        } else {
          logLaunchDiagnostic("codex-observation-stopping", { pid: codexProcess?.pid, reason: "launcher-stopped" });
        }
      }
      await detachAll();
      cdpRuntime?.close();
      cdpRuntime = null;
      const pendingRuntimePublish = runtimePublishPromise;
      if (pendingRuntimePublish) {
        try { await pendingRuntimePublish; } catch {}
      }
      const serviceStop = options.sidebarDiagnosticOnly ? Promise.resolve() : supervisor.stop();
      const descriptorStop = options.sidebarDiagnosticOnly
        ? Promise.resolve() : removeTaskboardRuntime();
      const launchedCodex = codexProcess;
      codexProcess = null;
      if (launchedCodex && !options.windowsLoopbackCandidate && !options.windowsRegistered
        && launchedCodex.exitCode === null && launchedCodex.signalCode === null) {
        if (preserveCodex) {
          launchedCodex.unref();
          console.log(JSON.stringify({ codexDetachRequested: true, pid: launchedCodex.pid }));
        } else {
          const exit = new Promise((resolve) => launchedCodex.once("exit", resolve));
          launchedCodex.kill("SIGTERM");
          const exited = await Promise.race([
            exit.then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
          ]);
          if (!exited && launchedCodex.exitCode === null) launchedCodex.kill("SIGKILL");
        }
      }
      await Promise.all([serviceStop, descriptorStop]);
    })();
    return cleanupPromise;
  };

  let preserveCodexOnStop = false;
  const requestStop = ({ preserveCodex = false } = {}) => {
    if (stopping) return;
    preserveCodexOnStop = preserveCodex;
    stopping = true;
    wakeStop();
  };
  const requestSignalStop = () => requestStop();

  if (options.watch) {
    if (!options.windowsLoopbackCandidate) {
      openControl = createInterface({ input: process.stdin, terminal: false });
      openControl.on("line", (line) => {
        if (line.trim() === "open") queueTaskboardOpen();
        else if (line.trim() === "stop") requestStop();
        else if (line.trim() === "stop-keep-codex") requestStop({ preserveCodex: true });
      });
      openControl.on("close", () => requestStop({ preserveCodex: true }));
      console.log(JSON.stringify({ openTaskboardSignalReady: true }));
    }
    process.once("SIGINT", requestSignalStop);
    process.once("SIGTERM", requestSignalStop);
  }

  try {
    if (!options.sidebarDiagnosticOnly) {
      await supervisor.ensure({ force: true });
      await publishRuntime();
    }

    if (codexCompatibility.mode === "shortcut-plugin-only") {
      if (options.windowsRegistered || options.windowsLoopbackCandidate) {
        const activated = activateRegisteredCodex({ appPath: options.appPath, mode: "ordinary" });
        logLaunchDiagnostic("spawn-returned", { pid: activated.pid });
        console.log(JSON.stringify({ compatibilityMode: "shortcut-plugin-only", codexPackageVersion,
          compatibilityReason: codexCompatibility.reason, minimumVersion: minimumWindowsCodexVersion }));
        return;
      }
      const fallback = spawn(codexExecutablePath(options.appPath), [], {
        detached: true,
        env: withoutTaskboardLauncherEnvironment(process.env),
        stdio: "ignore",
        windowsHide: process.platform === "win32",
      });
      fallback.once("error", (error) => {
        console.error(`Codex launch failed (${error.code || "unknown"}); restart Taskboard to revalidate the installed package.`);
        requestStop({ preserveCodex: true });
      });
      fallback.unref();
      console.log(JSON.stringify({
        compatibilityMode: "shortcut-plugin-only",
        codexPackageVersion,
        compatibilityReason: codexCompatibility.reason,
        minimumVersion: minimumWindowsCodexVersion,
      }));
      if (options.watch) await stopRequested;
      return;
    }

    console.log(JSON.stringify({
      compatibilityMode: "contract-probe",
      codexPackageVersion,
      minimumVersion: minimumWindowsCodexVersion,
    }));
    await launchManagedCodex();

    while (!stopping) {
      if (!idleAfterNormalExit && cdpRuntime?.isHealthy()) {
        try {
          const openThisPass = hasOpenPending();
          const results = await injectAll(
            cdpRuntime,
            openThisPass,
            options.screenshot,
            injectedTargets,
            true,
            supervisor,
            false,
            options.startupToken,
            codexCompatibility,
            rejectedTargets,
            options.sidebarDiagnosticOnly,
          );
          if (results.length > 0 || injectedTargets.size > 0) rendererSeen = true;
          const rendererWaitMs = Date.now() - rendererWaitStartedAt;
          if (!injectedOnce && rendererWaitMs >= rendererDiscoveryTimeoutMs) {
            logLaunchDiagnostic("renderer-timeout", { pid: codexProcess?.pid });
            process.exitCode = 1;
            requestStop({ preserveCodex: true });
            continue;
          }
          if (!rendererSeen && rendererWaitMs >= rendererWaitReportAt + 20_000) {
            rendererWaitReportAt = rendererWaitMs;
            logLaunchDiagnostic("renderer-waiting", {
              pid: codexProcess?.pid,
              elapsedSeconds: Math.floor(rendererWaitMs / 1_000),
            });
          }
          for (const result of results) {
            if (result.injected === true) injectedOnce = true;
            logLaunchDiagnostic("injection-result", {
              pid: codexProcess?.pid,
              injected: result.injected === true,
              frameLoaded: result.frameLoaded === true,
            });
            console.log(JSON.stringify({
              rendererInjection: {
                injected: result.injected === true,
                compatibilityMode: result.compatibilityMode,
                compatibilityReason: result.compatibilityReason,
                compatibilityChecks: result.compatibilityChecks,
                compatibilityCapabilities: result.compatibilityCapabilities,
                frameLoaded: result.frameLoaded === true,
                cspBypassed: result.cspBypassed === true,
                entryMounted: result.entryMounted === true,
                quotaMounted: result.quotaDisplay?.mounted === true,
                quotaFresh: result.quotaDisplay?.freshness === "fresh",
                quotaReadAttempted: result.quotaReadAttempted === true,
                quotaAccountReadComplete: result.quotaReadState?.accountReadComplete === true,
                quotaRateLimitsReadComplete: result.quotaReadState?.rateLimitsReadComplete === true,
                quotaNormalized: result.quotaReadState?.normalized === true,
                quotaDirectNavigationChild: result.quotaDirectNavigationChild === true,
                scrollDirectNavigationChild: result.scrollDirectNavigationChild === true,
              },
            }));
          }
          if (!options.sidebarDiagnosticOnly) {
            await refreshCodexQuotaDisplay([...injectedTargets.values()]);
          }
          if (openThisPass && results.some((result) => result.injected === true)) {
            openedRequestGeneration = openRequestGeneration;
          } else if (hasOpenPending()) {
            await requestTaskboardOpen();
          }
        } catch (error) {
          console.error(`Waiting for Codex renderer: ${error.message}`);
        }
      }

      if (!options.watch) {
        codexProcess?.unref();
        return;
      }

      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 2_000)),
        stopRequested,
      ]);
      if (stopping) break;

      if (options.sidebarDiagnosticOnly) {
        if (!cdpRuntime?.isHealthy()) requestStop({ preserveCodex: true });
        continue;
      }

      try {
        const service = await supervisor.ensure();
        if (service.restarted) await publishRuntime();
        const response = await fetch(`${taskboardBaseUrl}/api/local/launcher/open-request/take`, {
          method: "POST",
          signal: AbortSignal.timeout(1_500),
        });
        if (response.ok && (await response.json()).requested) queueTaskboardOpen();
      } catch (error) {
        console.error(`Waiting for Taskboard service: ${error.message}`);
      }

      for (const connection of injectedTargets.values()) {
        try { await connection.hostBridge?.publishHeartbeat(); } catch {}
      }
      await refreshCodexQuotaDisplay([...injectedTargets.values()]);

      if (idleAfterNormalExit) {
        if (hasOpenPending()) await launchManagedCodex();
        continue;
      }

      if (!cdpRuntime?.isHealthy()) {
        const exitCode = cdpRuntime?.exitCode?.() ?? codexProcess?.exitCode;
        const codexPid = codexProcess?.pid;
        if (options.windowsRegistered || options.windowsLoopbackCandidate) {
          if (Number.isInteger(exitCode)) {
            logLaunchDiagnostic("codex-exited", { pid: codexPid, exitCode,
              exitCodeSource: "registered-process-handle" });
          } else {
            logLaunchDiagnostic("codex-exit-unobserved", { pid: codexPid, reason: "connection-lost" });
          }
        }
        await detachAll();
        cdpRuntime?.close();
        cdpRuntime = null;
        codexProcess = null;
        if (options.sidebarDiagnosticOnly) {
          requestStop({ preserveCodex: true });
        } else if ((options.windowsRegistered || options.windowsLoopbackCandidate)
          && managedCodexExitAction(exitCode, injectedOnce) === "idle") {
          requestStop({ preserveCodex: true });
        } else if (!options.windowsLoopbackCandidate && !options.windowsRegistered
          && managedCodexExitAction(exitCode, injectedOnce) === "idle") {
          idleAfterNormalExit = true;
          console.error("Waiting after normal Codex exit; use the tray or plugin to restart it.");
        } else {
          openedRequestGeneration = openRequestGeneration;
          logLaunchDiagnostic("startup-failed", {
            pid: codexPid,
            exitCode,
            reason: exitCode === 0 ? "before-injection" : "connection-lost",
          });
          console.error("Codex did not complete Agent Desk startup; automatic retries stopped.");
          process.exitCode = 1;
          requestStop({ preserveCodex: exitCode === null });
        }
      }
    }
  } finally {
    if (options.windowsLoopbackCandidate && !options.sidebarDiagnosticOnly
      && !injectedOnce && process.exitCode !== 1) {
      logLaunchDiagnostic("startup-failed", {
        pid: codexProcess?.pid,
        reason: "before-injection",
      });
      process.exitCode = 1;
    }
    if (options.watch) {
      process.removeListener("SIGINT", requestSignalStop);
      process.removeListener("SIGTERM", requestSignalStop);
      openControl?.close();
    }
    await cleanup({ preserveCodex: preserveCodexOnStop });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
