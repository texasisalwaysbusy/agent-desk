const MAX_PAGES = 10;
const REQUEST_BUDGET_MS = 8_000;

function boundedText(value, limit) {
  return typeof value === "string" && value.trim().length <= limit ? value.trim() : "";
}

// Only model-picker metadata crosses the renderer bridge; discard all other fields.
export function normalizeNativeModels(entries) {
  return entries.flatMap((entry) => {
    if (!entry || entry.hidden === true) return [];
    const slug = boundedText(entry.model, 128);
    const efforts = [...new Set((Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts : []).flatMap((level) => {
      const effort = boundedText(level?.reasoningEffort, 32);
      return effort ? [effort] : [];
    }))];
    if (!slug || !efforts.length) return [];
    const preferredEffort = boundedText(entry.defaultReasoningEffort, 32);
    return [{
      slug,
      displayName: boundedText(entry.displayName, 128) || slug,
      description: boundedText(entry.description, 1_024),
      defaultReasoningEffort: efforts.includes(preferredEffort) ? preferredEffort : efforts[0],
      supportedReasoningEfforts: efforts,
      serviceTiers: [],
    }];
  });
}

export async function readNativeModelCatalog(request, { now = Date.now } = {}) {
  const deadline = now() + REQUEST_BUDGET_MS;
  const entries = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) throw new Error("Codex model catalog timed out");
    const result = await request("model/list", {
      limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
    }, timeoutMs);
    if (!Array.isArray(result?.data) || result.data.length > 100) {
      throw new Error("Codex returned an invalid model catalog page");
    }
    entries.push(...result.data);
    if (result.nextCursor == null || result.nextCursor === "") {
      entries.sort((left, right) => Number(right?.isDefault === true) - Number(left?.isDefault === true));
      const models = [...new Map(normalizeNativeModels(entries).map((model) => [model.slug, model])).values()];
      if (!models.length) throw new Error("Codex returned no selectable models");
      return { models };
    }
    cursor = boundedText(result.nextCursor, 2_048);
    if (!cursor || cursors.has(cursor)) throw new Error("Codex returned an invalid model catalog cursor");
    cursors.add(cursor);
  }
  throw new Error("Codex model catalog exceeded its page limit");
}
