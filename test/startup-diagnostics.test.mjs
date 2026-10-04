import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  readRecentStartupDiagnostics,
  runStartupDiagnostics,
  sanitizeStartupDiagnostic,
} from "../shared/startup-diagnostics.mjs";

test("diagnostic reader drops fields outside the metadata allowlist", () => {
  const record = sanitizeStartupDiagnostic(JSON.stringify({
    launchDiagnostic: {
      event: "renderer-discovery",
      at: "2026-09-26T17:26:52.261Z",
      attemptId: "f1ed7d9f-cfa5-4e47-b760-d4352398218c",
      pid: 31824,
      total: 0,
      pages: 0,
      url: "app://private/page",
      token: "secret",
      account: { id: "private" },
    },
  }));
  assert.deepEqual(record, {
    event: "renderer-discovery",
    at: "2026-09-26T17:26:52.261Z",
    attemptId: "f1ed7d9f-cfa5-4e47-b760-d4352398218c",
    pid: 31824,
    total: 0,
    pages: 0,
  });
  assert.equal(sanitizeStartupDiagnostic('{"launchDiagnostic":{"event":"arbitrary"}}'), null);
  assert.deepEqual(sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
    event: "startup-failed", reason: "before-injection", pid: 31824, token: "secret",
  } })), { event: "startup-failed", pid: 31824, reason: "before-injection" });
  assert.deepEqual(sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
    event: "renderer-contract", compatible: false, reason: "renderer-contract-mismatch",
    checks: { sidebarScroll: false, pageMount: true, modernLink: true,
      modernReferenceInChosenScroll: false, account: "secret" },
    shape: { sameScroll: true, navigationButtons: 2, scrollLinks: 1,
      privateLabel: "secret", scrollButtons: 1001 },
    url: "app://private/page", token: "secret",
  } })), {
    event: "renderer-contract", compatible: false, reason: "renderer-contract-mismatch",
    checks: { sidebarScroll: false, pageMount: true, modernLink: true,
      modernReferenceInChosenScroll: false },
    shape: { sameScroll: true, navigationButtons: 2, scrollLinks: 1 },
  });
});

test("diagnostics command follows an append-only log without requiring the app window", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "agent-desk-diagnostics-"));
  const logDirectory = path.join(localAppData, "DashiTaskboard", "logs");
  const filePath = path.join(logDirectory, "agent-desk-startup.jsonl");
  const first = JSON.stringify({ launchDiagnostic: { event: "spawn-started", pid: 31824 } });
  const second = JSON.stringify({ launchDiagnostic: {
    event: "managed-process-after-injector-exit", pid: 31824, elapsedSeconds: 2, running: false,
  } });
  const output = new PassThrough();
  let printed = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { printed += chunk; });
  const controller = new AbortController();
  try {
    await mkdir(logDirectory, { recursive: true });
    await writeFile(filePath, `${first}\n`);
    assert.equal((await readRecentStartupDiagnostics(filePath)).length, 1);
    const running = runStartupDiagnostics(["--last", "1", "--follow", "--json"], {
      localAppData, output, signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(filePath, second.slice(0, 35));
    await new Promise((resolve) => setTimeout(resolve, 600));
    await appendFile(filePath, `${second.slice(35)}\n`);
    const deadline = Date.now() + 3_000;
    while (!printed.includes("managed-process-after-injector-exit") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.abort();
    assert.equal(await running, 0);
    const lines = printed.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.event), [
      "spawn-started", "managed-process-after-injector-exit",
    ]);
    assert.equal(lines[1].running, false);
  } finally {
    controller.abort();
    output.destroy();
    await rm(localAppData, { recursive: true, force: true });
  }
});

test("activation, refusal and observer records remain visible with only fixed metadata", () => {
  assert.deepEqual(sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
    event: "activation-failed", activationStage: "process-validation", activationReason: "path-mismatch",
    raw: "private exception", path: "private path",
  } })), { event: "activation-failed", activationStage: "process-validation", activationReason: "path-mismatch" });
  assert.deepEqual(sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
    event: "activation-failed", activationStage: "private path", activationReason: "private exception",
  } })), { event: "activation-failed" });
  for (const event of ["activation-started", "activation-ready", "activation-refused",
    "activation-failed", "launcher-start-refused", "codex-exit-unobserved", "codex-observation-stopping"]) {
    const record = sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
      event, reason: "codex-running", stderr: "private exception", path: "private path",
      url: "secret-url", token: "secret-token",
    } }));
    assert.deepEqual(record, { event, reason: "codex-running" });
  }
  for (const exitCode of [0, 7, -1073741819, 3221225477]) {
    const record = sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
      event: "codex-exited", exitCode, exitCodeSource: "registered-process-handle",
    } }));
    assert.equal(record.exitCode, exitCode);
    assert.equal(record.exitCodeSource, "registered-process-handle");
  }
  const unknown = sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
    event: "codex-exit-unobserved", exitCode: null, exitCodeSource: "guessed-zero",
  } }));
  assert.deepEqual(unknown, { event: "codex-exit-unobserved" });
});

test("attempt selection filters before limiting and keeps follow on the chosen attempt", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "agent-desk-attempt-"));
  const directory = path.join(localAppData, "DashiTaskboard", "logs");
  const filePath = path.join(directory, "agent-desk-startup.jsonl");
  const first = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";
  const third = "33333333-3333-3333-3333-333333333333";
  const line = (attemptId, event) => JSON.stringify({ launchDiagnostic: { attemptId, event } }) + "\n";
  const controller = new AbortController();
  const output = new PassThrough();
  let printed = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { printed += chunk; });
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, line(first, "activation-started") + line(second, "activation-started")
      + line(first, "codex-exited") + line(second, "activation-ready"));
    await runStartupDiagnostics(["--attempt", first, "--last", "2", "--json"], { localAppData, output });
    assert.deepEqual(printed.trim().split("\n").map(JSON.parse).map((record) => record.attemptId), [first, first]);
    printed = "";
    const running = runStartupDiagnostics(["--latest-attempt", "--follow", "--json"], {
      localAppData, output, signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(filePath, line(third, "activation-started") + line(second, "codex-exited"));
    const deadline = Date.now() + 3000;
    while (!printed.includes("codex-exited") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.abort();
    assert.equal(await running, 0);
    const records = printed.trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map((record) => record.attemptId), [second, second, second]);
    assert.deepEqual(records.map((record) => record.event), ["activation-started", "activation-ready", "codex-exited"]);
  } finally {
    controller.abort();
    output.destroy();
    await rm(localAppData, { recursive: true, force: true });
  }
});
