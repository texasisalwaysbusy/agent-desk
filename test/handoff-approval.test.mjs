import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { validApprovalRequest } from "../scripts/handoff-approval.mjs";
import { handleHostBindingPayload } from "../scripts/codex-injector-runtime.mjs";

test("approval requests have no arbitrary command, database or executable parameters", () => {
  assert.equal(validApprovalRequest({ operation: "list", project: null }), true);
  for (const key of ["argv", "python", "mailbox", "approved", "human", "execute"]) {
    assert.equal(validApprovalRequest({ operation: "list", [key]: true }), false);
  }
  assert.equal(validApprovalRequest({ operation: "run", messageId: "a".repeat(36) }), false);
});

test("approval routing requires the current isolated execution context", async () => {
  let called = 0;
  const handlers = { isAuthorizedContext: (id) => id === 8,
    handoffApproval: async () => { called++; return { items: [] }; }, sendResponse: async () => {} };
  const payload = JSON.stringify({ id: "test", action: "handoff-approval", request: { operation: "list" } });
  await handleHostBindingPayload({ executionContextId: 7, payload }, handlers);
  assert.equal(called, 0);
  await handleHostBindingPayload({ executionContextId: 8, payload }, handlers);
  assert.equal(called, 1);
});

test("disconnected approval requests never dispatch and give approval-specific recovery guidance", async () => {
  const source = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
  const functions = source.slice(source.indexOf("  function hasLiveHostBinding()"), source.indexOf("  function requestHostEnsure("));
  const pending = new Map();
  const posted = [];
  const timers = [];
  let now = 10000;
  const context = vm.createContext({
    HOST_CAPABILITY: "fixture", HOST_HEARTBEAT_MAX_AGE_MS: 8000,
    HOST_REQUEST_TIMEOUT_MS: 20000, HOST_REQUEST_MESSAGE: "fixture-request",
    hostHeartbeatAt: 0, hostRequestSequence: 0, hostRequests: pending,
    Number, Promise, Date: { now: () => now },
    hostError: (message) => new Error(message),
    window: { location: { origin: "app://codex" },
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout() {}, postMessage: (message) => posted.push(message) },
  });
  vm.runInContext(functions, context);
  await assert.rejects(context.requestHost("handoff-approval", { request: { operation: "list" } }), /审批通道未连接.*刷新审批中心核对状态/);
  assert.equal(posted.length, 0);
  assert.equal(pending.size, 0);
  now = 0;
  const result = context.requestHost("handoff-approval", { request: { operation: "list" } });
  assert.equal(posted.length, 1);
  const rejection = assert.rejects(result, /审批通道没有响应.*不要重复提交/);
  timers[0]();
  await rejection;
  assert.equal(pending.size, 0);
});

test("approval UI uses workbench navigation, trusted clicks and no ordinary HTTP API", async () => {
  const component = await readFile(new URL("../web/src/components/ApprovalCenter.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  const host = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  assert.match(component, /event\.isTrusted/);
  assert.match(component, /mutation\.current/);
  assert.match(component, /等待接收方继续/);
  assert.match(app, /selectBoardView\("approvals"\)/);
  assert.match(host, /fullPanel/);
  assert.doesNotMatch(component, /fetch\(|setInterval|innerHTML|dangerouslySetInnerHTML/);
});
