import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateCodexRateLimits,
  normalizeCodexRateLimitsForDisplay,
} from "../scripts/codex-rate-limits.mjs";

const checkedAt = 1_777_000_000_000;

test("Codex rate limits select the requested model and report available quota", () => {
  const result = evaluateCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitName: "codex",
        primary: { usedPercent: 99, resetsAt: 1_777_000_100 },
      },
      terra: {
        limitName: "gpt-5.6-terra",
        primary: { usedPercent: 45, resetsAt: 1_777_000_200 },
        secondary: { usedPercent: 20, resetsAt: 1_777_000_300 },
      },
    },
  }, "gpt-5.6-terra", checkedAt);

  assert.deepEqual(result, { state: "available", checkedAt });
});

test("Codex rate limits report an exhausted quota and its latest reset", () => {
  const result = evaluateCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitName: "codex",
        primary: { usedPercent: 100, resetsAt: 1_777_000_100 },
        secondary: { usedPercent: 100, resetsAt: 1_777_000_300 },
        credits: { hasCredits: false },
      },
    },
  }, "gpt-5.6-terra", checkedAt);

  assert.deepEqual(result, {
    state: "blocked",
    checkedAt,
    resetsAt: 1_777_000_300,
  });
});

test("available credits prevent a spent time window from pausing automation", () => {
  const result = evaluateCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 100, resetsAt: 1_777_000_100 },
      credits: { hasCredits: true },
    },
  }, "gpt-5.6-terra", checkedAt);

  assert.deepEqual(result, { state: "available", checkedAt });
});

test("missing Codex rate-limit data remains unknown", () => {
  assert.deepEqual(
    evaluateCodexRateLimits({}, "gpt-5.6-terra", checkedAt),
    { state: "unknown", checkedAt },
  );
});

test("quota display normalization keeps only renderer-safe allowance fields", () => {
  const result = normalizeCodexRateLimitsForDisplay({
    email: "must-not-render@example.test",
    token: "must-not-render",
    rateLimitsByLimitId: {
      codex: {
        limitName: null,
        planType: "pro",
        primary: { usedPercent: 18.5, windowDurationMins: 300, resetsAt: 1_777_000_100 },
        secondary: { usedPercent: 72, windowDurationMins: 10_080, resetsAt: 1_777_000_300 },
        credits: { balance: 999 },
      },
    },
  }, checkedAt);

  assert.deepEqual(result, {
    schemaVersion: 1,
    fetchedAtMs: checkedAt,
    buckets: [{
      id: "codex",
      name: null,
      planType: "pro",
      reachedType: null,
      windows: [
        {
          kind: "primary",
          usedPercent: 18.5,
          remainingPercent: 81.5,
          durationMinutes: 300,
          resetsAtMs: 1_777_000_100_000,
        },
        {
          kind: "secondary",
          usedPercent: 72,
          remainingPercent: 28,
          durationMinutes: 10_080,
          resetsAtMs: 1_777_000_300_000,
        },
      ],
    }],
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-render|balance|credits|email|token/i);
});

test("quota display normalization rejects malformed percentages and excessive buckets", () => {
  assert.throws(
    () => normalizeCodexRateLimitsForDisplay({
      rateLimits: { primary: { usedPercent: "20" } },
    }, checkedAt),
    /used percentage/,
  );
  assert.throws(
    () => normalizeCodexRateLimitsForDisplay({
      rateLimitsByLimitId: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [
          `bucket-${index}`,
          { primary: { usedPercent: 20 } },
        ]),
      ),
    }, checkedAt),
    /Too many/,
  );
});
