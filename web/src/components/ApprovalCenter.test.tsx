import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalCenter } from "./ApprovalCenter";
import { requestApproval } from "../approvalBridge";
import type { ApprovalDetail } from "../approvalBridge";
import { reviewApprovalPatches } from "../approvalPatchReview";

vi.mock("../approvalBridge", () => ({ requestApproval: vi.fn() }));
beforeEach(() => { vi.mocked(requestApproval).mockReset(); });
afterEach(cleanup);

it("does not call an unbound project empty; explicit all-project selection queries the mailbox", async () => {
  vi.mocked(requestApproval).mockResolvedValue({ items: [] });
  render(<ApprovalCenter challenge="fixture" project={undefined} />);
  expect(requestApproval).not.toHaveBeenCalled();
  expect(screen.queryByText("没有符合条件的申请")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看所有项目审批" }));
  await waitFor(() => expect(requestApproval).toHaveBeenCalledWith("fixture", { operation: "list", project: null }));
  expect(await screen.findByText("没有符合条件的申请")).toBeTruthy();
});

it("shows a query failure instead of a successful empty mailbox", async () => {
  vi.mocked(requestApproval).mockRejectedValue(new Error("fixture unavailable"));
  render(<ApprovalCenter challenge="fixture" project={null} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "fixture unavailable");
  expect(screen.queryByText("没有符合条件的申请")).toBeNull();
});

it("returns from all-project review to the exact selected project", async () => {
  vi.mocked(requestApproval).mockResolvedValue({ items: [] });
  const project = "E:\\Example";
  render(<ApprovalCenter challenge="fixture" project={project} />);
  await screen.findByText("没有符合条件的申请");
  fireEvent.click(screen.getByRole("button", { name: "查看所有项目审批" }));
  await screen.findByText("没有符合条件的申请");
  fireEvent.click(screen.getByRole("button", { name: "仅查看当前项目" }));
  await waitFor(() => expect(requestApproval).toHaveBeenLastCalledWith("fixture", { operation: "list", project }));
});

it("keeps archived invalid requests accessible without preparing them and exposes reversible cleanup", async () => {
  vi.mocked(requestApproval).mockResolvedValue({ items: [
    { id: "invalid-fixture", objective: "旧损坏申请", state: "invalid", archived: true },
    { id: "pending-fixture", objective: "当前申请", state: "pending", archived: false },
  ] });
  render(<ApprovalCenter challenge="fixture" project={null} />);
  expect(await screen.findByText("当前申请")).toBeTruthy();
  expect(screen.queryByText("旧损坏申请")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "已归档 · 1" }));
  fireEvent.click(await screen.findByRole("button", { name: /旧损坏申请/ }));
  expect(screen.getByRole("button", { name: "恢复到当前记录" })).toBeTruthy();
  expect(screen.getByText(/此申请无法核验/)).toBeTruthy();
  expect(requestApproval).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "批准本次任务" })).toBeNull();
});

