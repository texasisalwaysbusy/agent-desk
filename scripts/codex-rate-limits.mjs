export function evaluateCodexRateLimits(result, model, checkedAt = Date.now()) {
  const snapshots = result?.rateLimitsByLimitId;
  const entries = snapshots && typeof snapshots === "object" && !Array.isArray(snapshots)
    ? Object.entries(snapshots).filter(([, snapshot]) => (
    snapshot && typeof snapshot === "object"
    ))
    : [];
  const normalizedModel = normalizeName(model);
  const snapshot = entries.find(([, value]) => (
    normalizeName(value.limitName) === normalizedModel
  ))?.[1]
    ?? entries.find(([limitId]) => limitId === "codex")?.[1]
    ?? (
      result?.rateLimits
      && typeof result.rateLimits === "object"
      && !Array.isArray(result.rateLimits)
        ? result.rateLimits
        : null
    );
  if (!snapshot) return { state: "unknown", checkedAt };

  const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
  const creditsAvailable = snapshot.credits?.unlimited === true
    || snapshot.credits?.hasCredits === true;
  const exhaustedWindows = windows.filter((window) => (
    Number(window.usedPercent) >= 100
  ));
  const individuallyExhausted = Number(snapshot.individualLimit?.remainingPercent) <= 0;
  const blocked = Boolean(snapshot.rateLimitReachedType)
    || snapshot.spendControlReached === true
    || individuallyExhausted
    || (exhaustedWindows.length > 0 && !creditsAvailable);

  if (!blocked) return { state: "available", checkedAt };

  const resetCandidates = [
    ...exhaustedWindows.map((window) => Number(window.resetsAt)),
    Number(snapshot.individualLimit?.resetsAt),
  ];
  if (snapshot.rateLimitReachedType || snapshot.spendControlReached === true) {
    resetCandidates.push(...windows.map((window) => Number(window.resetsAt)));
  }
  const resetsAt = Math.max(...resetCandidates.filter(Number.isFinite));
  return {
    state: "blocked",
    checkedAt,
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

const DISPLAY_SCHEMA_VERSION = 1;
const MAX_BUCKETS = 32;
const MAX_UNIX_SECONDS = 253_402_300_799;
const DISPLAY_PLAN_TYPES = new Set([
  "free", "go", "plus", "pro", "prolite", "team", "business",
  "enterprise", "edu", "unknown",
]);
const DISPLAY_REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

function displayText(value, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  return value;
}

function displayResetAt(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UNIX_SECONDS
    ? value * 1000
    : null;
}

function displayWindow(kind, value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${kind} Codex rate-limit window`);
  }
  if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) {
    throw new Error(`Invalid ${kind} Codex used percentage`);
  }
  const usedPercent = Math.min(100, Math.max(0, value.usedPercent));
  return {
    kind,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    durationMinutes: Number.isSafeInteger(value.windowDurationMins) && value.windowDurationMins >= 0
      ? value.windowDurationMins
      : null,
    resetsAtMs: displayResetAt(value.resetsAt),
  };
}

function displayBucket(id, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex rate-limit bucket");
  }
  const planType = displayText(value.planType, 32);
  const reachedType = displayText(value.rateLimitReachedType, 64);
  return {
    id,
    name: displayText(value.limitName, 64),
    planType: DISPLAY_PLAN_TYPES.has(planType) ? planType : null,
    reachedType: DISPLAY_REACHED_TYPES.has(reachedType) ? reachedType : null,
    windows: [
      displayWindow("primary", value.primary),
      displayWindow("secondary", value.secondary),
    ].filter(Boolean),
  };
}

/**
 * Reduce account/rateLimits/read to the renderer-safe fields used by the
 * embedded quota card. Account identifiers, credits, tokens, and unknown
 * response fields are intentionally discarded.
 */
export function normalizeCodexRateLimitsForDisplay(result, checkedAt = Date.now()) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Invalid Codex rate-limit response");
  }
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt) || checkedAt < 0) {
    throw new TypeError("checkedAt must be a non-negative finite number");
  }

  const buckets = [];
  const byId = result.rateLimitsByLimitId;
  if (byId !== null && byId !== undefined) {
    if (typeof byId !== "object" || Array.isArray(byId)) {
      throw new Error("Invalid Codex rate-limit bucket map");
    }
    const entries = Object.entries(byId);
    if (entries.length > MAX_BUCKETS) throw new Error("Too many Codex rate-limit buckets");
    for (const [rawId, bucket] of entries) {
      if (bucket === null || bucket === undefined) continue;
      const id = displayText(rawId, 64);
      if (!id) throw new Error("Invalid Codex rate-limit bucket id");
      buckets.push(displayBucket(id, bucket));
    }
  }

  if (buckets.length === 0) {
    const fallback = result.rateLimits;
    if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) {
      throw new Error("No Codex rate-limit bucket was returned");
    }
    buckets.push(displayBucket(displayText(fallback.limitId, 64) ?? "codex", fallback));
  }

  return {
    schemaVersion: DISPLAY_SCHEMA_VERSION,
    fetchedAtMs: checkedAt,
    buckets,
  };
}

function normalizeName(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, "")
    : "";
}
