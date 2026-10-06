import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createLoopbackCandidateRuntime } from '../scripts/codex-cdp-loopback-candidate.mjs';
import { sanitizeStartupDiagnostic } from '../shared/startup-diagnostics.mjs';

const target = { id: 'MAIN', type: 'page', url: 'app://codex/index.html',
  webSocketDebuggerUrl: 'ws://127.0.0.1:41415/devtools/page/MAIN' };
function fixture() {
  const state = { time: 0, owned: true, alive: true, fetches: 0, sockets: 0,
    closes: 0, fault: null, observerExit: null, events: [] };
  const runtime = createLoopbackCandidateRuntime(41415, 123, {
    now: () => state.time,
    processObserver: { isHealthy: () => true, exitCode: () => state.observerExit, close() {} },
    inspect: async () => ({ processAlive: state.alive, listenerOwned: state.owned }),
    onDiscoveryObservation: event => state.events.push(event),
    fetchTargets: async (_url, options) => {
      state.fetches++;
      assert.equal(options.redirect, 'error');
      if (state.fault?.fetch) throw state.fault.fetch;
      return { ok: !state.fault?.status, status: state.fault?.status || 200,
        json: async () => { if (state.fault?.body) throw state.fault.body;
          return state.fault?.value ?? [target]; } };
    },
    connectSocket: () => { state.sockets++; return { ready: Promise.resolve(), close() { state.closes++; } }; },
  });
  return { state, runtime };
}
for (const phase of ['fetch', 'body']) {
  for (const fault of [new DOMException('private response', 'TimeoutError'),
    Object.assign(new TypeError('private socket'), { cause: { code: 'ECONNRESET' } })]) {
    test(`${phase} ${fault.name} preserves an existing socket, blocks new authority and recovers`, async () => {
      const { state, runtime } = fixture();
      try {
        await runtime.targets(); await runtime.connect(target);
        state.fault = { [phase]: fault };
        await assert.rejects(runtime.targets(), error => error.discoveryPending === true);
        assert.equal(runtime.isHealthy(), true); assert.equal(state.closes, 0);
        await assert.rejects(runtime.connect(target), error => error.discoveryPending === true);
        assert.equal(state.sockets, 1);
        const fetches = state.fetches;
        await assert.rejects(runtime.targets(), /deferred/); assert.equal(state.fetches, fetches);
        state.fault = null; state.time = 2000;
        assert.equal((await runtime.targets()).length, 1);
        assert.deepEqual(state.events.map(e => e.observation), ['timeout', 'recovered']);
        assert.equal(state.events[0].stage, phase === 'fetch' ? 'target-fetch' : 'target-body');
        assert.equal(state.events[1].elapsedMs, 2000);
        assert.doesNotMatch(JSON.stringify(state.events), /private|MAIN|app:\/\//);
        await runtime.connect(target); assert.equal(state.sockets, 2);
      } finally { runtime.close(); }
    });
  }
}

test('consecutive outages have backoff, a thirty-second deadline and no terminal recovery', async () => {
  const { state, runtime } = fixture();
  try {
    state.fault = { status: 503 };
    for (const time of [0, 2000, 6000, 14000, 22000]) {
      state.time = time; await assert.rejects(runtime.targets(), /deferred/);
    }
    state.time = 30000; state.fault = null;
    await assert.rejects(runtime.targets(), /unavailable/);
    assert.equal(state.fetches, 5); assert.equal(runtime.isHealthy(), false);
    await assert.rejects(runtime.connect(target), /unavailable/);
    assert.equal(state.sockets, 0);
    assert.deepEqual(state.events.map(e => e.observation), ['timeout','timeout','timeout','timeout','timeout','failed']);
  } finally { runtime.close(); }
});

test('recovery resets the incident budget; ownership loss during backoff is still terminal', async () => {
  const { state, runtime } = fixture();
  try {
    state.fault = { fetch: new DOMException('', 'TimeoutError') };
    await assert.rejects(runtime.targets(), /deferred/);
    state.time = 2000; state.fault = null; await runtime.targets();
    state.time = 100000; state.fault = { status: 503 };
    await assert.rejects(runtime.targets(), /deferred/);
    assert.equal(state.events.at(-1).discoveryFailures, 1);
    state.owned = false;
    await assert.rejects(runtime.targets(), /ownership changed/);
    state.owned = true; state.time = 102000;
    await assert.rejects(runtime.connect(target), /ownership changed/);
    assert.equal(state.sockets, 0); assert.equal(runtime.isHealthy(), false);
  } finally { runtime.close(); }
});

for (const fault of [{ status: 403 }, { body: new SyntaxError('private JSON') },
  { value: {} }, { value: Array(129).fill(target) }, { fetch: new Error('private failure') }]) {
  test(`invalid discovery is terminal without weakening its checks: ${Object.keys(fault)}`, async () => {
    const { state, runtime } = fixture();
    state.fault = fault;
    try { await assert.rejects(runtime.targets(), /Invalid or unavailable/);
      assert.equal(runtime.isHealthy(), false); assert.equal(state.events.length, 0);
      await assert.rejects(runtime.connect(target), /Invalid or unavailable/);
      assert.equal(state.sockets, 0);
    } finally { runtime.close(); }
  });
}

test('a real observed exit during discovery backoff retains its actual code', async () => {
  const { state, runtime } = fixture();
  try {
    state.fault = { status: 503 }; await assert.rejects(runtime.targets(), /deferred/);
    state.observerExit = 7;
    await assert.rejects(runtime.targets(), /observer stopped/);
    assert.equal(runtime.exitCode(), 7); assert.equal(runtime.isHealthy(), false);
    await assert.rejects(runtime.connect(target), /observer stopped/);
    assert.equal(state.sockets, 0);
  } finally { runtime.close(); }
});

test('closing during response body or socket opening invalidates late completion', async () => {
  for (const phase of ['body', 'socket']) {
    let release, closes = 0;
    const runtime = createLoopbackCandidateRuntime(41415, 123, {
      inspect: async () => ({ processAlive: true, listenerOwned: true }),
      fetchTargets: async () => ({ ok: true, json: () => new Promise(r => { release = () => r([target]); }) }),
      connectSocket: () => ({ ready: new Promise(r => { release = r; }), close() { closes++; } }),
    });
    const pending = phase === 'body' ? runtime.targets() : runtime.connect(target);
    while (!release) await new Promise(r => setImmediate(r));
    runtime.close(); release(); await assert.rejects(pending, /closed/);
    assert.equal(runtime.isHealthy(), false);
    if (phase === 'socket') assert.ok(closes >= 1);
  }
});

test('diagnostic producer and reader carry only bounded discovery metadata', async () => {
  assert.deepEqual(sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
    event: 'renderer-discovery-health', stage: 'target-body', observation: 'recovered',
    discoveryFailures: 2, elapsedMs: 6000, url: 'secret', targetId: 'secret', raw: 'secret',
  } })), { event: 'renderer-discovery-health', stage: 'target-body', observation: 'recovered', discoveryFailures: 2, elapsedMs: 6000 });
  assert.deepEqual(sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
    event: 'renderer-discovery-health', stage: 'secret', discoveryFailures: 7, elapsedMs: 30001,
  } })), { event: 'renderer-discovery-health' });
  const writer = await readFile(new URL('../scripts/codex-injector.mjs', import.meta.url), 'utf8');
  assert.match(writer, /onDiscoveryObservation: \(state\) => logLaunchDiagnostic\("renderer-discovery-health", state\)/);
  assert.match(writer, /"target-fetch", "target-body"/);
});

