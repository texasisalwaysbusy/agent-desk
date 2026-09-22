import { postEmbeddedHostMessage } from "./embeddedHost.mjs";
import type { AiChatModel } from "./types";

function validModels(value: unknown): value is AiChatModel[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 1_000 && value.every((model) => (
    model && typeof model.slug === "string" && model.slug.length > 0
    && typeof model.displayName === "string" && typeof model.description === "string"
    && Array.isArray(model.supportedReasoningEfforts)
    && model.supportedReasoningEfforts.every((effort: unknown) => typeof effort === "string")
    && model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
    && Array.isArray(model.serviceTiers)
  ));
}

export function requestNativeModelCatalog(
  codexHostId: string,
  challenge: string,
  signal: AbortSignal,
): Promise<{ models: AiChatModel[] }> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (!challenge || !codexHostId || window.parent === window) {
    return Promise.reject(new Error("Codex model catalog bridge is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const requestId = window.crypto.randomUUID();
    const finish = (error?: Error, models?: AiChatModel[]) => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ models: models! });
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== window.parent || message?.type !== "taskboard:model-catalog-response"
        || message.challenge !== challenge || message.payload?.requestId !== requestId) return;
      if (!message.payload.ok) {
        finish(new Error(typeof message.payload.error === "string"
          ? message.payload.error : "Codex model catalog is unavailable"));
      } else if (!validModels(message.payload.models)) {
        finish(new Error("Codex returned an invalid model catalog"));
      } else finish(undefined, message.payload.models);
    };
    const timeout = window.setTimeout(() => finish(new Error("Codex model catalog timed out")), 12_000);
    window.addEventListener("message", receive);
    signal.addEventListener("abort", abort, { once: true });
    try {
      postEmbeddedHostMessage({ type: "taskboard:model-catalog-request", payload: { requestId, codexHostId } });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Codex model catalog request failed"));
    }
  });
}
