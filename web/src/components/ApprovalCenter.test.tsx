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
