import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import {
  classifyWindowsCodexCompatibility,
  minimumWindowsCodexVersion,
  normalizeRendererContractProbe,
  probeRendererContract,
  rendererContractProbeExpression,
} from "../scripts/codex-renderer-compatibility.mjs";
import { managedCodexExitAction } from "../shared/codex-startup-state.mjs";
import { normalizeSidebarDiagnostic, sidebarDiagnosticExpression } from "../scripts/codex-sidebar-diagnostic.mjs";

test("a managed Codex exit cannot restart before the workbench was injected", () => {
  assert.equal(managedCodexExitAction(0, false), "stop");
  assert.equal(managedCodexExitAction(1, false), "stop");
  assert.equal(managedCodexExitAction(null, false), "stop");
  assert.equal(managedCodexExitAction(0, true), "idle");
  assert.equal(managedCodexExitAction(1, true), "stop");
});

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const supervisorSource = await readFile(
  new URL("../scripts/taskboard-supervisor.mjs", import.meta.url),
  "utf8",
);
const rateLimitsSource = await readFile(
  new URL("../scripts/codex-rate-limits.mjs", import.meta.url),
  "utf8",
);
const injectedUiSource = await readFile(
  new URL("../inject/codex-taskboard.user.js", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("Windows renderer compatibility probes every eligible version without a family allowlist", () => {
  assert.equal(minimumWindowsCodexVersion, "26.818.5229.0");
  assert.equal(classifyWindowsCodexCompatibility({
    platform: "win32",
    version: "26.820.7780.0",
  }).mode, "contract-probe");
  assert.equal(classifyWindowsCodexCompatibility({
    platform: "win32",
    version: "26.820.9563.0",
  }).mode, "contract-probe");
  assert.equal(classifyWindowsCodexCompatibility({
    platform: "win32",
    version: "26.818.9999.0",
  }).mode, "contract-probe");
  assert.equal(classifyWindowsCodexCompatibility({
    platform: "win32",
    version: "26.825.3734.0",
  }).mode, "contract-probe");
  assert.equal(classifyWindowsCodexCompatibility({
    platform: "win32",
    version: "26.826.1.0",
  }).mode, "contract-probe");
  assert.equal(classifyWindowsCodexCompatibility({
    platform: "win32",
    version: "unknown",
  }).mode, "shortcut-plugin-only");
  assert.match(source, /codexCompatibility\.mode === "shortcut-plugin-only"/);
  assert.match(source, /minimumVersion: minimumWindowsCodexVersion/);
  assert.doesNotMatch(source, /candidateFamilies|exactVersions|exact-version/);
});

test("candidate renderers are probed read-only before CSP bypass or injection", async () => {
  assert.match(rendererContractProbeExpression, /data-app-action-sidebar-scroll/);
  assert.match(rendererContractProbeExpression, /data-app-shell-main-content-layout/);
  assert.match(rendererContractProbeExpression, /electronBridge/);
  assert.doesNotMatch(
    rendererContractProbeExpression,
    /createElement|appendChild|insertAdjacent|setAttribute|\.click\(|localStorage|sessionStorage/,
  );
  const injectTargetSource = source.slice(
    source.indexOf("async function injectTarget"),
    source.indexOf("async function injectAll"),
  );
  assert.ok(
    injectTargetSource.indexOf("probeRendererContract")
      < injectTargetSource.indexOf('Page.setBypassCSP", { enabled: true }'),
  );

  const calls = [];
  const result = await probeRendererContract(async (method, params) => {
    calls.push({ method, params });
    return {
      result: {
        value: {
          schemaVersion: 1,
          checks: {
            appProtocol: true,
            topFrame: true,
            sidebarScroll: true,
            sidebar: true,
            pageMount: true,
            referenceButton: true,
            nativeBridge: true,
          },
          capabilities: {
            fullPanel: true,
            quotaDisplay: true,
            taskNavigation: true,
          },
        },
      },
    };
  }, { timeoutMs: 0 });
  assert.equal(result.compatible, true);
  assert.deepEqual(calls.map(({ method }) => method), ["Runtime.evaluate"]);
});

test("candidate renderer capability loss downgrades only the affected feature", () => {
  const partial = normalizeRendererContractProbe({
    schemaVersion: 1,
    checks: {
      appProtocol: true,
      topFrame: true,
      sidebarScroll: true,
      sidebar: true,
      pageMount: true,
      referenceButton: true,
      nativeBridge: false,
    },
    capabilities: {
      fullPanel: true,
      quotaDisplay: false,
      taskNavigation: false,
    },
  });
  assert.equal(partial.compatible, true);
  assert.deepEqual(partial.capabilities, {
    fullPanel: true,
    quotaDisplay: false,
    taskNavigation: false,
  });
  assert.match(source, /capabilities\.quotaDisplay \? readFile\(quotaDisplayPath/);
  assert.match(source, /taskboardCompatibilityCapabilities\?\.quotaDisplay !== false/);
  assert.match(source, /__CODEX_TASKBOARD_COMPATIBILITY_CAPABILITIES__/);
  assert.match(injectedUiSource, /COMPATIBILITY_CAPABILITIES\.taskNavigation === false/);
});

test("the resident injector authenticates its launcher-managed Taskboard service", () => {
  assert.match(supervisorSource, /function createTaskboardSupervisor/);
  assert.match(source, /CODEX_TASKBOARD_INSTANCE_TOKEN/);
  assert.match(source, /createHmac\("sha256"/);
  assert.match(source, /x-codex-taskboard-challenge/);
  assert.match(source, /proof/);
  assert.match(source, /taskboardInstanceSecret/);
  assert.match(source, /Page\.setDocumentContent/);
  assert.match(runtimeSource, /request\.action === "load-frame"/);
  assert.match(supervisorSource, /ensureInFlight/);
  assert.match(supervisorSource, /await terminateManagedChild\(managedChild\)/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
  assert.match(source, /__CODEX_TASKBOARD_FRAME_CAPABILITY__/);
  assert.match(runtimeSource, /request\.frameCapability/);
});

test("the CDP bridge accepts service ensure and native task conversation start actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "start-task-conversation"/);
  assert.match(runtimeSource, /request\.action === "open-external"/);
  assert.match(runtimeSource, /request\.taskId/);
  assert.match(runtimeSource, /request\.previousThreadId\.length <= 240/);
  assert.match(runtimeSource, /request\.codexHostId\.length <= 240/);
  assert.match(runtimeSource, /request\.targetRoot\.length <= 4_096/);
  assert.match(runtimeSource, /payload\.length > 4_194_304/);
  assert.match(runtimeSource, /request\.instruction\.length <= 4_000_000/);
  assert.match(runtimeSource, /request\.title\.length <= 240/);
  assert.match(source, /async function startTaskConversationViaCdp/);
  assert.match(source, /data-composer-placement="home"/);
  assert.match(source, /\(editor\.innerText \|\| ""\) !== \$\{JSON\.stringify\(instruction\)\}/);
  assert.doesNotMatch(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(
    source,
    /cdp\.send\("Input\.dispatchKeyEvent", \{\s*type: "keyDown",\s*key: "Enter"/,
  );
  assert.match(
    source,
    /cdp\.send\("Input\.dispatchKeyEvent", \{\s*type: "keyUp",\s*key: "Enter"/,
  );
  assert.match(source, /submitted = true/);
  assert.match(source, /if \(!submitted\) throw new Error/);
  assert.match(source, /const threadId = typeof started\.result\.value === "string"/);
  assert.match(source, /threadId && threadId !== previousThreadId/);
  assert.match(source, /discoveredThreadId = threadId/);
  assert.match(source, /error\.threadId = discoveredThreadId/);
  assert.match(source, /function requestCodexAppServerViaCdp/);
  assert.match(source, /type: "mcp-request"/);
  assert.match(source, /hostId: \$\{JSON\.stringify\(hostId\)\}/);
  assert.match(source, /"thread\/read"/);
  assert.match(source, /normalizeWorkspaceRoot\(result\.thread\.cwd\) === normalizedTargetRoot/);
  assert.match(source, /"thread\/name\/set"/);
  assert.match(source, /result\.thread\.name === title/);
  assert.match(source, /const taskConversationOperations = new Map\(\)/);
  assert.match(source, /taskConversationOperations\.get\(request\.taskId\)/);
  assert.match(source, /const taskConversationAppServerTimeoutMs = 30_000/);
  assert.doesNotMatch(source, /window\.postMessage\(\{ type: "rename-thread" \}/);
  assert.match(source, /return \{ threadId, title \}/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(source, /Page\.createIsolatedWorld/);
  assert.match(source, /Runtime\.addBinding", \{\s*name: hostBindingName,\s*executionContextId:/);
  assert.match(source, /params\.executionContextId !== activeContextId/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(runtimeSource, /threadId: error\.threadId/);
  assert.match(source, /hostResponseMessage/);
  assert.match(source, /if \(keepAlive\) await hostBridge\.install\(\)/);
  assert.match(source, /hostBridge\.publishHeartbeat/);
  assert.match(source, /withoutTaskboardLauncherEnvironment\(process\.env\)/);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("quota-aware automation reads sanitized limits through the signed-in Codex bridge", () => {
  assert.match(source, /async function readCodexQuotaStatusViaCdp/);
  assert.match(source, /"account\/read"/);
  assert.match(source, /\{ refreshToken: false \}/);
  assert.match(source, /"account\/rateLimits\/read"/);
  assert.match(source, /evaluateCodexRateLimits\(result, model, checkedAt\)/);
  assert.match(source, /readCodexQuotaStatusViaCdp\(request\.model, request\.codexHostId\)/);
  assert.doesNotMatch(rateLimitsSource, /node:child_process|\bspawn\(|resolveCodexExecutable/);
});

test("the embedded quota display reuses the private renderer bridge and never opens a debug port", () => {
  const displayNormalizerSource = rateLimitsSource.slice(
    rateLimitsSource.indexOf("const DISPLAY_SCHEMA_VERSION"),
    rateLimitsSource.indexOf("function normalizeName"),
  );
  assert.match(source, /quotaDisplayPath = path\.join\(projectRoot, "inject", "codex-quota-display\.user\.js"\)/);
  assert.match(source, /async function readCodexQuotaSnapshotForDisplay/);
  assert.match(source, /normalizeCodexRateLimitsForDisplay\(result, checkedAt\)/);
  assert.match(source, /"taskboard_quota_display"/);
  assert.match(source, /const method = quotaDisplaySnapshot \? "update" : quotaDisplayUnavailable \? "unavailable" : "heartbeat"/);
  assert.match(source, /quotaDisplayRefreshMs = 60_000/);
  assert.match(source, /quotaDisplayRetryDelaysMs = \[5_000, 15_000, 30_000\]/);
  assert.match(source, /quotaDisplayUnavailableAfterMs = 15 \* 60_000/);
  assert.match(source, /quotaDisplay: window\.__codexTaskboardQuotaDisplay__\?\.status\?\.\(\) \|\| null/);
  assert.doesNotMatch(source, /remote-debugging-port|remote-debugging-address|WebSocket\s*\(/);
  assert.doesNotMatch(
    displayNormalizerSource,
    /(?:value|result)\.(?:email|token|credits)|credits\.balance|auth\.json/,
  );
});

test("passive automation policy never converts a runtime pause into user intent", () => {
  assert.match(source, /taskboardAutomationPolicyOperation/);
  assert.match(source, /previousQuotaState: current\.quota\?\.state/);
  assert.match(source, /enqueueQuotaPolicyMutation\(record, rpc, \{ explicit: true \}\)/);
  assert.doesNotMatch(
    source,
    /result\.item\?\.status === "PAUSED"[\s\S]*?enabledByUser: false/,
  );
  assert.match(source, /record\.quota \? \{ quota: record\.quota \} : \{\}/);
});

test("restored automation policies also enforce a persisted off switch", () => {
  const restoreSource = source.slice(
    source.indexOf("async function restoreQuotaPolicies"),
    source.indexOf("async function startTaskConversationViaCdp"),
  );
  assert.match(restoreSource, /for \(const projectId of quotaPolicyRecords\.keys\(\)\)/);
  assert.match(restoreSource, /await enqueueCurrentQuotaPolicy\(projectId\)/);
  assert.doesNotMatch(restoreSource, /enabledByUser && record\.request\.quotaAware/);
});

test("persisted automation policies retain remote project identity", () => {
  const storedPolicySource = source.slice(
    source.indexOf("function storedAutomationPolicy"),
    source.indexOf("function restoredAutomationPolicy"),
  );
  assert.match(storedPolicySource, /codexProjectKind: request\.codexProjectKind/);
  assert.match(storedPolicySource, /codexHostId: request\.codexHostId/);
  assert.match(storedPolicySource, /remoteProjects: request\.remoteProjects/);
});

test("automation list rebuilds a stored policy on the incoming project identity", async () => {
  const reconcileSource = source.slice(
    source.indexOf("async function reconcileStoredAutomationPolicy"),
    source.indexOf("async function enqueueCurrentQuotaPolicy"),
  );
  const storedRequest = {
    taskboardProjectId: "taskboard-project",
    codexProjectId: "old-project",
    codexProjectKind: "local",
    codexHostId: "local",
    projectName: "Old project",
    workspacePath: "/old/project",
    skillPath: "/old/skill/SKILL.md",
    automationId: "automation-1",
    enabledByUser: true,
    quotaAware: true,
    intervalMinutes: 15,
    model: "gpt-5.5",
    reasoningEffort: "high",
  };
  const incomingRequest = {
    ...storedRequest,
    codexProjectId: "remote-project",
    codexProjectKind: "remote",
    codexHostId: "remote-host",
    projectName: "Remote project",
    workspacePath: "/remote/project",
    remoteProjects: [{
      codexProjectId: "remote-worktree",
      codexProjectKind: "remote",
      codexHostId: "remote-host",
      workspacePath: "/remote/project-worktree",
    }],
    skillPath: "/new/skill/SKILL.md",
    enabledByUser: false,
    quotaAware: false,
    intervalMinutes: 5,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  };
  let appliedRequest;
  const reconcileStoredAutomationPolicy = vm.runInNewContext(`(${reconcileSource})`, {
    ensureQuotaPoliciesLoaded: async () => {},
    quotaPolicyRecords: new Map([[
      storedRequest.taskboardProjectId,
      { request: storedRequest },
    ]]),
    updateAndApplyQuotaPolicy: async (request) => {
      appliedRequest = request;
      return { policy: request };
    },
    enqueueQuotaPolicyMutation: () => {
      throw new Error("stored target must not continue");
    },
    storedAutomationPolicy: (request) => request,
  });

  const result = await reconcileStoredAutomationPolicy(incomingRequest, () => {});
  assert.deepEqual(
    JSON.parse(JSON.stringify(appliedRequest)),
    {
      ...incomingRequest,
      automationId: "automation-1",
      enabledByUser: true,
      quotaAware: true,
      intervalMinutes: 15,
      model: "gpt-5.5",
      reasoningEffort: "high",
    },
  );
  assert.equal(result.policy, appliedRequest);
  assert.match(source, /reconcileStoredAutomationPolicy\(\s*request,\s*rpc/);
  assert.match(source, /policy: storedAutomationPolicy\(current\.request\)/);
});

test("automation list migrates one legacy cron to a fixed controller without replacing an existing runner", async () => {
  const reconcileSource = source.slice(
    source.indexOf("async function reconcileStoredAutomationPolicy"),
    source.indexOf("async function enqueueCurrentQuotaPolicy"),
  );
  const base = {
    taskboardProjectId: "taskboard-project",
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    projectName: "Project",
    workspacePath: "/project",
    remoteProjects: [],
    skillPath: "/skill/SKILL.md",
    automationId: "automation-1",
    enabledByUser: true,
    quotaAware: false,
    intervalMinutes: 15,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  };
  const run = async (storedRequest, incomingControllerThreadId) => {
    let appliedRequest;
    const reconcileStoredAutomationPolicy = vm.runInNewContext(`(${reconcileSource})`, {
      ensureQuotaPoliciesLoaded: async () => {},
      quotaPolicyRecords: new Map([[base.taskboardProjectId, { request: storedRequest }]]),
      updateAndApplyQuotaPolicy: async (request) => {
        appliedRequest = request;
        return { policy: request };
      },
      enqueueQuotaPolicyMutation: async () => ({ item: { id: base.automationId } }),
      storedAutomationPolicy: (request) => request,
    });
    await reconcileStoredAutomationPolicy(
      { ...base, controllerThreadId: incomingControllerThreadId },
      () => {},
    );
    return appliedRequest;
  };

  assert.equal(
    (await run(base, "controller-thread-1")).controllerThreadId,
    "controller-thread-1",
  );
  assert.equal(
    await run({ ...base, controllerThreadId: "controller-thread-existing" }, "controller-thread-new"),
    undefined,
  );
});

test("the package injection command uses only the private pipe launcher", () => {
  assert.match(packageJson.scripts.codex, /--launch --watch --open --cdp-pipe/);
  assert.equal(packageJson.scripts["codex:inject"], undefined);
  assert.equal(packageJson.scripts["codex:daemon"], undefined);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexTaskboardHostStartupTokenV1/);
  assert.doesNotMatch(packageJson.scripts.codex, /--port/);
  assert.match(source, /openControl\.on\("close", \(\) => requestStop\(\{ preserveCodex: true \}\)\)/);
});

test("noninteractive candidate stdin cannot stop startup, while managed stdin close still detaches", () => {
  const start = source.indexOf("  if (options.watch) {", source.indexOf("const requestSignalStop ="));
  const end = source.indexOf("\n  try {", start);
  assert.ok(start >= 0 && end > start);
  const setup = source.slice(start, end);
  const signals = [];
  const candidate = {
    options: { watch: true, windowsLoopbackCandidate: true },
    openControl: null,
    createInterface: () => { throw new Error("candidate must not bind stdin"); },
    process: { stdin: {}, once: (signal) => signals.push(signal) },
    requestSignalStop: () => {},
    requestStop: () => { throw new Error("candidate must not stop on stdin EOF"); },
    queueTaskboardOpen: () => {},
    console: { log: () => {} },
  };
  vm.runInNewContext(setup, candidate);
  assert.equal(candidate.openControl, null);
  assert.deepEqual(signals, ["SIGINT", "SIGTERM"]);

  const control = new EventEmitter();
  const stops = [];
  const managed = {
    ...candidate,
    options: { watch: true, windowsLoopbackCandidate: false },
    createInterface: () => control,
    requestStop: (value) => stops.push(value),
  };
  vm.runInNewContext(setup, managed);
  control.emit("close");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].preserveCodex, true);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexTaskboardInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /!target\.url\?\.includes\("initialRoute=%2Fglobal-dictation"\)/);
});

test("a completed web build does not attach to a running Codex", () => {
  assert.doesNotMatch(packageJson.scripts.build, /refresh|remote-debugging-port/);
  assert.equal(packageJson.scripts["codex:refresh"], undefined);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const taskboardBaseUrl = `\$\{taskboardOrigin\}\/\$\{encodeURIComponent\(taskboardInstanceToken\)\}`/);
  assert.match(source, /const taskboardPageUrl = `\$\{taskboardBaseUrl\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});

function failureReporter(candidate, logs) {
  const helpers = source.slice(
    source.indexOf("function injectionReadinessSummary"),
    source.indexOf("async function evaluateInjectionSource"),
  );
  const frameFinder = source.slice(
    source.indexOf("function findFrameByName"),
    source.indexOf("async function verifiedTaskboardDocument"),
  );
  return vm.runInNewContext(`${frameFinder}\n${helpers}\nreportCandidateInjectionFailure`, {
    process: { env: { AGENT_DESK_LOOPBACK_CANDIDATE: candidate ? "1" : "0" } },
    probeRendererContract,
    quotaDisplaySnapshot: null,
    normalizeSidebarDiagnostic,
    sidebarDiagnosticExpression,
    console: { error: (line) => logs.push(JSON.parse(line)) },
  });
}

test("frame failure structure probes stay outside the production path", async () => {
  const logs = [];
  const report = failureReporter(false, logs);
  await report({ send: () => { throw new Error("must not inspect a live document"); } },
    { sourceHash: "expected", frameUrl: "about:blank" }, "expected", true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].injectionReadiness.sourceActive, true);
  assert.equal(logs[0].injectionReadiness.frameLoaded, true);
  assert.equal(logs[0].injectionReadiness.frameReady, false);
  assert.ok(Object.values(logs[0].injectionReadiness).every((value) => typeof value === "boolean"));
});

test("candidate failure distinguishes a lost anchor from an unpopulated owned frame without content logs", async () => {
  const logs = [];
  const calls = [];
  const report = failureReporter(true, logs);
  const frameName = "codex-taskboard-11111111-2222-3333-4444-555555555555";
  const cdp = { send: async (method, params) => {
    calls.push({ method, params });
    if (method === "Runtime.evaluate" && params.expression === rendererContractProbeExpression) {
      return { result: { value: { schemaVersion: 1,
        checks: { appProtocol: true, topFrame: true, sidebar: true, sidebarScroll: true,
          pageMount: true, referenceButton: false, headerReference: false },
        capabilities: { fullPanel: true } } } };
    }
    if (method === "Runtime.evaluate" && params.expression === sidebarDiagnosticExpression) {
      return { result: { value: { schemaVersion: 1, visibleAsideCount: 1, asides: [],
        privateContent: "must never be logged" } } };
    }
    if (method === "Runtime.evaluate" && !params.contextId) {
      return { result: { value: frameName } };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "parent" }, childFrames: [
        { frame: { id: "owned-child", name: frameName } },
      ] } };
    }
    if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
    assert.equal(method, "Runtime.evaluate");
    assert.equal(params.contextId, 42);
    assert.doesNotMatch(params.expression, /innerHTML|textContent|outerHTML|\.click\(|setAttribute/);
    return { result: { value: { documentComplete: true, baseHostCodex: false,
      modulePresent: false, rootPresent: false, rootPopulated: false,
      privateContent: "must never be logged" } } };
  } };
  await report(cdp, { sourceHash: "expected", frameUrl: "about:blank" }, "expected", true);
  assert.deepEqual(logs[1].injectionFailureShape, {
    anchorProbeAvailable: true, childProbeAvailable: true, anchorCompatible: false,
    quotaReadAttempted: false, quotaSnapshotAvailable: false,
    quotaAccountReadComplete: false, quotaRateLimitsReadComplete: false, quotaNormalized: false,
    headerReference: false, sidebar: true, sidebarScroll: true, pageMount: true,
    childFrameMatched: true, documentComplete: true, baseHostCodex: false,
    modulePresent: false, rootPresent: false, rootPopulated: false,
  });
  assert.equal(calls.find((call) => call.method === "Page.createIsolatedWorld").params.frameId,
    "owned-child");
  assert.ok(Object.values(logs[1].injectionFailureShape).every((value) => typeof value === "boolean"));
  assert.doesNotMatch(JSON.stringify(logs), /must never|owned-child|11111111|about:blank/);
  assert.equal(logs[2].injectionSidebarShape.visibleAsideCount, 1);
});

test("candidate failure cannot inspect an unnamed or unrelated child frame", async () => {
  const logs = [];
  const report = failureReporter(true, logs);
  const methods = [];
  await report({ send: async (method, params) => {
    methods.push(method);
    assert.equal(method, "Runtime.evaluate");
    return params.expression === rendererContractProbeExpression
      ? { exceptionDetails: {} } : { result: { value: "unrelated-frame" } };
  } }, {}, "expected", false);
  assert.deepEqual(methods, ["Runtime.evaluate", "Runtime.evaluate"]);
  assert.deepEqual(logs[1].injectionFailureShape,
    { anchorProbeAvailable: false, childProbeAvailable: false,
      quotaReadAttempted: false, quotaSnapshotAvailable: false,
      quotaAccountReadComplete: false, quotaRateLimitsReadComplete: false, quotaNormalized: false });
});

test("startup waits keep the authenticated host heartbeat alive until the frame is ready", async () => {
  const waitSource = source.slice(source.indexOf("async function waitForInjectionStatus("),
    source.indexOf("function injectionReadinessSummary("));
  let now = 1000;
  const heartbeats = [];
  const wait = vm.runInNewContext(`(${waitSource})`, {
    Date: { now: () => now },
    setTimeout: (callback, delay) => { now += delay; queueMicrotask(callback); },
    readInjectionStatus: async () => ({ sourceHash: "expected", entryMounted: now >= 11000,
      pageVisible: true, frameUrl: "about:blank", frameReady: now >= 16000 }),
  });
  const status = await wait({}, true, "expected", 20000, {
    heartbeat: async () => { heartbeats.push(now); },
  });
  assert.equal(status.frameReady, true);
  assert.ok(heartbeats.length >= 7);
  assert.ok(heartbeats.every((at, index) => index === 0 || at - heartbeats[index - 1] <= 2250));
  assert.ok(now - heartbeats.at(-1) < 8000);
});

function startupHarness({ compatible = true, entryMounted = true } = {}) {
  const events = [];
  const hostBridge = {
    install: async () => { events.push("install-host"); },
    publishHeartbeat: async () => { events.push("heartbeat"); },
  };
  const cdp = {
    on() {},
    send: async (method, params) => {
      events.push(method === "Runtime.evaluate" && params.expression.includes("taskboard?.open")
        ? "open" : method);
      return { result: { value: null } };
    },
  };
  const targetSource = source.slice(source.indexOf("async function injectTarget("),
    source.indexOf("async function injectAll("));
  const run = vm.runInNewContext(`(${targetSource})`, {
    logLaunchDiagnostic() {},
    probeRendererContract: async () => ({ compatible, capabilities: {
      fullPanel: compatible, quotaDisplay: compatible, taskNavigation: compatible,
    } }),
    currentInjectionSource: async () => ({ source: "fixture", sourceHash: "expected" }),
    installTaskboardHostBinding: () => hostBridge,
    registerInjectionSource: async () => "registration",
    evaluateInjectionSource: async () => { events.push("source"); },
    publishInjectionScriptIdentifier: async () => {},
    refreshCodexQuotaDisplay: async ([connection]) => {
      assert.equal(connection, cdp);
      connection.taskboardQuotaReadAttempted = true;
      events.push("quota-read");
    },
    publishCodexQuotaDisplay: async () => { events.push("quota-publish"); },
    waitForInjectionStatus: async () => {
      events.push("wait");
      return { sourceHash: "expected", entryMounted, pageVisible: true,
        frameUrl: "about:blank", frameReady: true,
        quotaDisplay: { mounted: true, freshness: "fresh" } };
    },
    waitForFrame: async () => true,
    reportCandidateInjectionFailure: async () => { events.push("failure-summary"); },
    detachInjection: async () => { events.push("cleanup"); },
    setTimeout: (callback) => queueMicrotask(callback),
  });
  return { events, cdp, run: () => run({ connect: async () => cdp }, {}, true, null,
    true, {}, false, "startup", { mode: "contract-probe" }) };
}

test("validated startup reads quota before iframe readiness and renews heartbeat before opening", async () => {
  const harness = startupHarness();
  const result = await harness.run();
  assert.equal(result.result.injected, true);
  assert.equal(result.result.quotaReadAttempted, true);
  assert.equal(result.result.quotaDisplay.freshness, "fresh");
  assert.ok(harness.events.indexOf("quota-read") < harness.events.indexOf("wait"));
  assert.ok(harness.events.indexOf("quota-read") < harness.events.indexOf("open"));
  assert.equal(harness.events[harness.events.indexOf("open") - 1], "heartbeat");
  assert.equal(harness.events.includes("cleanup"), false);
});

test("missing entry stops before opening a blank frame; failed contracts never read quota", async () => {
  const missing = startupHarness({ entryMounted: false });
  await assert.rejects(missing.run(), /sidebar entry did not mount/);
  assert.equal(missing.events.includes("open"), false);
  assert.deepEqual(missing.events.slice(-2), ["failure-summary", "cleanup"]);
  const rejected = startupHarness({ compatible: false });
  rejected.cdp.close = () => { rejected.events.push("close"); };
  assert.equal((await rejected.run()).result.injected, false);
  assert.equal(rejected.events.includes("quota-read"), false);
  assert.equal(rejected.events.includes("Page.setBypassCSP"), false);
});

test("quota stage metadata distinguishes native read failures without retaining account responses", async () => {
  const quotaSource = source.slice(source.indexOf("async function readCodexQuotaSnapshotForDisplay("),
    source.indexOf("async function publishCodexQuotaDisplay("));
  const account = { account: { type: "chatgpt", privateField: "must-not-retain" } };
  const response = { privateField: "must-not-retain" };
  for (const failedStage of ["account", "rate-limits", "normalize", null]) {
    const read = vm.runInNewContext(`(${quotaSource})`, {
      Date,
      requestCodexAppServerViaCdp: async (_cdp, _context, _host, method) => {
        if (method === "account/read") {
          if (failedStage === "account") throw new Error("synthetic account failure");
          return account;
        }
        if (failedStage === "rate-limits") throw new Error("synthetic rate failure");
        return response;
      },
      normalizeCodexRateLimitsForDisplay: () => {
        if (failedStage === "normalize") throw new Error("synthetic schema failure");
        return { schemaVersion: 1, buckets: [] };
      },
    });
    const cdp = {};
    if (failedStage) await assert.rejects(read(cdp), /synthetic/);
    else await read(cdp);
    assert.deepEqual(JSON.parse(JSON.stringify(cdp.taskboardQuotaReadState)), {
      accountReadComplete: failedStage !== "account",
      rateLimitsReadComplete: failedStage === "normalize" || failedStage === null,
      normalized: failedStage === null,
    });
    assert.doesNotMatch(JSON.stringify(cdp), /must-not-retain|privateField|chatgpt/);
  }
});
