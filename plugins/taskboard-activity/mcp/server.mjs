#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "taskboard-activity";
const SERVER_VERSION = "0.1.0";
const WIDGET_URI = "ui://taskboard-activity/activity.html";
const WIDGET_MIME = "text/html;profile=mcp-app";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widgetHtml = await readFile(path.join(pluginRoot, "mcp", "widget.html"), "utf8");
const statuses = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
const automationIntervals = [5, 10, 15, 30, 60];

function schema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function runtimeFile() {
  const testOverride = process.env.CODEX_TASKBOARD_RUNTIME_FILE?.trim();
  if (testOverride) return path.resolve(testOverride);
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable");
  const current = path.join(localAppData, "AgentDesk", "runtime", "launcher-runtime.json");
  const legacy = path.join(localAppData, "DashiTaskboard", "runtime", "launcher-runtime.json");
  if (existsSync(current) && existsSync(legacy)) throw new Error("Multiple Agent Desk runtime descriptors found; select an explicit runtime file");
  return existsSync(legacy) ? legacy : current;
}

async function runtimeDescriptor() {
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(runtimeFile(), "utf8"));
  } catch {
    throw new Error("Agent Desk is not running; start it from the tray launcher");
  }
  const url = new URL(descriptor?.url);
  if (
    descriptor?.version !== 1
    || !Number.isInteger(descriptor?.pid)
    || descriptor.pid < 1
    || url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !/^\/[a-z0-9-]{16,128}$/i.test(url.pathname.replace(/\/$/, ""))
  ) throw new Error("Taskboard runtime descriptor is invalid");
  return { pid: descriptor.pid, baseUrl: url.href.replace(/\/$/, "") };
}

async function api(method, pathname, body) {
  const runtime = await runtimeDescriptor();
  const response = await fetch(`${runtime.baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "taskctl",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Taskboard request failed (${response.status})`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function identifier(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Z][A-Z0-9-]{0,63}-\d{1,12}$/i.test(normalized)) {
    throw new Error("identifier is invalid");
  }
  return normalized;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("version must be a positive integer");
  return value;
}

function currentThreadId() {
  const value = process.env.CODEX_THREAD_ID?.trim() || "";
  if (!value || value.length > 256 || value.includes("\0")) {
    throw new Error("current Codex task attribution is unavailable");
  }
  return value;
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    issueCount: project.issueCount,
  };
}

function publicTask(task) {
  return {
    identifier: task.identifier,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    assigneeName: task.assignee?.name ?? null,
    threadOwned: Boolean(task.threadId),
    version: task.version,
    updatedAt: task.updatedAt,
  };
}

async function activity(args) {
  const query = new URLSearchParams();
  if (args.project_id) query.set("projectId", String(args.project_id));
  if (args.status) query.set("status", String(args.status));
  const [projectsPayload, tasksPayload] = await Promise.all([
    api("GET", "/api/projects"),
    api("GET", `/api/tasks${query.size ? `?${query}` : ""}`),
  ]);
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
  const tasks = tasksPayload.tasks
    .slice()
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, limit)
    .map(publicTask);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    projects: projectsPayload.projects.map(publicProject),
    tasks,
    counts: Object.fromEntries(statuses.map((status) => [
      status,
      tasksPayload.tasks.filter((task) => task.status === status).length,
    ])),
  };
}

