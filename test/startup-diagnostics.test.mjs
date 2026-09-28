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
