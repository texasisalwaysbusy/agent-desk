export function sanitizeWorkbenchTrace(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  if (["idle", "loading", "frame", "error", "trace-limit"].includes(value.phase)) result.phase = value.phase;
  if (["none", "frame-timeout", "load-failed", "mount-unavailable"].includes(value.failure)) result.failure = value.failure;
  if (["parked", "mounted", "unavailable"].includes(value.mountState)) result.mountState = value.mountState;
  if (["idle", "ensure", "queued", "bootstrap", "handshake", "ready"].includes(value.loadStage)) result.loadStage = value.loadStage;
  if (["none", "route-unavailable"].includes(value.parkReason)) result.parkReason = value.parkReason;
  if (typeof value.routeEligible === "boolean") result.routeEligible = value.routeEligible;
  for (const key of ["pageVisibility", "frameVisibility"]) {
    if (["visible", "disconnected", "hidden", "native-hidden", "zero-size", "depth-limit", "suppressed", "clipped", "offscreen"].includes(value[key])) result[key] = value[key];
  }
  for (const key of ["renderer", "documentGeneration", "sequence", "openGeneration", "lostEvents"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1000000) result[key] = value[key];
  }
  for (const key of ["active", "destroyed", "frameReady", "pageConnected", "frameConnected", "hostBindingLive",
    "entryConnected", "entryHidden", "entrySeparateRow", "entrySharesNativeRow", "entryOversized",
    "entryVisible", "listUsable", "pageVisible", "frameVisible", "frameAwaitingChallenge", "frameLoadAcknowledged", "frameOccluded", "pageHidden"]) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  if (Number.isInteger(value.entryHeight) && value.entryHeight >= 0 && value.entryHeight <= 32768) result.entryHeight = value.entryHeight;
  if (Number.isInteger(value.frameLoadEvents) && value.frameLoadEvents >= 0 && value.frameLoadEvents <= 1000) result.frameLoadEvents = value.frameLoadEvents;
  if (Number.isSafeInteger(value.atMs) && value.atMs > 0 && value.atMs <= 8.64e15) result.atMs = value.atMs;
  return result;
}

export function createWorkbenchTraceBudget(emit) {
  let count = 0, exhausted = false;
  return (record) => {
    const value = sanitizeWorkbenchTrace(record);
    if (!value) return;
    if (count++ < 48) emit(value);
    else if (!exhausted) { exhausted = true; emit(sanitizeWorkbenchTrace({ ...value, phase: "trace-limit" })); }
  };
}
