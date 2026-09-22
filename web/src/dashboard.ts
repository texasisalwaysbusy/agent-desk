import type { Task } from "./types";
export type DashboardFilter = "attention" | "overdue" | "todo" | "in_progress" | "in_review" | "blocked";
export function dashboardTasks(input: Task[], now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(today); end.setDate(end.getDate() + 7);
  const day = (value: string) => new Date(`${value}T00:00:00`).getTime();
  const priorities = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  const tasks = input.filter(task => !task.archivedAt);
  const active = tasks.filter(task => task.status !== "done" && task.status !== "canceled");
  const overdue = active.filter(task => task.dueDate && day(task.dueDate) < today.getTime());
  const group = (task: Task) => task.status === "in_review" ? 0 : task.status === "blocked" ? 1 : 2;
  const attention = active.filter(task => task.status === "in_review" || task.status === "blocked" || overdue.includes(task))
    .sort((a, b) => group(a) - group(b) || priorities[a.priority] - priorities[b.priority] || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.identifier.localeCompare(b.identifier));
  const scope = tasks.filter(task => task.status !== "canceled");
  return { tasks, active, attention, overdue,
    upcoming: active.filter(task => task.dueDate && day(task.dueDate) >= today.getTime() && day(task.dueDate) < end.getTime()).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)),
    recent: [...tasks].sort((a, b) => b.activityUpdatedAt.localeCompare(a.activityUpdatedAt)).slice(0, 5),
    completion: scope.length ? Math.round(100 * scope.filter(task => task.status === "done").length / scope.length) : null,
  };
}
