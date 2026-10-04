import { useEffect, useRef, useState } from "react";
import { requestApproval, type ApprovalDetail, type ApprovalItem, type ApprovalOperation } from "../approvalBridge";

const labels: Record<string, string> = { pending: "待审批", approved: "已批准 · 等待继续", succeeded: "已完成", running: "执行中",
  failed: "执行失败", revoked: "已撤销 / 已退回", outdated: "协议已更新", invalid: "无法核验",
  expired: "已过期", cancelled: "已取消",
  approve: "批准", reject: "拒绝", return: "退回修改", revoke: "撤销授权" };
const riskLabels: Record<string, string> = {
  "Shell/interpreter can perform arbitrary effects": "命令解释器可以执行多种操作，影响需要人工复核。",
  "Possible network, installation, deletion or permission change": "可能涉及联网、安装、删除或权限变更。",
  "Unknown or programmable operation: human risk review required": "此操作包含可编程或未知行为，尚不能确认实际影响。",
  "Referenced script lacks declared pinned input files": "引用的脚本没有固定内容，需退回补充文件校验信息。",
};
function operationTitle(op: ApprovalOperation) {
  const program = op.argv[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "程序";
  if (op.argv.length === 2 && op.argv[1] === "--version") return `查询 ${program} 版本`;
  if (op.argv.slice(1).join(" ") === "status --short") return "查看 Git 工作目录状态";
  if (op.argv.slice(1).join(" ") === "diff --stat") return "查看文件修改统计";
  return "执行待复核操作";
}

export function ApprovalCenter({ challenge, project }: { challenge: string; project: string | null | undefined }) {
  const [scope, setScope] = useState<"current" | "all">("current");
  const activeProject = scope === "all" ? null : project;
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [selected, setSelected] = useState("");
  const [summary, setSummary] = useState<ApprovalItem | null>(null);
  const [filter, setFilter] = useState("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState<string[]>([]);
  const generation = useRef(0);
  const mutation = useRef(false);

  async function refresh() {
    const gen = generation.current;
    setError(""); setNotice(""); setItems([]); setLoaded(false); setBusy(true);
    try {
      if (activeProject === undefined) return;
      const result = await requestApproval<{ items: ApprovalItem[]; note?: string; truncated?: boolean }>(challenge, { operation: "list", project: activeProject });
      if (gen !== generation.current) return;
      setItems(result.items); setLoaded(true); setNotice(result.note || (result.truncated ? "仅显示最近 200 个申请" : ""));
    } catch (e) { if (gen === generation.current) setError((e as Error).message); }
    finally { if (gen === generation.current) setBusy(false); }
  }
  useEffect(() => {
    generation.current++; setDetail(null); setSummary(null); setSelected(""); setReviewed([]); setReason(""); setItems([]);
    void refresh();
    return () => { generation.current++; };
  }, [challenge, activeProject]);

  async function open(item: ApprovalItem) {
    if (busy || mutation.current) return;
    const gen = generation.current;
    setSelected(item.id); setSummary(item); setDetail(null); setReviewed([]); setReason(""); setError(""); setNotice("");
    if (item.state === "invalid") return;
    setBusy(true);
    try {
      const result = await requestApproval<ApprovalDetail>(challenge, { operation: "detail", messageId: item.id });
      if (gen === generation.current) setDetail(result);
    } catch (e) { if (gen === generation.current) setError((e as Error).message); }
    finally { if (gen === generation.current) setBusy(false); }
  }

  async function archiveItem(event: React.MouseEvent<HTMLButtonElement>, item: ApprovalItem) {
    if (!event.isTrusted || busy || mutation.current || item.state === "running") return;
    const gen = generation.current;
    mutation.current = true; setBusy(true); setError("");
    try {
      await requestApproval(challenge, { operation: item.archived ? "unarchive" : "archive", messageId: item.id });
      if (gen !== generation.current) return;
      setDetail(null); setSummary(null); setSelected("");
      await refresh();
      if (gen === generation.current) setNotice("已整理显示。原记录保留；归档不会撤销授权、执行命令或终止进程。");
    } catch (e) { if (gen === generation.current) setError((e as Error).message); }
    finally { mutation.current = false; if (gen === generation.current) setBusy(false); }
  }

  async function decide(event: React.MouseEvent<HTMLButtonElement>, decision: string) {
    if (!event.isTrusted || !detail || busy || mutation.current) return;
    const gen = generation.current;
    mutation.current = true; setBusy(true); setError("");
    try {
      await requestApproval(challenge, { operation: "decide", messageId: selected, revision: detail.revision, decision, reviewed, reason });
      if (gen !== generation.current) return;
      setDetail(await requestApproval<ApprovalDetail>(challenge, { operation: "detail", messageId: selected }));
      await refresh();
      if (gen === generation.current) setNotice(decision === "approve" ? "已批准本次任务，等待接收方继续。没有自动启动命令或唤醒代理。" : "决定已登记。撤销不会终止已运行的进程；退回原因可由接收方读取。");
    } catch (e) {
      if (gen === generation.current) { setError((e as Error).message); setDetail(null); }
    } finally { mutation.current = false; if (gen === generation.current) setBusy(false); }
  }
  const status = detail?.status;
  const allPending = status?.operations.every((op) => op.state === "pending");
  const risks = Object.entries(status?.risk_findings ?? {}).filter(([, reasons]) => reasons.length > 0).map(([id]) => id);
  const canApprove = status?.protocol_current && !status.revoked_at && allPending && !status.approved_at;
  const pendingItems = items.filter((item) => !item.archived && item.state === "pending");
  const archivedItems = items.filter((item) => item.archived);
  const visible = filter === "archived" ? archivedItems : filter === "all" ? items.filter((item) => !item.archived) : pendingItems;
  const selectedItem = items.find((item) => item.id === selected) || summary;

  return <section className="approval-center" aria-label="审批中心">
    <header className="approval-heading">
      <div><h2>审批中心</h2><p>审阅代理交接的具体操作，再决定是否允许执行。</p></div>
      <button className="button secondary" disabled={busy} onClick={() => { setDetail(null); setSummary(null); setSelected(""); void refresh(); }}>刷新</button>
    </header>
    <div className="approval-heading" aria-label="审批范围">
      <span>审批范围：{activeProject === null ? "全部已接入项目" : activeProject === undefined ? "尚未选择" : "当前项目"}</span>
      {activeProject !== null ? <button className="button secondary" disabled={busy} onClick={() => setScope("all")}>查看所有项目审批</button>
        : project !== null && project !== undefined && <button className="button secondary" disabled={busy} onClick={() => setScope("current")}>仅查看当前项目</button>}
    </div>
    {activeProject === undefined && <div className="approval-notice" role="status">当前项目尚未绑定本地目录，尚未查询审批信箱。点击“查看所有项目审批”即可查看已接入项目的申请，无需修改当前任务的目录绑定。</div>}
    {error && <div className="approval-alert" role="alert">{error}</div>}
    {notice && <div className="approval-notice" role="status">{notice}</div>}
    <div className="approval-layout">
      <aside className="approval-inbox">
        <div className="view-tabs"><button disabled={!loaded} className={`view-tab${filter === "pending" ? " active" : ""}`} onClick={() => setFilter("pending")}>待审批 · {loaded ? pendingItems.length : "未查询"}</button><button disabled={!loaded} className={`view-tab${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>当前记录</button><button disabled={!loaded} className={`view-tab${filter === "archived" ? " active" : ""}`} onClick={() => setFilter("archived")}>已归档 · {loaded ? archivedItems.length : "未查询"}</button></div>
        {!visible.length && <p className="approval-empty">{busy ? "正在读取…" : !loaded ? error ? "读取未完成，请刷新重试" : "选择审批范围后显示申请" : "没有符合条件的申请"}</p>}
        {visible.map((item) => <button key={item.id} disabled={busy} className={`approval-inbox-item${selected === item.id ? " selected" : ""}`} onClick={() => void open(item)}>
          <span className="approval-state">{labels[item.state] || item.state}</span><strong>{item.objective}</strong>
          <small>{item.sender} → {item.receiver} · {item.task_id}</small>
        </button>)}
      </aside>
      <article className="approval-detail" aria-busy={busy}>
        {selectedItem && <section className="approval-notice"><strong>{selectedItem.objective}</strong><p>{selectedItem.archived ? "已归档，可恢复到当前记录。" : "不再需要或无法打开的旧申请可从待办归档。"}原申请、人工决定和执行记录均保留。归档只整理显示，不撤销仍有效的授权；需要停止未执行操作时请先使用撤销授权。</p><button className="button secondary" disabled={busy || selectedItem.state === "running"} onClick={(event) => void archiveItem(event, selectedItem)}>{selectedItem.archived ? "恢复到当前记录" : "归档此申请"}</button>{selectedItem.state !== "invalid" && <button className="button secondary" disabled={busy} onClick={() => void open(selectedItem)}>核对执行结果</button>}{selectedItem.state === "invalid" && <p>此申请无法核验，仅显示列表摘要，不能批准或执行。</p>}</section>}
        {!detail || !status ? <div className="approval-empty"><h3>先了解影响，再作决定</h3><p>{busy ? "正在核对任务与执行记录…" : "选择左侧申请，查看中文说明、风险和执行结果。"}</p><p>收件和任务认领都不代表已经批准。</p></div> : <>
          <span className="approval-eyebrow">申请方声明 · 仍需核验</span>
          <h2>{status.package.objective}</h2><p className="approval-scope">{status.package.scope}</p>
          <dl className="approval-facts"><div><dt>项目目录</dt><dd>{status.package.project}</dd></div><div><dt>申请方</dt><dd>{detail.message.envelope.sender}</dd></div><div><dt>执行方</dt><dd>{status.package.receiver} · {status.package.session}</dd></div><div><dt>批准范围</dt><dd>仅下列 {status.package.operations.length} 项确切操作，每项最多执行一次</dd></div><div><dt>停止条件</dt><dd>内容变化、失败、超时或撤销时停止后续操作</dd></div></dl>
          {!status.protocol_current && <div className="approval-alert">此任务属于旧协议，仅供查看。请发送新任务包重新审查。</div>}
          {status.revoked_at && <div className="approval-notice">此任务已撤销或退回，不能继续执行未开始的操作。</div>}
          {status.approved_at && <div className="approval-notice">批准已登记：{new Date(status.approved_at).toLocaleString("zh-CN")}</div>}
          <h3>将要执行的操作</h3>
          {status.package.operations.map((op, index) => <section className="approval-operation" key={op.id}>
            <div className="approval-operation-title"><strong>{index + 1}. {operationTitle(op)}</strong><span className="approval-state">{status.approved_at && status.operations.find((s) => s.id === op.id)?.state === "pending" ? "待执行" : labels[status.operations.find((s) => s.id === op.id)?.state ?? "pending"] || "待执行"}</span></div>
            <p><span className="approval-eyebrow">声明的影响</span><br />{op.effects}</p>
            {!(status.risk_findings[op.id]?.length) ? <p className="approval-verified">接收端识别为有限的版本/状态查询，无需额外风险复核。</p> : <div className="approval-risk"><strong>需要人工复核</strong><ul>{status.risk_findings[op.id].map((r) => <li key={r}>{riskLabels[r] || "尚未核实的风险，请查看技术详情。"}</li>)}</ul>
              {canApprove && <label><input type="checkbox" checked={reviewed.includes(op.id)} onChange={(e) => setReviewed(e.target.checked ? [...reviewed, op.id] : reviewed.filter((id) => id !== op.id))} /> 我已核对该操作的影响与范围</label>}</div>}
            {detail.patches?.filter((p) => p.operation === op.id).map((p) => <section key={p.path}><strong>文件差异：{p.path}</strong><p>“−”为删除行，“+”为新增行。差异来自声明的输入文件，不代表已执行。</p><pre>{p.text}</pre>{p.truncated && <p className="approval-alert">差异未完整展示或已变化，请退回补充后再批准。</p>}</section>)}
            {!!status.risk_findings[op.id]?.length && <p>删除目标、发送位置或文件影响若未在上方说明中列清，请退回补充；系统不会从任意脚本猜测完整影响。</p>}
            <details><summary>查看命令与文件校验详情</summary><pre>{JSON.stringify(op, null, 2)}</pre></details>
          </section>)}
          <p className="approval-boundary">当前没有操作系统级文件或网络隔离。中文说明不构成安全证明；无法核实的影响可以退回补充。</p>
          {(canApprove || (!status.revoked_at && status.operations.some((op) => op.state === "pending"))) && <div className="approval-actions">
            <label htmlFor="approval-reason">备注 / 退回原因</label><textarea id="approval-reason" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：请列出将删除的文件，或补充修改前后差异。" />
            <div>{canApprove && <><button className="button primary" disabled={busy || risks.some((id) => !reviewed.includes(id))} onClick={(e) => void decide(e, "approve")}>批准本次任务</button><button className="button secondary" disabled={busy || !reason.trim()} onClick={(e) => void decide(e, "return")}>退回修改</button><button className="button secondary" disabled={busy || !reason.trim()} onClick={(e) => void decide(e, "reject")}>拒绝</button></>}
            {status.approved_at && !status.revoked_at && <button className="button secondary" disabled={busy} onClick={(e) => void decide(e, "revoke")}>撤销未执行的授权</button>}</div>
          </div>}
          {!!detail.outputs.length && <><h3>已核对的执行输出</h3>{detail.outputs.map((out) => <section className="approval-operation" key={out.id}><strong>{out.id} · 退出码 {out.exit_code}</strong><pre>{out.text}</pre>{out.truncated && <small>仅显示前 16 KiB；完整输出保存在本地。</small>}</section>)}</>}
          {!!detail.reports.length && <><h3>接收方报告 · 对方提供的数据</h3>{detail.reports.map((report, i) => <pre key={i}>{report}</pre>)}</>}
          {!!detail.history.length && <><h3>人工决策记录</h3>{detail.history.map((h, i) => <p key={i}>{new Date(h.at).toLocaleString("zh-CN")} · {labels[h.decision]} {h.reason}</p>)}</>}
          <details><summary>任务与版本校验详情</summary><pre>{status.task_id}{"\n"}{status.sha256}</pre></details>
        </>}
      </article>
    </div>
  </section>;
}
