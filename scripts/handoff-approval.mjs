import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createApprovalArchive } from "./approval-archive.mjs";

export function validApprovalRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = ["operation", "project", "messageId", "revision", "decision", "reviewed", "reason"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (value.operation === "list") return value.project === null || value.project === undefined
    || (typeof value.project === "string" && value.project.length <= 4096 && path.isAbsolute(value.project));
  if (typeof value.messageId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.messageId)) return false;
  if (value.operation === "detail") return true;
  if (["archive", "unarchive"].includes(value.operation)) return Object.keys(value).every((key) => ["operation", "messageId"].includes(key));
  return value.operation === "decide"
    && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)
    && ["approve", "reject", "return", "revoke"].includes(value.decision)
    && Array.isArray(value.reviewed) && value.reviewed.length <= 50
    && value.reviewed.every((id) => typeof id === "string" && /^[a-z0-9_.-]{1,96}$/i.test(id))
    && typeof value.reason === "string" && value.reason.length <= 2000;
}

export function createApprovalAdapter(configPath) {
  let active = 0;
  const archive = createApprovalArchive(path.join(path.dirname(configPath), "approval-archive.json"));
  return async (request) => {
    if (!validApprovalRequest(request)) throw new Error("无效的审批请求");
    if (active >= 4) throw new Error("审批中心正忙，请稍后重试");
    active++;
    try {
      let config;
      try { config = JSON.parse(await readFile(configPath, "utf8")); }
      catch { throw new Error("审批中心尚未接入本地交接服务，请完成 Agent Desk 部署"); }
      if (config.version !== 1 || ![config.python, config.mailbox, config.root].every((p) => typeof p === "string" && path.isAbsolute(p))
        || !Array.isArray(config.projects) || !config.projects.length || config.projects.length > 100
        || !config.projects.every((p) => typeof p === "string" && path.isAbsolute(p))
        || path.resolve(config.python) !== path.join(path.resolve(config.root), ".venv", "Scripts", "python.exe")
        || path.resolve(config.mailbox) !== path.join(path.resolve(config.root), "data", "mailbox.sqlite3")) {
        throw new Error("审批中心本地配置不兼容");
      }
      const key = randomBytes(32).toString("hex");
      const viewChange = ["archive", "unarchive"].includes(request.operation);
      const adapterRequest = viewChange ? { operation: "list", project: null } : request;
      const body = JSON.stringify({ mailbox: config.mailbox, projects: config.projects, request: adapterRequest });
      const packet = JSON.stringify({ body, mac: createHmac("sha256", key).update(body).digest("hex") });
      const result = await new Promise((resolve, reject) => {
        const env = { AGENT_DESK_PRIVATE_PIPE_KEY: key };
        for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
        const child = spawn(config.python, ["-I", "-X", "utf8", "-m", "handoff_mcp.desktop"], {
          cwd: config.root, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        let failed = false;
        const fail = (message) => { if (failed) return; failed = true; child.kill(); reject(new Error(message)); };
        const timer = setTimeout(() => fail("审批服务超时，请刷新核对状态；不要重复提交"), 20000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (Buffer.byteLength(output) > 3 * 1024 * 1024) fail("审批结果超过大小限制");
        });
        child.stderr.resume();
        child.on("error", () => fail("无法启动本地审批适配器"));
        child.stdin.on("error", () => fail("本地审批通道已关闭"));
        child.on("close", (code) => {
          clearTimeout(timer);
          if (failed) return;
          try {
            const response = JSON.parse(output);
            if (code !== 0 || !response.ok) throw new Error(response.error || "本地审批服务失败");
            resolve(response.result);
          } catch (error) { reject(new Error(error.message || "审批响应无效")); }
        });
        child.stdin.end(`${packet}\n`);
      });
      if (viewChange) return await archive.set(request.messageId, request.operation === "archive", result.items);
      if (request.operation === "list") return { ...result, items: await archive.decorate(result.items) };
      return result;
    } finally { active--; }
  };
}
