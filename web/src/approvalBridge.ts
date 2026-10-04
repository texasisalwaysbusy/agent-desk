import { postEmbeddedHostMessage } from "./embeddedHost.mjs";

export interface ApprovalItem {
  id: string; task_id: string; project: string; sender: string; receiver: string;
  session: string; objective: string; state: string;
  archived?: boolean; archiveAutomatic?: boolean;
}
export interface ApprovalOperation {
  id: string; argv: string[]; cwd: string; inputs: Record<string, string>;
  effects: string; timeout_seconds: number;
}
export interface ApprovalDetail {
  message: { envelope: { sender: string; body: string } };
  status: {
    task_id: string; sha256: string; approved_at: string | null; revoked_at: string | null;
    protocol_current: boolean;
    package: { objective: string; scope: string; project: string; receiver: string; session: string; operations: ApprovalOperation[] };
    operations: { id: string; state: string; result: string | null }[];
    risk_findings: Record<string, string[]>;
  };
  revision: string;
  outputs: { id: string; text: string; exit_code: number | null; truncated: boolean }[];
  history: { decision: string; reason: string; at: string }[];
  reports: string[];
  patches?: { operation: string; path: string; text: string; truncated: boolean }[];
}

export function requestApproval<T>(challenge: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (!challenge || window.parent === window) return Promise.reject(new Error("请从 Codex 内的智能体工作台打开审批中心"));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer); window.removeEventListener("message", receive); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value!);
    };
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== window.parent || message?.type !== "taskboard:approval-response"
        || message.challenge !== challenge || message.payload?.requestId !== requestId) return;
      if (!message.payload.ok) finish(new Error(message.payload.error || "审批请求未完成"));
      else finish(undefined, message.payload as T);
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const timer = window.setTimeout(() => finish(new Error("审批响应超时，请刷新核对状态")), 25000);
    window.addEventListener("message", receive); signal?.addEventListener("abort", abort, { once: true });
    postEmbeddedHostMessage({ type: "taskboard:approval-request", payload: { requestId, request } });
  });
}
