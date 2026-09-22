import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pluginServer = new URL("../plugins/taskboard-activity/mcp/server.mjs", import.meta.url);
const pluginServerPath = fileURLToPath(pluginServer);

function send(child, payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

test("the Taskboard plugin is a descriptor-only thin client for the authenticated loopback API", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-plugin-"));
  const runtimeFile = path.join(directory, "launcher-runtime.json");
  const requests = [];
  const task = {
    identifier: "LOCAL-1", projectId: "local", title: "Review", description: "private body",
    status: "todo", priority: "high", labels: ["security"], assignee: null,
    threadId: null, version: 2, updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/runtime-token-1234/api/projects") {
      response.end(JSON.stringify({ projects: [{ id: "local", name: "Local", workspacePath: directory, issueCount: 1 }] }));
      return;
    }
    if (request.url === "/runtime-token-1234/api/tasks") {
      requests.push({ method: request.method, url: request.url });
      response.end(JSON.stringify({ tasks: [task] }));
      return;
    }
    if (request.url === "/runtime-token-1234/api/tasks/LOCAL-1" && request.method === "GET") {
      requests.push({ method: request.method, url: request.url });
      response.end(JSON.stringify({ task }));
      return;
    }
    if (request.url === "/runtime-token-1234/api/tasks/LOCAL-1/comments" && request.method === "GET") {
      requests.push({ method: request.method, url: request.url });
      response.end(JSON.stringify({ comments: [] }));
      return;
    }
    if (request.url === "/runtime-token-1234/api/tasks/LOCAL-1" && request.method === "PATCH") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        requests.push({ method: request.method, url: request.url, body: payload });
        if (payload.version !== task.version) {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "stale task" } }));
          return;
        }
        task.status = payload.status;
        task.assignee = { type: "agent", id: "codex-agent", name: "Codex Agent" };
        task.threadId = payload.threadId;
        task.version += 1;
        response.end(JSON.stringify({ task }));
      });
      return;
    }
    if (request.url === "/runtime-token-1234/api/local/launcher/open" && request.method === "POST") {
      requests.push({ method: request.method, url: request.url });
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await writeFile(runtimeFile, JSON.stringify({
    version: 1,
    pid: process.pid,
    url: `http://127.0.0.1:${address.port}/runtime-token-1234`,
  }));

  const child = spawn(process.execPath, [pluginServerPath], {
    env: {
      ...process.env,
      CODEX_TASKBOARD_RUNTIME_FILE: runtimeFile,
      CODEX_THREAD_ID: "codex-task-current",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const replies = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => replies.push(JSON.parse(line)));
  const waitFor = async (id) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const reply = replies.find((candidate) => candidate.id === id);
      if (reply) return reply;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for MCP reply ${id}: ${stderr}`);
  };

  try {
    send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    assert.equal((await waitFor(1)).result.serverInfo.name, "taskboard-activity");
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_taskboard_activity", arguments: {} } });
    const activity = (await waitFor(2)).result.structuredContent;
    assert.equal(activity.tasks[0].identifier, "LOCAL-1");
    assert.equal("description" in activity.tasks[0], false);
    assert.equal("workspacePath" in activity.projects[0], false);

    send(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "open_full_taskboard", arguments: {} } });
    assert.equal((await waitFor(3)).result.structuredContent.queued, true);
    assert.deepEqual(requests.at(-1), {
      method: "POST",
      url: "/runtime-token-1234/api/local/launcher/open",
    });

    send(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_taskboard_issue", arguments: { identifier: "LOCAL-1" } } });
    assert.equal((await waitFor(4)).result.structuredContent.task.version, 2);

    send(child, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "claim_taskboard_issue", arguments: { identifier: "LOCAL-1", version: 2 } } });
    const claimed = (await waitFor(5)).result.structuredContent.task;
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.threadOwned, true);
    assert.deepEqual(requests.at(-1), {
      method: "PATCH",
      url: "/runtime-token-1234/api/tasks/LOCAL-1",
      body: {
        version: 2,
        status: "in_progress",
        assigneeTarget: "codex-agent",
        threadId: "codex-task-current",
      },
    });

    send(child, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "claim_taskboard_issue", arguments: { identifier: "LOCAL-1", version: 2 } } });
    const staleClaim = await waitFor(6);
    assert.equal(staleClaim.result.isError, true);
    assert.match(staleClaim.result.structuredContent.error, /version changed/);
    assert.equal(requests.filter((request) => request.method === "PATCH").length, 1);

    const source = await readFile(pluginServer, "utf8");
    assert.doesNotMatch(source, /node:sqlite|Cookies|Login Data|\.codex|\.hermes/);
    assert.match(source, /if \(current\.status !== "todo"\) throw new Error\("only todo tasks can be claimed"\)/);
    assert.match(source, /if \(current\.threadId && current\.threadId !== threadId\) throw new Error\("task is already owned by another Codex task"\)/);
    assert.match(source, /assigneeTarget: "codex-agent"/);
    assert.doesNotMatch(source, /sortOrder:/);
    const mcpConfig = JSON.parse(await readFile(new URL("../plugins/taskboard-activity/.mcp.json", import.meta.url), "utf8"));
    assert.deepEqual(mcpConfig.mcpServers.taskboard_activity.env_vars, ["LOCALAPPDATA", "CODEX_THREAD_ID"]);
  } finally {
    child.kill();
    lines.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