test('real HTTP and body deadlines leave event-loop heartbeats and existing connections alive', async () => {
  for (const phase of ['fetch', 'body']) {
    let stall = false, ticks = 0, time = 0, closes = 0;
    const server = createServer((_request, response) => {
      if (stall) { if (phase === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('['); } return; }
      response.end(JSON.stringify([target]));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const runtime = createLoopbackCandidateRuntime(41415, 123, {
      now: () => time, inspect: async () => ({ processAlive: true, listenerOwned: true }),
      fetchTargets: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/json/list`, options),
      connectSocket: () => ({ ready: Promise.resolve(), close() { closes++; } }),
    });
    const heartbeat = setInterval(() => ticks++, 20);
    try {
      await runtime.targets(); await runtime.connect(target); stall = true;
      await assert.rejects(runtime.targets(), e => e.discoveryPending === true);
      assert.equal(runtime.isHealthy(), true); assert.equal(closes, 0);
      assert.ok(ticks >= 20, 'Heartbeats ran while the bounded HTTP request was pending');
      stall = false; time = 2000; assert.equal((await runtime.targets()).length, 1);
    } finally { clearInterval(heartbeat); runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  }
});

test('auxiliary target churn does not close or reconnect an existing eligible target', async () => {
  const { state, runtime } = fixture();
  try {
    await runtime.targets(); await runtime.connect(target);
    for (const count of [6,8,9,10,9,12,8,10,12]) {
      state.fault = { value: [target, ...Array(count-1).fill({ type: 'worker', url: 'internal-fixture' })] };
      assert.equal((await runtime.targets()).length, 1);
      assert.equal(state.closes, 0); assert.equal(state.sockets, 1); assert.equal(runtime.isHealthy(), true);
    }
    assert.deepEqual(state.events, []);
  } finally { runtime.close(); }
});
