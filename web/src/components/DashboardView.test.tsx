import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardView } from "./DashboardView";
import { dashboardTasks } from "../dashboard";
import { requestApproval } from "../approvalBridge";
import { TaskboardLanguageProvider } from "../i18n";
import type { Task } from "../types";
vi.mock("../approvalBridge", () => ({ requestApproval: vi.fn() }));
beforeEach(() => { vi.mocked(requestApproval).mockReset(); });
afterEach(cleanup);
const now = new Date(2026, 8, 22, 12);
function task(id: string, changes: Partial<Task> = {}): Task {
  return { id, identifier: id, title: id, projectId: "example", status: "todo", priority: "medium", labels: [],
    assignee: { id: "codex", type: "agent", name: "Codex", avatarUrl: null }, archivedAt: null,
    dueDate: null, activityUpdatedAt: "2026-09-22T12:00:00Z", ...changes } as Task;
}
function view(tasks: Task[] = [], props: Partial<React.ComponentProps<typeof DashboardView>> = {}) {
  return render(<TaskboardLanguageProvider language="zh"><DashboardView tasks={tasks} projects={[]} isAllProjects
    presentations={{}} loading={false} hasLoaded failed={false} approvalChallenge="" approvalProject={undefined}
    onOpenApprovals={vi.fn()} onOpenTask={vi.fn()} onOpenConversation={vi.fn()} {...props}/></TaskboardLanguageProvider>);
}
it("excludes canceled and archived tasks from completion and deduplicates overlapping attention reasons", () => {
  const result = dashboardTasks([task("done", { status: "done" }), task("blocked", { status: "blocked", dueDate: "2026-09-21" }),
    task("canceled", { status: "canceled" }), task("archived", { status: "done", archivedAt: "2026-09-20" })], now);
  expect(result.completion).toBe(50); expect(result.attention.map(t => t.id)).toEqual(["blocked"]);
  expect(dashboardTasks([], now).completion).toBeNull();
});
it("uses calendar days for deadlines and keeps overdue out of upcoming", () => {
  const result = dashboardTasks([task("past", { dueDate: "2026-09-21" }), task("today", { dueDate: "2026-09-22" }),
    task("last", { dueDate: "2026-09-28" }), task("outside", { dueDate: "2026-09-29" })], now);
  expect(result.upcoming.map(t => t.id)).toEqual(["today", "last"]); expect(result.overdue.map(t => t.id)).toEqual(["past"]);
});
it("filters the attention queue and opens the selected real task", () => {
  const open = vi.fn(); const blocked = task("blocked", { status: "blocked" });
  view([blocked, task("review", { status: "in_review" })], { onOpenTask: open });
  fireEvent.click(screen.getByRole("button", { name: "受阻" }));
  const panel = screen.getByRole("heading", { name: /需要处理/ }).closest("section")!;
  expect(within(panel).queryByText("review")).toBeNull(); fireEvent.click(within(panel).getByText("blocked"));
  expect(open).toHaveBeenCalledWith(blocked);
});
it("does not invent a running conversation from task status", () => {
  view([task("active", { status: "in_progress" })]);
  expect(screen.getByText("进行中 · 未确认会话运行")).toBeTruthy();
  expect(screen.queryByText("会话运行中", { exact: true })).toBeNull();
});
it("leaves unqueried approvals unknown and does not initiate a model conversation", () => {
  view(); expect(requestApproval).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /交接待审批 · 尚未查询/ })).toBeTruthy();
  expect(screen.queryByText(/上午好|下午好|晚上好/)).toBeNull();
});
it("distinguishes failed approvals from a successful empty result", async () => {
  vi.mocked(requestApproval).mockRejectedValue(new Error("offline"));
  view([], { approvalChallenge: "fixture", approvalProject: null });
  await waitFor(() => expect(screen.getByRole("button", { name: /交接待审批 · 读取失败/ })).toBeTruthy());
});
it("uses only the list operation and marks partial approval counts", async () => {
  vi.mocked(requestApproval).mockResolvedValue({ items: [{ state: "pending" }], truncated: true });
  const open = vi.fn(); view([], { approvalChallenge: "fixture", approvalProject: "example", onOpenApprovals: open });
  const button = await screen.findByRole("button", { name: /交接待审批 · 1\+/ });
  fireEvent.click(button); expect(open).toHaveBeenCalled();
  expect(requestApproval).toHaveBeenCalledWith("fixture", { operation: "list", project: "example" }, expect.any(AbortSignal));
});
it("does not present failed task counts as zero", () => {
  view([], { hasLoaded: false, failed: true });
  expect(screen.getByRole("button", { name: /待办\s*—/ })).toBeTruthy();
});
