import { spawn } from "node:child_process";
import path from "node:path";

const reasons = new Set(["invalid-request", "process-unavailable", "tcp-table-error"]);
const stages = new Set(["helper-start", "process-handle", "listener-table", "listener-ipv4", "listener-ipv6"]);
// One bundled native child, one retained process handle, fresh TCP tables per request.
// No PowerShell/CIM startup, cached ownership, automatic helper respawn or transport fallback.
export function watchNativeRegisteredProcess(pid, port, {
  executable = path.join(path.dirname(process.execPath), "agent-desk-launcher.exe"),
  start = spawn, timeoutMs = 5_000, now = Date.now, onDiagnostic = () => {},
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff
      || !Number.isInteger(port) || port < 1024 || port > 65535
      || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== "agent-desk-launcher.exe") {
    throw new Error("Invalid native observation identity");
  }
  let buffer = "", sequence = 0, pending = null, exitCode = null;
  let failed = false, closing = false, watching = false, failureReason = null;
  let settleReady;
  const ready = new Promise(resolve => { settleReady = resolve; });
  const startupAt = now();
  const elapsed = startTime => Math.min(30_000, Math.max(0, now() - startTime));
  const error = (reason, stage, code = "OBSERVATION_FAILED") => Object.assign(
    new Error("Native registered process observation unavailable"), { code, reason, stage, backend: "native-tcp-table" });
  const fail = (reason, stage = "helper-protocol", extra = {}) => {
    if (closing || failed) return;
    const elapsedMs = pending ? elapsed(pending.started) : watching ? 0 : elapsed(startupAt);
    failed = true; failureReason = reason; clearTimeout(startupTimer); settleReady(false);
    if (pending) { clearTimeout(pending.timer); pending.reject(error(reason, stage)); pending = null; }
    onDiagnostic({ observation: "failed", reason, stage, backend: "native-tcp-table", observerPid: child.pid, elapsedMs, ...extra });
  };
  const child = start(executable, ["--agent-desk-observe", String(pid), String(port)], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const startupTimer = setTimeout(() => fail("helper-timeout", "helper-start"), timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.resume(); // Raw OS/helper text never enters diagnostics.
  child.stdin.on("error", () => fail("helper-exit"));
  child.stdout.on("data", chunk => {
    if (closing || failed) return;
    buffer += chunk;
    if (buffer.length > 4096) { fail("output-limit"); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line || line.length > 1024) { fail("output-limit"); return; }
      let value; try { value = JSON.parse(line); } catch { fail("helper-protocol"); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { fail("helper-protocol"); return; }
      const keys = Object.keys(value);
      if (value.event === "ready" && keys.length === 1 && !watching) {
        watching = true; clearTimeout(startupTimer); settleReady(true);
        onDiagnostic({ observation: "ready", backend: "native-tcp-table", observerPid: child.pid, stage: "helper-start", elapsedMs: elapsed(startupAt) });
      } else if (value.event === "exit" && watching && exitCode === null && keys.length === 2
          && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffffffff) {
        exitCode = value.exitCode;
        if (pending) { clearTimeout(pending.timer); pending.resolve({ processAlive: false, listenerOwned: false }); pending = null; }
      } else if (value.event === "fault" && keys.length === 3 && stages.has(value.stage) && reasons.has(value.reason)) {
        fail(value.reason, value.stage);
      } else if (value.event === "sample" && watching && Number.isInteger(value.id)
          && value.id > 0 && value.id <= sequence && stages.has(value.stage)
          && Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 30_000
          && keys.every(key => ["event", "id", "stage", "elapsedMs", "reason", "nativeCode", "processAlive", "listenerOwned"].includes(key))) {
        const good = typeof value.processAlive === "boolean" && typeof value.listenerOwned === "boolean"
          && keys.length === 6 && value.stage === "listener-table";
        const fault = value.reason === "tcp-table-error" && keys.length === 6
          && Number.isInteger(value.nativeCode) && value.nativeCode >= 0 && value.nativeCode <= 0xffffffff;
        if (!good && !fault) { fail("helper-protocol"); return; }
        // A timed-out response cannot satisfy a newer request or restore authority.
        if (!pending || pending.id !== value.id) continue;
        const request = pending; pending = null; clearTimeout(request.timer);
        if (fault) {
          const e = error(value.reason, value.stage); e.nativeCode = value.nativeCode;
          e.elapsedMs = elapsed(request.started); e.observationSequence = value.id; e.observerPid = child.pid;
          request.reject(e);
        } else request.resolve({ processAlive: value.processAlive, listenerOwned: value.listenerOwned,
          elapsedMs: elapsed(request.started), stage: value.stage, observationSequence: value.id, observerPid: child.pid, backend: "native-tcp-table" });
      } else { fail("helper-protocol"); return; }
    }
  });
  child.on("error", () => fail("helper-start-failed", "helper-start"));
  child.on("close", code => {
    if (!closing && exitCode === null) fail("helper-exit", "helper-protocol",
      Number.isInteger(code) ? { helperExitCode: code } : {});
  });
  return {
    ready, exitCode: () => exitCode, isHealthy: () => !failed,
    failureReason: () => failureReason,
    inspect() {
      if (closing || failed || !watching) return Promise.reject(error(failureReason || "helper-exit", "helper-protocol"));
      if (exitCode !== null) return Promise.resolve({ processAlive: false, listenerOwned: false });
      if (pending) return pending.promise; // Coalesce concurrent callers; no queue of probes.
      if (sequence >= 1_000_000_000) { fail("helper-protocol"); return Promise.reject(error("helper-protocol", "helper-protocol")); }
      const id = ++sequence, started = now(); let resolve, reject;
      const promise = new Promise((a,b) => { resolve = a; reject = b; });
      const timer = setTimeout(() => {
        if (pending?.id !== id) return;
        pending = null;
        const e = error("helper-timeout", "listener-table", "ETIMEDOUT"); e.elapsedMs = elapsed(started); e.observationSequence = id;
        e.observerPid = child.pid;
        reject(e);
      }, timeoutMs);
      pending = { id, started, promise, resolve, reject, timer };
      try { child.stdin.write(JSON.stringify({ id }) + "\n"); } catch { fail("helper-exit"); }
      return promise;
    },
    close() {
      if (closing) return;
      closing = true; clearTimeout(startupTimer); settleReady(false);
      if (pending) { clearTimeout(pending.timer); pending.reject(error("helper-exit", "helper-protocol")); pending = null; }
      child.stdin.end();
      if (child.exitCode === null) child.kill(); // Only the application-owned observer child.
    },
  };
}
