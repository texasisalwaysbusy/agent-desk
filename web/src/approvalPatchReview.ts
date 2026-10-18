import type { ApprovalDetail } from "./approvalBridge";

export interface PatchReview {
  path: string;
  hash: string;
  operations: string[];
  text: string;
  state: "complete" | "preview" | "missing" | "unavailable" | "conflict";
}

// Compatibility with the current receiver: truncated alone does not mean changed.
const unavailableText = "文件已变化或缺失，不能据此批准。";
export function reviewApprovalPatches(detail: ApprovalDetail): PatchReview[] {
  const groups = new Map<string, PatchReview>();
  for (const op of detail.status.package.operations) {
    for (const [path, hash] of Object.entries(op.inputs)) {
      if (!/\.(patch|diff)$/i.test(path)) continue;
      const key = JSON.stringify([path, hash]);
      const entry = groups.get(key);
      if (entry) entry.operations.push(op.id);
      else groups.set(key, { path, hash, operations: [op.id], text: "", state: "missing" });
    }
  }
  for (const entry of groups.values()) {
    const supplied = (detail.patches ?? []).filter(p => p.path === entry.path && entry.operations.includes(p.operation));
    if (!supplied.length) continue;
    if (supplied.some(p => typeof p.truncated !== "boolean" || typeof p.text !== "string")) {
      entry.state = "unavailable";
      continue;
    }
    if (supplied.some(p => p.truncated && p.text === unavailableText)) {
      entry.state = "unavailable";
      continue;
    }
    const complete = supplied.filter(p => p.truncated === false);
    const longest = [...supplied].sort((a, b) => b.text.length - a.text.length)[0];
    entry.text = longest.text;
    if (complete.length) {
      const text = complete[0].text;
      if (complete.some(p => p.text !== text) || supplied.some(p => !text.startsWith(p.text))) entry.state = "conflict";
      else { entry.text = text; entry.state = "complete"; }
    } else if (supplied.some(p => !longest.text.startsWith(p.text))) entry.state = "conflict";
    else entry.state = "preview";
  }
  // Unexpected display entries cannot silently become reviewed evidence.
  for (const patch of detail.patches ?? []) {
    if (![...groups.values()].some(p => p.path === patch.path && p.operations.includes(patch.operation))) {
      groups.set(JSON.stringify([patch.path, patch.operation, "unexpected"]), {
        path: patch.path, hash: "", operations: [patch.operation], text: "", state: "unavailable",
      });
    }
  }
  return [...groups.values()];
}

export const patchReviewMessages: Record<PatchReview["state"], string> = {
  complete: "完整材料已展示，仍需核对内容与操作影响。",
  preview: "仅显示部分预览，这不表示文件已经变化。请申请方分段补充完整材料后重新提交。",
  missing: "接收端尚未提供这份差异的展示内容，请退回补充。",
  unavailable: "文件缺失、摘要不匹配或来源无法核对，请刷新核验；仍不一致时退回。",
  conflict: "同一差异的展示内容不一致，请刷新后重新核验。",
};
