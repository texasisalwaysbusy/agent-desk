import { useEffect, useState } from "react";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import { requestApproval, type ApprovalItem } from "../approvalBridge";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import type { Project, Task } from "../types";
import { TaskConversationMenu } from "./TaskConversationMenu";
import { dashboardTasks, type DashboardFilter } from "../dashboard";
import "./DashboardView.css";

interface DashboardViewProps {
  isAllProjects: boolean; tasks: Task[]; projects: Project[];
  presentations: Record<string, TaskCardPresentation>;
  loading: boolean; hasLoaded: boolean; failed: boolean;
  approvalChallenge: string; approvalProject: string | null | undefined;
  onOpenApprovals: () => void;
  onOpenTask: (task: Task) => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}
export function DashboardView({ isAllProjects, tasks, projects, presentations, loading, hasLoaded,
  failed, approvalChallenge, approvalProject, onOpenApprovals, onOpenTask, onOpenConversation }: DashboardViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [filter, setFilter] = useState<DashboardFilter>("attention");
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [approval, setApproval] = useState<{ count: number | null; state: "loading" | "ready" | "unknown" | "failed"; partial: boolean }>({ count: null, state: "unknown", partial: false });
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!approvalChallenge || approvalProject === undefined) {
      setApproval({ count: null, state: "unknown", partial: false }); return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setApproval({ count: null, state: "loading", partial: false });
      try {
        const result = await requestApproval<{ items: ApprovalItem[]; note?: string; truncated?: boolean }>(approvalChallenge,
          { operation: "list", project: approvalProject }, controller.signal);
        if (!controller.signal.aborted) setApproval({ count: result.items.filter(item => item.state === "pending").length,
          state: "ready", partial: Boolean(result.note || result.truncated) });
      } catch {
        if (!controller.signal.aborted) setApproval({ count: null, state: "failed", partial: false });
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 60_000);
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [approvalChallenge, approvalProject]);
  const data = dashboardTasks(tasks, now);
  const known = hasLoaded && !failed;
  const statusLabel = (status: Task["status"]) => status === "in_review" ? text("待验收", "Awaiting review") : status === "todo" ? text("待办", "To do") : status === "in_progress" ? text("进行中", "In progress") : status === "blocked" ? text("受阻", "Blocked") : taskStatusLabel(language, status);
  const filters: { key: DashboardFilter; label: string }[] = [
    { key: "attention", label: text("全部", "All") }, { key: "in_review", label: statusLabel("in_review") },
    { key: "blocked", label: statusLabel("blocked") }, { key: "overdue", label: text("逾期", "Overdue") },
  ];
  const metrics = ["todo", "in_progress", "in_review", "blocked"] as const;
  const queue = filter === "attention" ? data.attention : filter === "overdue" ? data.overdue : data.active.filter(task => task.status === filter);
  const running = data.active.filter(task => task.status === "in_progress" || presentations[task.id]?.processing.running);
  const labelCounts = new Map<string, number>();
  for (const task of data.active) for (const label of task.labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  function select(next: DashboardFilter) { setFilter(next); setShowAll(false); }
  function meta(task: Task) {
    return [task.identifier, isAllProjects ? projects.find(p => p.id === task.projectId)?.name ?? task.projectId : null, task.assignee.name].filter(Boolean).join(" · ");
  }
  function reason(task: Task) {
    return [statusLabel(task.status), data.overdue.some(item => item.id === task.id) ? text("已逾期", "Overdue") : null].filter(Boolean).join(" · ");
  }
  function row(task: Task, suffix = reason(task)) {
    return <button type="button" className="desk-dashboard-row" key={task.id} onClick={() => onOpenTask(task)}>
      <span><strong>{task.title}</strong><small>{meta(task)}</small><small>{suffix}</small></span><span aria-hidden="true">↗</span>
    </button>;
  }
  const empty = <p className="desk-dashboard-empty">{failed ? text("任务读取失败，请使用上方入口重试", "Could not load tasks. Retry above.") : !hasLoaded ? text("正在读取任务…", "Loading tasks…") : text("当前没有符合条件的任务", "No matching tasks")}</p>;
  const approvalText = approval.state === "ready" ? `${approval.count}${approval.partial ? "+" : ""}`
    : approval.state === "loading" ? text("读取中", "Loading") : approval.state === "failed" ? text("读取失败", "Unavailable") : text("尚未查询", "Not queried");
  return <div className="dashboard-view desk-dashboard" aria-label={text("仪表盘", "Dashboard")} aria-busy={loading}>
    <header className="desk-dashboard-heading"><h1>{text("仪表盘", "Dashboard")}</h1><span>{failed ? text("读取失败 · 已有内容可能过时", "Load failed · existing data may be stale") : loading ? text("正在刷新…", "Refreshing…") : !hasLoaded ? text("尚未读取", "Not loaded") : text("随任务更新同步", "Synced with task updates")}</span></header>
    <div className="desk-dashboard-metrics">{metrics.map(status => <button type="button" key={status} aria-pressed={filter === status} onClick={() => select(status)}><span>{statusLabel(status)}</span><strong>{known ? data.active.filter(task => task.status === status).length : "—"}</strong></button>)}</div>
    {known && data.tasks.length === 0 && <p className="desk-dashboard-empty">{text("暂无任务，使用顶部 + 新建任务。", "No tasks yet. Use + above to create one.")}</p>}
    <div className="desk-dashboard-grid">
      <section className="desk-dashboard-panel"><header><h2>{filter === "todo" || filter === "in_progress" ? statusLabel(filter) : text("需要处理", "Needs attention")} <span>{known ? queue.length : "—"}</span></h2></header>
        <div className="desk-dashboard-filters">{filters.map(item => <button type="button" key={item.key} aria-pressed={filter === item.key} onClick={() => select(item.key)}>{item.label}</button>)}</div>
        <div aria-live="polite">{queue.length ? (showAll ? queue : queue.slice(0, 5)).map(task => row(task)) : empty}</div>
        {queue.length > 5 && <button type="button" className="desk-dashboard-more" onClick={() => setShowAll(!showAll)}>{showAll ? text("收起", "Show less") : text(`查看全部 ${queue.length} 项`, `View all ${queue.length}`)}</button>}
        <button type="button" className="desk-dashboard-approval" onClick={onOpenApprovals}><span>{text("交接待审批", "Handoff approvals")} · {approvalText}</span><span>{text("进入审批中心", "Open approvals")} →</span></button>
        {approval.partial && <p className="desk-dashboard-note">{text("仅含已返回记录，请在审批中心核对完整范围。", "Only returned records are counted. Check the full scope in Approvals.")}</p>}
      </section>
      <section className="desk-dashboard-panel"><header><h2>{text("正在推进", "Work in progress")}</h2><span>{known ? running.length : "—"}</span></header>
        {running.length ? running.map(task => <article className="desk-dashboard-running" key={task.id}>{row(task, presentations[task.id]?.processing.running ? text("会话运行中", "Conversation running") : text("进行中 · 未确认会话运行", "In progress · conversation not confirmed running"))}
          {!!presentations[task.id]?.conversations.length && <div className="desk-dashboard-conversation"><TaskConversationMenu conversations={presentations[task.id].conversations} onOpenConversation={onOpenConversation} /></div>}
        </article>) : empty}
      </section>
    </div>
    <div className="desk-dashboard-grid">
      <section className="desk-dashboard-panel"><header><h2>{text("近期截止", "Upcoming deadlines")}</h2><span>{text("今天起 7 天内", "Next 7 days")}</span></header>{data.upcoming.length ? data.upcoming.map(task => row(task, new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(`${task.dueDate}T12:00:00`)))) : empty}</section>
      <section className="desk-dashboard-panel"><header><h2>{text("最近更新", "Recently updated")}</h2><span>{text("任务", "Tasks")}</span></header>{data.recent.length ? data.recent.map(task => row(task, `${statusLabel(task.status)} · ${new Date(task.activityUpdatedAt).toLocaleString(locale)}${presentations[task.id]?.unread ? text(" · 未读", " · Unread") : ""}`)) : empty}</section>
    </div>
    <details className="desk-dashboard-statistics"><summary>{text("任务统计", "Task statistics")}</summary>
      <p>{text("完成率", "Completion")}: {known && data.completion !== null ? `${data.completion}%` : "—"} · {text("已取消和归档任务不计入", "Excludes canceled and archived tasks")}</p>
      <div>{(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"] as const).map(status => <span key={status}>{statusLabel(status)}: {known ? data.tasks.filter(task => task.status === status).length : "—"}　</span>)}</div>
      <p>{text("未结束任务优先级", "Open-task priorities")}: {(["urgent", "high", "medium", "low", "none"] as const).map(priority => <span key={priority}>{taskPriorityLabel(language, priority)} {known ? data.active.filter(task => task.priority === priority).length : "—"}　</span>)}</p>
      <p>{text("未结束任务标签（一个任务可有多个标签）", "Open-task labels (tasks can have multiple labels)")}: {known ? [...labelCounts].map(([label, count]) => `${label} ${count}`).join(" · ") || text("暂无标签", "No labels") : "—"}</p>
    </details>
  </div>;
}
