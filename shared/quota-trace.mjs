const reasons = new Set(["mounted", "settings", "no-sidebar", "navigation-count", "navigation-flow",
  "scroll-branch", "scroll-order", "scroll-count", "reference", "legacy-scroll", "legacy-parent", "cleanup"]);
const lifecycle = new Set(["attached", "sample", "contexts-cleared", "document-load", "contract-result", "detach-start",
  "detach-returned", "disposed", "connection-closed", "evaluation-failed", "transport-failed", "trace-limit"]);

export function sanitizeQuotaTrace(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  if (lifecycle.has(value.phase)) result.phase = value.phase;
  if (reasons.has(value.reason)) result.reason = value.reason;
  for (const key of ["renderer", "documentGeneration", "sequence", "oldestSequence", "lostEvents",
    "sidebarIdentity", "navigationIdentity", "parentIdentity"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1000000) result[key] = value[key];
  }
  for (const key of ["hostCount", "sidebarCount", "visibleSidebarCount", "legacyCount", "navigationCount",
    "totalNavigations", "scrollCount", "branchCount", "nativeChildren", "hiddenNativeChildren", "candidateCount"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1000) result[key] = value[key];
  }
  if (["div", "section", "footer", "nav", "button", "ul", "other"].includes(value.lastNativeChildTag)) result.lastNativeChildTag = value.lastNativeChildTag;
  for (const key of ["width", "height", "top", "left"]) {
    if (Number.isInteger(value[key]) && Math.abs(value[key]) <= 32768) result[key] = value[key];
  }
  for (const key of ["appProtocol", "topFrame", "apiPresent", "connected", "hidden", "cleaned",
    "ancestorHidden", "clipped", "ancestorLimit", "sequenceReset", "compatible"]) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  if (Number.isSafeInteger(value.atMs) && value.atMs > 0 && value.atMs <= 8.64e15) result.atMs = value.atMs;
  if (typeof value.version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.version)) result.version = value.version;
  return result;
}

// One budget shared by all managed renderer observers in an activation attempt.
export function createQuotaTraceBudget(emit, limit = 96) {
  let count = 0, exhausted = false;
  return (record) => {
    const trace = sanitizeQuotaTrace(record);
    if (!trace) return;
    if (count < limit) { count++; emit(trace); }
    else if (!exhausted) { exhausted = true; emit(sanitizeQuotaTrace({ ...trace, phase: "trace-limit" })); }
  };
}
