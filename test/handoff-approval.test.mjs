import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
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
