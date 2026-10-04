// Shared registered activation for the launcher and opt-in source experiment.
// CDP on loopback is not private:
// another local process can discover and control the official Codex listener.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const activationScript = path.join(path.dirname(fileURLToPath(import.meta.url)),
  "codex-registered-activation.ps1");

export function validateLoopbackTarget(target, port) {
  if (target?.type !== "page" || typeof target.id !== "string"
    || !/^[a-zA-Z0-9_-]{1,160}$/.test(target.id)
    || typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("Invalid page target from Codex CDP");
  }
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1"
    || url.port !== String(port)
    || url.pathname !== `/devtools/page/${target.id}`
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Rejected non-loopback or mismatched Codex CDP page target");
  }
  return url.href;
}

export async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export function activateRegisteredCodex({ port = 0, appPath, mode = "source-test" }, { run = execFileSync } = {}) {
  if (!["source-test", "launcher", "ordinary"].includes(mode)) throw new Error("Invalid activation mode");
  const launcherSelected = process.env.AGENT_DESK_WINDOWS_TRANSPORT === "registered-loopback";
  const sourceSelected = process.env.AGENT_DESK_LOOPBACK_CANDIDATE === "1";
  if (process.platform !== "win32" || (mode === "source-test" ? !sourceSelected
    : mode === "launcher" ? !launcherSelected : !sourceSelected && !launcherSelected)) {
    throw new Error("Windows loopback candidate requires explicit source-test opt-in");
  }
  if (!Number.isInteger(port) || (mode === "ordinary" ? port !== 0 : port < 1024 || port > 65535)) {
    throw new Error("Invalid candidate CDP port");
  }
  let output;
  try {
    output = run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-File",
      activationScript, "-Port", String(port), "-ExpectedPath", appPath, "-Mode", mode,
    ], { encoding: "utf8", windowsHide: true, timeout: 35_000,
      stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // Only a fixed helper marker becomes diagnostic metadata. Never forward
    // PowerShell output, executable paths or exception details to the log.
    let marker;
    const helperOutput = String(error.stdout ?? "").trim();
    if (helperOutput.length <= 512) {
      try { marker = JSON.parse(helperOutput); } catch {}
    }
    const activationReason = marker && !Array.isArray(marker)
      && Object.keys(marker).every((key) => ["activationFailure", "activationStage"].includes(key))
      && ["codex-running", "mode-not-selected", "invalid-port", "package-not-found", "manifest-missing",
        "package-identity-mismatch", "signature-invalid", "port-taken", "process-not-visible",
        "process-path-unavailable", "path-mismatch", "listener-misowned", "listener-timeout", "helper-error"]
        .includes(marker.activationFailure) ? marker.activationFailure : undefined;
    const activationStage = activationReason && ["selection", "package", "activation-preparation",
      "activation-call", "process-validation", "listener-validation"].includes(marker.activationStage)
      ? marker.activationStage : undefined;
    const refused = activationReason === "codex-running";
    const failure = new Error(refused
      ? "Codex 进程仍在运行。请正常退出 Codex；若刚退出，请等待数秒后从托盘重试。"
      : "Codex 注册激活失败。请查看启动诊断记录；自动重试已停止。");
    failure.diagnosticReason = refused ? "codex-running" : "activation-failed";
    if (activationReason) failure.activationReason = activationReason;
    if (activationStage) failure.activationStage = activationStage;
    throw failure;
  }
  const result = JSON.parse(output.trim());
  if (!Number.isInteger(result.pid) || result.pid <= 0
    || (mode !== "ordinary" && result.listenerOwned !== true) || result.identityVerified !== true
    || result.signaturesValid !== true) {
    throw new Error("Registered Codex activation did not verify its CDP listener");
  }
  return result;
}

export async function inspectLoopbackProcess(port, pid, { run = execFile } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error("Invalid registered process identity");
  }
  const script = `$ErrorActionPreference='Stop'; $process=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue); [pscustomobject]@{processAlive=($null -ne $process);listenerOwned=($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1' -and $listeners[0].OwningProcess -eq ${pid})} | ConvertTo-Json -Compress`;
  // Listener observation must not block the independent host heartbeat pump.
  const output = await new Promise((resolve, reject) => run("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 4096,
    }, (error, stdout) => {
      if (error) {
        // Never forward PowerShell's raw output, paths or command to diagnostics.
        reject(Object.assign(new Error("Registered process observation failed"), {
          code: error.killed || error.code === "ETIMEDOUT" ? "ETIMEDOUT" : "OBSERVATION_FAILED",
        }));
      } else resolve(stdout.trim());
    }));
  let result;
  try { result = JSON.parse(output); }
  catch { throw new Error("Invalid registered process observation"); }
  if (!result || typeof result.processAlive !== "boolean" || typeof result.listenerOwned !== "boolean") {
    throw new Error("Invalid registered process observation");
  }
  return result;
}

