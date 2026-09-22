// Isolated visual fixture: never loads a real mailbox or writes an approval.
import { createServer } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ configFile: path.join(root, "web/vite.config.ts"),
  plugins: [{ name: "isolated-approval-fixture", configureServer(s) { s.middlewares.use(handlePreview); } }],
  server: { host: "127.0.0.1", port: 0, strictPort: false } });
const fixture = {
  message: { envelope: { sender: "codex", body: "隔离界面样本" } },
  revision: "a".repeat(64), outputs: [], reports: [], history: [],
  status: { task_id: "visual-fixture-001", sha256: "b".repeat(64), approved_at: null, revoked_at: null, protocol_current: true,
    risk_findings: { "python-version": [] }, operations: [{ id: "python-version", state: "pending", result: null }],
    package: { objective: "检查项目 Python 是否正常", scope: "仅查询版本并保存执行记录。不会安装软件或修改业务文件。", project: "示例项目（隔离测试）", receiver: "hermes", session: "fixture-session",
      operations: [{ id: "python-version", argv: ["C:\\Example\\python.exe", "--version"], cwd: "C:\\Example", inputs: {}, effects: "输出程序版本，保存本次查询结果。此查询无需联网。", timeout_seconds: 10 }] } },
};
async function handlePreview(req, res, next) {
  const frame = req.url?.startsWith("/__approval-frame");
  if (!frame && !req.url?.startsWith("/__approval-preview")) return next();
  const body = frame
    ? `<div id="root" style="height:100vh;display:flex;flex-direction:column"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ApprovalCenter} from '/src/components/ApprovalCenter.tsx';
import {setEmbeddedFrameChallenge} from '/src/embeddedHost.mjs'; import '/src/styles.css';
setEmbeddedFrameChallenge('visual-fixture'); globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__='fixture';
window.addEventListener('message',e=>{if(e.data.type==='fixture-theme')document.documentElement.dataset.theme=e.data.theme;});
createRoot(document.getElementById('root')).render(React.createElement(ApprovalCenter,{challenge:'visual-fixture',project:undefined}));
</script>`
    : `<div style="padding:12px 20px;background:#ececed;font:14px 'Segoe UI',sans-serif">Agent Desk / 审批中心 · 隔离视觉样本（不连接真实信箱） <button id="theme">切换深浅主题</button></div><iframe id="preview" src="/__approval-frame" style="width:100%;height:calc(100vh - 46px);border:0"></iframe><script>
const fixture=${JSON.stringify(fixture)}; let dark=false;
document.querySelector('#theme').onclick=()=>{dark=!dark;document.querySelector('iframe').contentWindow.postMessage({type:'fixture-theme',theme:dark?'dark':'light'},location.origin)};
window.addEventListener('message',e=>{
 if(e.source!==document.querySelector('iframe').contentWindow||e.data.type!=='taskboard:approval-request')return;
 const {requestId,request}=e.data.payload; let result={};
 if(request.operation==='list')result={items:[{id:'00000000-0000-4000-8000-000000000001',task_id:'visual-fixture-001',objective:fixture.status.package.objective,sender:'codex',receiver:'hermes',project:'示例项目',session:'fixture-session',state:fixture.status.approved_at?'approved':'pending'}]};
 if(request.operation==='detail')result=fixture;
 if(request.operation==='decide'){fixture.status.approved_at=new Date().toISOString();fixture.history.push({decision:request.decision,reason:request.reason,at:fixture.status.approved_at}); result={executed:false};}
 e.source.postMessage({type:'taskboard:approval-response',challenge:'visual-fixture',payload:{requestId,ok:true,...result}},location.origin);
});</script>`;
  const html = await server.transformIndexHtml(req.url, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Agent Desk 审批界面验证</title></head><body style="margin:0">${body}</body></html>`);
  res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html);
}
await server.listen();
console.log(`FIXTURE_URL=http://127.0.0.1:${server.httpServer.address().port}/__approval-preview`);
process.once("SIGINT", async () => { await server.close(); process.exit(0); });
