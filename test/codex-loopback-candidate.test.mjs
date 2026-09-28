import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  CdpLoopbackConnection,
  activateRegisteredCodex,
  createLoopbackCandidateRuntime,
  reserveLoopbackPort,
  validateLoopbackTarget,
  watchRegisteredProcess,
} from "../scripts/codex-cdp-loopback-candidate.mjs";

test("the source candidate refuses activation without the explicit Windows opt-in", () => {
  assert.throws(() => activateRegisteredCodex({ port: 9233, appPath: "ignored" }),
    /explicit source-test opt-in/);
});

test("the candidate accepts only an exact loopback page target", () => {
  const target = {
    id: "ABC123",
    type: "page",
    webSocketDebuggerUrl: "ws://127.0.0.1:41415/devtools/page/ABC123",
  };
  assert.equal(validateLoopbackTarget(target, 41415), target.webSocketDebuggerUrl);
  for (const hostile of [
    { ...target, type: "browser" },
    { ...target, id: "DIFFERENT" },
    { ...target, webSocketDebuggerUrl: "ws://localhost:41415/devtools/page/ABC123" },
    { ...target, webSocketDebuggerUrl: "ws://127.0.0.1:41416/devtools/page/ABC123" },
    { ...target, webSocketDebuggerUrl: "ws://127.0.0.1:41415/devtools/page/ABC123?x=1" },
    { ...target, webSocketDebuggerUrl: "ws://127.0.0.1:41415@evil.example/devtools/page/ABC123" },
  ]) {
    assert.throws(() => validateLoopbackTarget(hostile, 41415));
  }
});

test("the candidate releases its randomly selected loopback reservation", async () => {
  const port = await reserveLoopbackPort();
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
});

test("the candidate CDP connection sends commands and dispatches events", async () => {
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open"));
    }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    emit(name, event = {}) {
      for (const listener of this.listeners.get(name) || []) listener(event);
    }
    send(data) {
      const command = JSON.parse(data);
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ id: command.id, result: { method: command.method } }),
      }));
    }
    close() { this.emit("close"); }
  }
  const connection = new CdpLoopbackConnection("ws://127.0.0.1/test", FakeWebSocket);
  assert.deepEqual(await connection.send("Page.enable"), { method: "Page.enable" });
  const received = [];
  const remove = connection.on("Page.loadEventFired", (event) => received.push(event));
  const waiting = connection.waitFor("Page.loadEventFired", 1000);
  connection.socket.emit("message", {
    data: JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 } }),
  });
  assert.deepEqual(await waiting, { timestamp: 1 });
  assert.deepEqual(received, [{ timestamp: 1 }]);
  remove();
  connection.close();
  connection.close();
  await assert.rejects(connection.send("Page.enable"), /closed/);
});

test("a close before the CDP socket opens rejects the readiness wait", async () => {
  class ClosingWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("close"));
    }
    addEventListener(name, listener) {
      this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
    }
    emit(name) {
      for (const listener of this.listeners.get(name) || []) listener();
    }
    close() { this.emit("close"); }
  }
  const connection = new CdpLoopbackConnection("ws://127.0.0.1/test", ClosingWebSocket);
  await assert.rejects(connection.ready, /closed/);
  connection.close();
});

test("an unopened socket times out and closes rather than stalling startup", async () => {
  class SilentWebSocket {
    addEventListener() {}
    close() { this.closed = true; }
  }
  const connection = new CdpLoopbackConnection("ws://127.0.0.1/test", SilentWebSocket, 10);
  await assert.rejects(connection.ready, /opening timed out/);
  assert.equal(connection.closed, true);
  assert.equal(connection.socket.closed, true);
});

const target = { id: "MAIN", type: "page", url: "app://codex/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:41415/devtools/page/MAIN" };

test("ownership loss rejects discovery and connection before any socket or fetch", async () => {
  const runtime = createLoopbackCandidateRuntime(41415, 123, {
    inspect: () => ({ processAlive: true, listenerOwned: false }),
    fetchTargets: () => assert.fail("must not fetch from an unowned listener"),
    connectSocket: () => assert.fail("must not connect to an unowned listener"),
  });
  await assert.rejects(runtime.targets(), /ownership changed/);
  await assert.rejects(runtime.connect(target), /ownership changed/);
  assert.equal(runtime.isHealthy(), false);
  assert.equal(runtime.processExited(), false);
  assert.equal(runtime.exitCode(), null);
  runtime.close();
});

test("discovery filters auxiliary pages and rechecks ownership before connect", async () => {
  let owned = true;
  const runtime = createLoopbackCandidateRuntime(41415, 123, {
    inspect: () => ({ processAlive: true, listenerOwned: owned }),
    fetchTargets: async () => ({ ok: true, json: async () => [target,
      { ...target, id: "OTHER", url: "https://example.com/" },
      { ...target, id: "OVERLAY", url: "app://codex/?initialRoute=%2Favatar-overlay" }] }),
    connectSocket: () => assert.fail("ownership changed after discovery"),
  });
  assert.deepEqual((await runtime.targets()).map((item) => item.id), ["MAIN"]);
  owned = false;
  await assert.rejects(runtime.connect(target), /ownership changed/);
  runtime.close();
});

test("a vanished PID has unknown exit status without an actual observation", async () => {
  const runtime = createLoopbackCandidateRuntime(41415, 123, {
    inspect: () => ({ processAlive: false, listenerOwned: false }),
    fetchTargets: () => assert.fail("an exited process has no targets"),
  });
  assert.deepEqual(await runtime.targets(), []);
  assert.equal(runtime.processExited(), true);
  assert.equal(runtime.exitCode(), null);
  runtime.close();
});

test("registered observation preserves actual zero and crash exit codes, never kills Codex", async () => {
  for (const code of [0, 1, -1073741819]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    let helperKilled = false;
    child.kill = () => { helperKilled = true; };
    const observer = watchRegisteredProcess(123, { start: (program, args, options) => {
      assert.equal(program, "powershell.exe");
      assert.equal(options.windowsHide, true);
      assert.doesNotMatch(args.join(" "), /Stop-Process|taskkill|TerminateProcess/);
      return child;
    } });
    child.stdout.write('{"watching":true}\n');
    assert.equal(await observer.ready, true);
    child.stdout.write(JSON.stringify({ exitCode: code }) + "\n");
    child.exitCode = 0; child.emit("close", 0);
    assert.equal(observer.exitCode(), code);
    assert.equal(observer.isHealthy(), true);
    const runtime = createLoopbackCandidateRuntime(41415, 123, { processObserver: observer });
    assert.equal(runtime.isHealthy(), false);
    assert.equal(runtime.exitCode(), code);
    runtime.close();
    assert.equal(helperKilled, false);
  }
});

test("an observation helper failure remains unknown and stops discovery", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 1;
  child.kill = () => assert.fail("already exited helper");
  const observer = watchRegisteredProcess(123, { start: () => child });
  child.emit("close", 1);
  assert.equal(await observer.ready, false);
  assert.equal(observer.exitCode(), null);
  const runtime = createLoopbackCandidateRuntime(41415, 123, { processObserver: observer });
  assert.equal(runtime.isHealthy(), false);
  runtime.close();
});