it("allows an unreadable pending request to be archived from its list summary", async () => {
  vi.mocked(requestApproval).mockImplementation(async (_challenge, request) => {
    if (request.operation === "detail") throw new Error("程序或输入文件变化");
    return { items: [{ id: "old-fixture", objective: "过期候选申请", state: "pending" }] } as never;
  });
  render(<ApprovalCenter challenge="fixture" project={null} />);
  fireEvent.click(await screen.findByRole("button", { name: /过期候选申请/ }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "程序或输入文件变化");
  expect(screen.getByRole("button", { name: "归档此申请" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "批准本次任务" })).toBeNull();
});

function patchFixture(): ApprovalDetail {
  const operations = ["first", "second"].map(id => ({ id, argv: ["C:/fixture/tool.exe", "--version"], cwd: "C:/fixture", inputs: { "review.patch": "a".repeat(64) }, effects: "只读夹具", timeout_seconds: 10 }));
  return {
    message: { envelope: { sender: "fixture", body: "fixture" } }, revision: "fixture-revision",
    status: { task_id: "fixture-task", sha256: "fixture-hash", protocol_current: true, approved_at: null, revoked_at: null,
      package: { objective: "审查夹具", scope: "仅合成界面", project: "C:/fixture", receiver: "fixture", session: "fixture", operations },
      operations: operations.map(op => ({ id: op.id, state: "pending", result: null })), risk_findings: {} },
    patches: operations.map(op => ({ operation: op.id, path: "review.patch", text: "+ fixture change\n", truncated: false })),
    outputs: [], reports: [], history: [],
  };
}

it("groups only the same path and declared hash; different versions remain separate", () => {
  const detail = patchFixture();
  expect(reviewApprovalPatches(detail)).toMatchObject([{ operations: ["first", "second"], state: "complete" }]);
  detail.status.package.operations[1].inputs["review.patch"] = "b".repeat(64);
  expect(reviewApprovalPatches(detail)).toHaveLength(2);
});

it("distinguishes partial preview, missing data, unavailable file and inconsistent copies", () => {
  const detail = patchFixture();
  detail.patches = detail.patches!.map(p => ({ ...p, truncated: true }));
  expect(reviewApprovalPatches(detail)[0].state).toBe("preview");
  detail.patches = [];
  expect(reviewApprovalPatches(detail)[0].state).toBe("missing");
  detail.patches = [{ operation: "first", path: "review.patch", text: "文件已变化或缺失，不能据此批准。", truncated: true }];
  expect(reviewApprovalPatches(detail)[0].state).toBe("unavailable");
  detail.patches = patchFixture().patches;
  detail.patches![1].text = "+ different content\n";
  expect(reviewApprovalPatches(detail)[0].state).toBe("conflict");
  detail.patches![0].truncated = undefined as never;
  expect(reviewApprovalPatches(detail)[0].state).toBe("unavailable");
});

it("can reuse a complete identical-hash copy without treating a shorter preview as a file change", () => {
  const detail = patchFixture();
  detail.patches![1] = { ...detail.patches![1], text: "+ fixture", truncated: true };
  expect(reviewApprovalPatches(detail)[0].state).toBe("complete");
  detail.patches![1].text = "+ unrelated";
  expect(reviewApprovalPatches(detail)[0].state).toBe("conflict");
  detail.patches!.push({ operation: "unknown", path: "unbound.patch", text: "+ unexpected", truncated: false });
  expect(reviewApprovalPatches(detail).some(p => p.state === "unavailable")).toBe(true);
});

async function openPatchFixture(detail: ApprovalDetail) {
  vi.mocked(requestApproval).mockImplementation(async (_challenge, request) => request.operation === "detail" ? detail as never : {
    items: [{ id: "patch-fixture", objective: "审查夹具", state: "pending" }],
  } as never);
  render(<ApprovalCenter challenge="fixture" project={null} />);
  fireEvent.click(await screen.findByRole("button", { name: /审查夹具/ }));
  await screen.findByRole("region", { name: "差异材料审查" });
}

it("shows common patch content once and keeps complete material eligible for human review", async () => {
  await openPatchFixture(patchFixture());
  expect(screen.getAllByText("文件差异：review.patch")).toHaveLength(1);
  expect(screen.getAllByRole("link", { name: "查看共用差异：review.patch" })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "批准本次任务" })).toHaveProperty("disabled", false);
});

it("blocks approval for incomplete material while keeping return and rejection available", async () => {
  const detail = patchFixture();
  detail.patches = detail.patches!.map(p => ({ ...p, truncated: true }));
  await openPatchFixture(detail);
  expect(screen.getByText(/这不表示文件已经变化/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "批准本次任务" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("备注 / 退回原因"), { target: { value: "请分段补充完整差异" } });
  expect(screen.getByRole("button", { name: "退回修改" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "拒绝" })).toHaveProperty("disabled", false);
  expect(vi.mocked(requestApproval).mock.calls.every(([, request]) => request.operation !== "decide")).toBe(true);
});

it("does not silently approve a declared patch omitted by the receiver display budget", async () => {
  const detail = patchFixture(); detail.patches = [];
  await openPatchFixture(detail);
  expect(screen.getByText(/接收端尚未提供/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "批准本次任务" })).toHaveProperty("disabled", true);
});
