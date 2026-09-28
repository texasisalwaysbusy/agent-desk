import { open } from "node:fs/promises";
import path from "node:path";

import { resolveDataRoot } from "./product-identity.mjs";

const maxReadBytes = 256 * 1024;
const allowedEvents = new Set([
  "spawn-started", "spawn-returned", "codex-exited", "cdp-output-ended",
  "cdp-handshake", "cdp-ready", "renderer-discovery", "renderer-waiting",
  "renderer-probe-start", "renderer-contract", "renderer-timeout",
  "injection-result", "startup-failed",
  "managed-process-after-injector-exit",
]);
const allowedStages = new Set(["browser-version", "target-discovery"]);

export function sanitizeStartupDiagnostic(line) {
  let source;
  try {
    source = JSON.parse(line)?.launchDiagnostic;
  } catch {
    return null;
  }
  if (!source || !allowedEvents.has(source.event)) return null;
  const result = { event: source.event };
  if (typeof source.at === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(source.at)
      && source.at.length <= 32 && Number.isFinite(Date.parse(source.at))) {
    result.at = source.at;
  } else if (Number.isSafeInteger(source.atMs) && source.atMs > 0 && source.atMs <= 8.64e15) {
    result.at = new Date(source.atMs).toISOString();
  }
  if (typeof source.attemptId === "string"
      && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(source.attemptId)) {
    result.attemptId = source.attemptId;
  }
  for (const key of ["agentDeskVersion", "codexVersion"]) {
    if (typeof source[key] === "string" && /^[\w.+-]{1,32}$/.test(source[key])) {
      result[key] = source[key];
    }
  }
  if (Number.isSafeInteger(source.pid) && source.pid > 0 && source.pid <= 0xffffffff) {
    result.pid = source.pid;
  }
  if (Number.isInteger(source.exitCode) && source.exitCode >= -65535 && source.exitCode <= 65535) {
    result.exitCode = source.exitCode;
  }
  for (const key of ["elapsedSeconds", "total", "pages", "appPages", "eligible"]) {
    if (Number.isInteger(source[key]) && source[key] >= 0 && source[key] <= 10_000) {
      result[key] = source[key];
    }
  }
  if (allowedStages.has(source.stage)) result.stage = source.stage;
  if ([
    "before-injection", "connection-lost", "renderer-contract-mismatch",
    "invalid-probe-result", "probe-evaluation-failed", "probe-transport-failed",
  ].includes(source.reason)) result.reason = source.reason;
  if (typeof source.compatible === "boolean") result.compatible = source.compatible;
  if (source.checks && typeof source.checks === "object") {
    result.checks = Object.fromEntries([
      "appProtocol", "topFrame", "sidebarScroll", "sidebar", "pageMount",
      "referenceButton", "nativeBridge", "legacyScroll", "modernScroll",
      "legacyReference", "modernButton", "modernLink", "modernReferenceInChosenScroll",
      "headerReference",
    ].filter((key) => typeof source.checks[key] === "boolean")
      .map((key) => [key, source.checks[key]]));
  }
  if (source.shape && typeof source.shape === "object") {
    result.shape = {
      ...(typeof source.shape.sameScroll === "boolean"
        ? { sameScroll: source.shape.sameScroll } : {}),
      ...Object.fromEntries([
        "navigationElements", "navigationButtons", "navigationLinks", "navigationRoleButtons",
        "scrollButtons", "scrollLinks", "scrollRoleButtons", "scrollSidebarItems",
        "scrollElements", "scrollDirectChildren",
      ].filter((key) => Number.isInteger(source.shape[key])
        && source.shape[key] >= 0 && source.shape[key] <= 1000)
        .map((key) => [key, source.shape[key]])),
    };
  }
  for (const key of ["running", "injected", "frameLoaded"]) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  return result;
}

async function readRange(filePath, position) {
  let file;
  try {
    file = await open(filePath, "r");
  } catch (error) {
    if (error.code === "ENOENT") return { text: "", next: 0, skipped: false };
    throw error;
  }
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, Math.min(position, size), size - maxReadBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), next: start + bytesRead, skipped: start > position };
  } finally {
    await file.close();
  }
}

async function readRecentWithPosition(filePath, limit) {
  const { text, next } = await readRange(filePath, 0);
  const lines = text.split(/\r?\n/);
  const partial = text.length > 0 && !text.endsWith("\n") ? lines.pop() : "";
  return {
    records: lines.map(sanitizeStartupDiagnostic).filter(Boolean).slice(-limit),
    position: next,
    partial,
  };
}

export async function readRecentStartupDiagnostics(filePath, limit = 30) {
  return (await readRecentWithPosition(filePath, limit)).records;
}

function parseOptions(args) {
  let follow = false;
  let json = false;
  let last = 30;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--follow") follow = true;
    else if (arg === "--json") json = true;
    else if (arg === "--last" && /^\d+$/.test(args[index + 1] ?? "")) {
      last = Number(args[++index]);
      if (last < 1 || last > 200) throw new Error("--last must be 1–200");
    } else if (arg === "--help") return { help: true };
    else throw new Error(`Unknown diagnostics option: ${arg}`);
  }
  return { follow, json, last };
}

function printRecord(record, json, output) {
  if (json) {
    output.write(`${JSON.stringify(record)}\n`);
    return;
  }
  const { at, event, attemptId, agentDeskVersion, codexVersion, ...details } = record;
  const values = Object.entries(details).map(([key, value]) => `${key}=${value}`).join(" ");
  output.write(`${at ?? "unknown-time"} ${event}${values ? ` ${values}` : ""}\n`);
}

export async function runStartupDiagnostics(args, {
  localAppData = process.env.LOCALAPPDATA,
  output = process.stdout,
  signal,
} = {}) {
  const options = parseOptions(args);
  if (options.help) {
    output.write("Usage: agentdesk diagnostics [--last 1–200] [--follow] [--json]\n");
    return 0;
  }
  const root = resolveDataRoot(localAppData);
  const filePath = path.join(root, "logs", "agent-desk-startup.jsonl");
  const { records, position: initialPosition, partial: initialPartial } =
    await readRecentWithPosition(filePath, options.last);
  for (const record of records) printRecord(record, options.json, output);
  if (!options.follow) return 0;

  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    let position = initialPosition;
    let partial = initialPartial;
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const chunk = await readRange(filePath, position);
      if (chunk.next < position || chunk.skipped) partial = "";
      position = chunk.next;
      if (!chunk.text) continue;
      const lines = (partial + chunk.text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      if (partial.length > maxReadBytes) partial = "";
      for (const line of lines) {
        const record = sanitizeStartupDiagnostic(line);
        if (record) printRecord(record, options.json, output);
      }
    }
  } finally {
    process.off("SIGINT", stop);
    signal?.removeEventListener("abort", stop);
  }
  return 0;
}
