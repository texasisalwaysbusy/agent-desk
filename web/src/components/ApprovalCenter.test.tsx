import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalCenter } from "./ApprovalCenter";
import { requestApproval } from "../approvalBridge";

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