async function issue(args) {
  const id = identifier(args.identifier);
  const [taskPayload, commentsPayload] = await Promise.all([
    api("GET", `/api/tasks/${encodeURIComponent(id)}`),
    api("GET", `/api/tasks/${encodeURIComponent(id)}/comments`),
  ]);
  const task = taskPayload.task;
  return {
    ok: true,
    task: {
      ...publicTask(task),
      description: task.description,
      startDate: task.startDate,
      dueDate: task.dueDate,
      relations: task.relations,
      developmentContext: task.developmentContext,
      threadId: task.threadId,
    },
    comments: commentsPayload.comments.map((comment) => ({
      body: comment.body,
      authorName: comment.author?.name ?? null,
      version: comment.version,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
  };
}

async function claim(args) {
  const id = identifier(args.identifier);
  const expectedVersion = version(args.version);
  const threadId = currentThreadId();
  const current = (await api("GET", `/api/tasks/${encodeURIComponent(id)}`)).task;
  if (current.version !== expectedVersion) throw new Error("task version changed; read it again before claiming");
  if (current.status !== "todo") throw new Error("only todo tasks can be claimed");
  if (current.threadId && current.threadId !== threadId) throw new Error("task is already owned by another Codex task");
  const result = await api("PATCH", `/api/tasks/${encodeURIComponent(id)}`, {
    version: expectedVersion,
    status: "in_progress",
    assigneeTarget: "codex-agent",
    threadId,
  });
  return { ok: true, task: publicTask(result.task) };
}

async function move(args) {
  const id = identifier(args.identifier);
  const expectedVersion = version(args.version);
  if (!statuses.includes(args.status)) throw new Error("status is invalid");
  if (args.status === "in_progress") throw new Error("use claim_taskboard_issue to enter in_progress");
  const threadId = currentThreadId();
  const current = (await api("GET", `/api/tasks/${encodeURIComponent(id)}`)).task;
  if (current.version !== expectedVersion) throw new Error("task version changed; read it again before moving");
  if (current.threadId && current.threadId !== threadId) throw new Error("task is owned by another Codex task");
  const result = await api("POST", `/api/tasks/${encodeURIComponent(id)}/move`, {
    version: expectedVersion,
    status: args.status,
    threadId,
  });
  return { ok: true, task: publicTask(result.task) };
}

async function addComment(args) {
  const id = identifier(args.identifier);
  const body = String(args.body ?? "").trim();
  if (!body || body.length > 100_000) throw new Error("comment body is invalid");
  const threadId = currentThreadId();
  const current = (await api("GET", `/api/tasks/${encodeURIComponent(id)}`)).task;
  if (current.threadId !== threadId) throw new Error("comments require ownership by the current Codex task");
  const result = await api("POST", `/api/tasks/${encodeURIComponent(id)}/comments`, { body, threadId });
  return { ok: true, comment: { version: result.comment.version, createdAt: result.comment.createdAt } };
}

async function openFullBoard() {
  await api("POST", "/api/local/launcher/open");
  return { ok: true, queued: true };
}

async function prepareAutomation(args) {
  const projectId = String(args.project_id ?? "").trim();
  const action = args.action;
  const interval = Number(args.interval_minutes);
  if (!projectId || !["enable", "pause"].includes(action)) throw new Error("automation request is invalid");
  if (!automationIntervals.includes(interval)) throw new Error("automation interval is unsupported");
  const project = (await api("GET", "/api/projects")).projects.find((item) => item.id === projectId);
  if (!project?.workspacePath || !path.isAbsolute(project.workspacePath)) {
    throw new Error("project has no registered local workspace");
  }
  const request = {
    kind: "taskboard-auto-claim",
    version: 1,
    action,
    projectId,
    projectName: project.name,
    workspacePath: project.workspacePath,
    intervalMinutes: interval,
    model: String(args.model ?? ""),
    reasoningEffort: String(args.reasoning_effort ?? ""),
  };
  return {
    ok: true,
    request,
    followUpMessage: `TASKBOARD_AUTOMATION_REQUEST_V1 ${JSON.stringify(request)}`,
  };
}

function toolDefinitions() {
  const filters = schema({
    project_id: { type: "string" },
    status: { type: "string", enum: statuses },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  return [
    { name: "list_taskboard_activity", title: "List Taskboard activity", description: "List local activity without exposing paths or comment text.", inputSchema: filters, annotations: readOnly },
    { name: "get_taskboard_issue", title: "Get a Taskboard issue", description: "Read one issue and its comments.", inputSchema: schema({ identifier: { type: "string" } }, ["identifier"]), annotations: readOnly },
    { name: "show_taskboard_activity", title: "Show Taskboard activity", description: "Show the compact local activity component.", inputSchema: filters, annotations: readOnly, _meta: uiMeta() },
    { name: "open_full_taskboard", title: "Open full Taskboard", description: "Ask the validated launcher to focus the embedded full Taskboard.", inputSchema: schema({}), annotations: write },
    { name: "claim_taskboard_issue", title: "Claim a Taskboard issue", description: "Atomically claim a todo for the current Codex task using its optimistic version.", inputSchema: schema({ identifier: { type: "string" }, version: { type: "integer", minimum: 1 } }, ["identifier", "version"]), annotations: write },
    { name: "move_taskboard_issue", title: "Move a Taskboard issue", description: "Move an owned issue using its optimistic version.", inputSchema: schema({ identifier: { type: "string" }, status: { type: "string", enum: statuses.filter((status) => status !== "in_progress") }, version: { type: "integer", minimum: 1 } }, ["identifier", "status", "version"]), annotations: write },
    { name: "add_taskboard_comment", title: "Add a Taskboard comment", description: "Add a comment to an issue owned by the current Codex task.", inputSchema: schema({ identifier: { type: "string" }, body: { type: "string" } }, ["identifier", "body"]), annotations: write },
    { name: "prepare_taskboard_automation", title: "Prepare Taskboard automation", description: "Create a structured request for official Codex Scheduled; no local timer is created.", inputSchema: schema({ project_id: { type: "string" }, action: { type: "string", enum: ["enable", "pause"] }, interval_minutes: { type: "integer", enum: automationIntervals }, model: { type: "string" }, reasoning_effort: { type: "string" } }, ["project_id", "action", "interval_minutes", "model", "reasoning_effort"]), annotations: readOnly },
  ];
}

function uiMeta() {
  return {
    ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
    "ui/resourceUri": WIDGET_URI,
    "openai/outputTemplate": WIDGET_URI,
    "openai/widgetAccessible": true,
  };
}

function toolResult(payload, render = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
    ...(render ? { _meta: uiMeta() } : {}),
  };
}

function toolError(error) {
  const payload = { ok: false, error: error?.message || String(error), code: error?.code };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

async function handle(message) {
  const { id, method, params = {} } = message ?? {};
  if (typeof method !== "string") return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } };
  if (method.startsWith("notifications/") || method === "$/cancelRequest") return null;
  if (method === "initialize") return response(id, {
    protocolVersion: params.protocolVersion || "2024-11-05",
    capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
    serverInfo: { name: SERVER_NAME, title: "Agent Desk Activity", version: SERVER_VERSION },
    instructions: "Use show_taskboard_activity to display the compact panel and open_full_taskboard for the embedded full board.",
  });
  if (method === "ping") return response(id, {});
  if (method === "tools/list") return response(id, { tools: toolDefinitions() });
  if (method === "resources/list") return response(id, { resources: [{ uri: WIDGET_URI, name: "taskboard_activity", title: "Agent Desk Activity", mimeType: WIDGET_MIME }] });
  if (method === "resources/read" && params.uri === WIDGET_URI) return response(id, { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: widgetHtml, _meta: { "openai/widgetCSP": { connect_domains: [], resource_domains: [], frame_domains: [] } } }] });
  if (method === "tools/call") {
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    try {
      const operations = {
        list_taskboard_activity: () => activity(args),
        get_taskboard_issue: () => issue(args),
        show_taskboard_activity: () => activity(args),
        open_full_taskboard: openFullBoard,
        claim_taskboard_issue: () => claim(args),
        move_taskboard_issue: () => move(args),
        add_taskboard_comment: () => addComment(args),
        prepare_taskboard_automation: () => prepareAutomation(args),
      };
      if (!operations[params.name]) throw new Error(`unknown Taskboard tool: ${params.name}`);
      return response(id, toolResult(await operations[params.name](), params.name === "show_taskboard_activity"));
    } catch (error) {
      return response(id, toolError(error));
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let outgoing;
  try {
    outgoing = await handle(JSON.parse(line));
  } catch (error) {
    outgoing = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
  }
  if (outgoing) process.stdout.write(`${JSON.stringify(outgoing)}\n`);
}
