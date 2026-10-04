import { sanitizeQuotaTrace } from "../shared/quota-trace.mjs";
import { sanitizeWorkbenchTrace } from "../shared/workbench-trace.mjs";

export function quotaTraceExpression(afterSequence, workbenchSequence = 0) {
  const after = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
  const workbenchAfter = Number.isSafeInteger(workbenchSequence) && workbenchSequence >= 0 ? workbenchSequence : 0;
  return `(() => {
    const appProtocol = location.protocol === "app:";
    const topFrame = window.top === window;
    if (!appProtocol || !topFrame) return {appProtocol, topFrame, apiPresent:false};
    const api = window.__codexTaskboardQuotaDisplay__;
    const workbench = window.__codexTaskboardInjection__;
    return {appProtocol, topFrame, apiPresent:typeof api?.diagnostics === "function",
      trace:typeof api?.diagnostics === "function" ? api.diagnostics(${after}) : null,
      workbench:typeof workbench?.diagnostics === "function" ? workbench.diagnostics(${workbenchAfter}) : null};
  })()`;
}

// Observes only an existing contract-validated managed connection. No discovery,
// attach, repair, heartbeat or quota RPC; a failed observation changes no policy.
export function createQuotaObserver(cdp, renderer, emit, {
  schedule = setTimeout, cancel = clearTimeout, intervalMs = 1000,
  emitWorkbench = () => {},
  reportHealth = () => {},
} = {}) {
  let disposed = false, timer = null, pending = null, generation = 0, sequence = 0;
  let lastPresence = null;
  let workbenchSequence = 0;
  let lastHealth = null;
  const write = (phase, extra = {}) => {
    try { emit(sanitizeQuotaTrace({ ...extra, phase, renderer, documentGeneration: generation })); } catch (_) {}
  };
  const capture = (value) => {
    if (disposed || !value || typeof value !== "object") return;
    const flags = sanitizeQuotaTrace({ appProtocol: value.appProtocol, topFrame: value.topFrame, apiPresent: value.apiPresent });
    const presence = JSON.stringify(flags);
    if (presence !== lastPresence) { write("sample", flags); lastPresence = presence; }
    if (flags.appProtocol === true && flags.topFrame === true) {
      const workbench = value.workbench;
      if (workbench?.schemaVersion === 1 && Number.isSafeInteger(workbench.sequence)
        && workbench.sequence >= 0 && workbench.sequence <= 1000000 && Array.isArray(workbench.events)) {
        if (workbench.sequence < workbenchSequence) workbenchSequence = 0;
        const latest = sanitizeWorkbenchTrace(workbench.events.at(-1));
        if (latest && latest.destroyed === false && typeof latest.active === "boolean"
          && Number.isSafeInteger(latest.sequence) && latest.sequence <= workbench.sequence
          && ["idle", "loading", "frame", "error"].includes(latest.phase)) {
          const health = !latest.active ? "inactive" : latest.phase === "error"
            || (latest.phase === "frame" && (latest.pageVisible === false || latest.frameVisible === false || latest.frameOccluded === true)) ? "error"
            : latest.frameReady && latest.frameConnected && latest.pageConnected && latest.hostBindingLive ? "ready" : "loading";
          if (health !== lastHealth) {
            lastHealth = health;
            try { reportHealth(health, renderer); } catch (_) {}
          }
        }
        for (const event of workbench.events.slice(-64).map(sanitizeWorkbenchTrace)) {
          if (!event || !Number.isSafeInteger(event.sequence)
            || event.sequence <= workbenchSequence || event.sequence > workbench.sequence) continue;
          const lostEvents = event.sequence - workbenchSequence - 1;
          try { emitWorkbench(sanitizeWorkbenchTrace({ ...event, renderer, documentGeneration: generation,
            ...(lostEvents > 0 ? { lostEvents } : {}) })); } catch (_) {}
          workbenchSequence = event.sequence;
        }
      }
    }
    if (flags.appProtocol !== true || flags.topFrame !== true || flags.apiPresent !== true) return;
    const trace = value.trace;
    if (trace?.schemaVersion !== 1 || !Number.isSafeInteger(trace.sequence) || trace.sequence < 0
      || trace.sequence > 1000000 || !Array.isArray(trace.events)) return;
    if (trace.sequence < sequence) { sequence = 0; write("sample", { sequenceReset: true }); }
    const events = trace.events.slice(-128).map(sanitizeQuotaTrace).filter((event) => event && event.sequence > sequence);
    if (events.length && events[0].sequence > sequence + 1) write("sample", { lostEvents: events[0].sequence - sequence - 1 });
    for (const event of events) {
      if (event.sequence > trace.sequence) continue;
      write("sample", { ...event, version: trace.version });
      sequence = event.sequence;
    }
  };
  const sample = () => {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    if (cdp.closed) { write("connection-closed"); dispose(); return Promise.resolve(); }
    const current = generation;
    pending = Promise.resolve().then(() => cdp.send("Runtime.evaluate", {
      expression: quotaTraceExpression(sequence, workbenchSequence), returnByValue: true,
    })).then((evaluation) => {
      if (disposed || current !== generation) return;
      if (evaluation.exceptionDetails) { write("evaluation-failed"); return; }
      const value = evaluation.result?.value;
      if (!value || typeof value !== "object") { write("evaluation-failed"); return; }
      capture(value);
    }, () => { if (!disposed && current === generation) write("transport-failed"); }).finally(() => { pending = null; });
    return pending;
  };
  const tick = async () => {
    timer = null;
    await sample();
    if (!disposed) { timer = schedule(tick, intervalMs); timer?.unref?.(); }
  };
  const off = [
    cdp.on("Runtime.executionContextsCleared", () => {
      generation++; sequence = 0; workbenchSequence = 0; lastPresence = null; lastHealth = null; write("contexts-cleared");
    }),
    cdp.on("Page.loadEventFired", () => { write("document-load"); }),
  ];
  function dispose() {
    if (disposed) return;
    write("disposed"); disposed = true;
    if (timer !== null) cancel(timer);
    for (const remove of off) remove?.();
  }
  write("attached");
  void tick();
  return { sample, capture, mark: write, dispose };
}