export function watchRegisteredProcess(pid, { start = spawn } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid registered process identity");
  // Retain a read-only Process handle before it exits, so an absent PID is not
  // mistaken for exit code zero. The helper never signals the registered app.
  const script = `$ErrorActionPreference='Stop'; $process=Get-Process -Id ${pid}; $null=$process.Handle; [Console]::Out.WriteLine('{"watching":true}'); $process.WaitForExit(); [pscustomobject]@{exitCode=$process.ExitCode} | ConvertTo-Json -Compress`;
  const child = start("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exitCode = null;
  let failed = false;
  let watching = false;
  let closing = false;
  let settleReady;
  const ready = new Promise((resolve) => { settleReady = resolve; });
  const timeout = setTimeout(() => { failed = true; settleReady(false); }, 5_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.length > 2048) { failed = true; settleReady(false); return; }
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.watching === true) {
          watching = true;
          clearTimeout(timeout);
          settleReady(true);
        } else if (watching && Number.isInteger(value.exitCode)) exitCode = value.exitCode;
        else failed = true;
      } catch { failed = true; }
    }
  });
  child.stderr.resume();
  child.on("error", () => { failed = true; clearTimeout(timeout); settleReady(false); });
  child.on("close", () => {
    clearTimeout(timeout);
    if (!closing && exitCode === null) failed = true;
    settleReady(watching && !failed);
  });
  return {
    ready,
    exitCode: () => exitCode,
    isHealthy: () => !failed,
    close() {
      if (closing) return;
      closing = true;
      clearTimeout(timeout);
      settleReady(false);
      if (child.exitCode === null) child.kill(); // Only our observation helper.
    },
  };
}

export class CdpLoopbackConnection {
  constructor(url, webSocketType = WebSocket, readyTimeoutMs = 5_000) {
    this.socket = new webSocketType(url);
    this.closed = false;
    this.sequence = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.waiters = new Map();
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Codex CDP WebSocket opening timed out"));
        this.close();
      }, readyTimeoutMs);
      const settle = (callback) => { clearTimeout(timeout); callback(); };
      this.socket.addEventListener("open", () => settle(resolve), { once: true });
      this.socket.addEventListener("error", () => settle(() => reject(new Error("Codex CDP WebSocket failed"))), { once: true });
      this.socket.addEventListener("close", () => settle(() => reject(new Error("Codex CDP WebSocket closed"))), { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => this.receive(data));
    this.socket.addEventListener("close", () => this.fail(new Error("Codex CDP WebSocket closed")));
    this.socket.addEventListener("error", () => this.fail(new Error("Codex CDP WebSocket failed")));
  }

  receive(data) {
    let message;
    try { message = JSON.parse(String(data)); }
    catch { this.fail(new Error("Invalid Codex CDP response")); return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error.message || "CDP error")));
      else pending.resolve(message.result);
      return;
    }
    const waiters = this.waiters.get(message.method) || [];
    this.waiters.delete(message.method);
    waiters.forEach(({ resolve }) => resolve(message.params));
    (this.handlers.get(message.method) || []).forEach((handler) => {
      try { Promise.resolve(handler(message.params)).catch(() => {}); } catch {}
    });
  }

  async send(method, params = {}) {
    await this.ready;
    if (this.closed) throw new Error("Codex CDP WebSocket closed");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP command ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.fail(error); }
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
    return () => this.handlers.set(method,
      (this.handlers.get(method) || []).filter((candidate) => candidate !== handler));
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.set(method,
          (this.waiters.get(method) || []).filter((item) => item.resolve !== wrappedResolve));
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const wrappedResolve = (value) => { clearTimeout(timeout); resolve(value); };
      const waiters = this.waiters.get(method) || [];
      waiters.push({ resolve: wrappedResolve, reject, timeout });
      this.waiters.set(method, waiters);
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timeout); item.reject(error); }
    this.pending.clear();
    for (const items of this.waiters.values()) items.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(error);
    });
    this.waiters.clear();
    this.handlers.clear();
    try { this.socket.close(); } catch {}
  }

  close() {
    if (this.closed) return;
    this.fail(new Error("Codex CDP WebSocket closed"));
  }
}

