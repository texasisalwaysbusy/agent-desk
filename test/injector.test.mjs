import assert from "node:assert/strict";
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