export function createLoopbackCandidateRuntime(port, pid, {
  onDiscovery = () => {}, inspect = inspectLoopbackProcess, fetchTargets = fetch,
  connectSocket = (url) => new CdpLoopbackConnection(url),
  processObserver = null,
  onObservation = () => {},
} = {}) {
  let healthy = true;
  let closed = false;
  let unknownCount = 0;
  let observation = "verified";
  let terminalError = null;
  let processExited = false;
  let previousDiscovery = null;
  const connections = new Set();
  const observe = async () => {
    if (closed) throw new Error("Codex runtime closed");
    if (terminalError) throw terminalError;
    if (processObserver && (!processObserver.isHealthy() || Number.isInteger(processObserver.exitCode()))) {
      healthy = false;
      throw new Error("Registered process observer stopped");
    }
    let state;
    try { state = await inspect(port, pid); }
    catch (error) {
      if (!closed && error.code === "ETIMEDOUT" && ++unknownCount < 3) {
        if (observation !== "timeout") onObservation({ observation: "timeout", observationFailures: unknownCount });
        observation = "timeout";
        throw Object.assign(new Error("Registered process observation timed out; discovery deferred"), { observationPending: true });
      }
      healthy = false;
      onObservation({ observation: "failed", observationFailures: Math.min(unknownCount, 3) });
      terminalError = new Error("Registered process observation unavailable");
      throw terminalError;
    }
    if (closed) throw new Error("Codex runtime closed");
    if (!state || typeof state.processAlive !== "boolean" || typeof state.listenerOwned !== "boolean") {
      healthy = false; terminalError = new Error("Invalid registered process observation"); throw terminalError;
    }
    if (!state.processAlive) { processExited = true; healthy = false; terminalError = new Error("Registered Codex exited"); return state; }
    if (!state.listenerOwned) { healthy = false; terminalError = new Error("Codex CDP listener ownership changed"); throw terminalError; }
    if (observation === "timeout") onObservation({ observation: "recovered", observationFailures: unknownCount });
    observation = "verified";
    unknownCount = 0;
    return state;
  };
  return {
    async targets() {
      try {
        const state = await observe();
        if (!state.processAlive) { processExited = true; healthy = false; return []; }
        if (!state.listenerOwned) throw new Error("Codex CDP listener ownership changed");
        const response = await fetchTargets(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(2_000), redirect: "error",
        });
        if (!response.ok) throw new Error("Codex CDP target discovery failed");
        const targets = await response.json();
        if (!Array.isArray(targets) || targets.length > 128) throw new Error("Invalid or excessive Codex CDP targets");
        const eligible = targets.filter((target) => target?.type === "page"
          && typeof target.url === "string"
          && target.url.startsWith("app://")
          && !target.url.includes("initialRoute=%2Fglobal-dictation")
          && !target.url.includes("initialRoute=%2Favatar-overlay"));
        const discovery = {
          total: targets.length,
          pages: targets.filter((target) => target?.type === "page").length,
          appPages: targets.filter((target) => target?.type === "page"
            && typeof target.url === "string" && target.url.startsWith("app://")).length,
          eligible: eligible.length,
        };
        const fingerprint = JSON.stringify(discovery);
        if (fingerprint !== previousDiscovery) {
          onDiscovery(discovery);
          previousDiscovery = fingerprint;
        }
        return eligible.map((target) => ({ ...target, targetId: target.id }));
      } catch (error) {
        if (!error.observationPending) { healthy = false; terminalError ??= error; }
        throw error;
      }
    },
    async connect(target) {
      const state = await observe();
      if (!state.processAlive) { processExited = true; healthy = false; throw new Error("Registered Codex exited"); }
      if (!state.listenerOwned) { healthy = false; throw new Error("Codex CDP listener ownership changed"); }
      const connection = connectSocket(validateLoopbackTarget(target, port));
      try { await connection.ready; }
      catch (error) { connection.close(); throw error; }
      connections.add(connection);
      connection.socket?.addEventListener("close", () => connections.delete(connection), { once: true });
      return connection;
    },
    isHealthy: () => healthy && (processObserver?.isHealthy() ?? true)
      && processObserver?.exitCode() == null,
    exitCode: () => processObserver?.exitCode() ?? null,
    processExited() {
      return processExited || Number.isInteger(processObserver?.exitCode());
    },
    close() {
      healthy = false;
      closed = true;
      processObserver?.close();
      for (const connection of connections) connection.close();
      connections.clear();
    },
  };
}
