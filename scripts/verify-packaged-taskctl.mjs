#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("The hardened package preflight currently supports Windows only");
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(projectRoot, "src-tauri", "target", "x86_64-pc-windows-msvc", "release");
const nodePath = path.join(releaseDirectory, "node.exe");
const appRoot = path.join(releaseDirectory, "app");
const wrapperPath = path.join(releaseDirectory, "bin", "taskctl.cmd");

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Packaged Taskboard server did not exit")),
      timeoutMs,
    )),
  ]);
}

function runTaskctl(environment, args) {
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", [
    "/d", "/c", "call", wrapperPath, ...args,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      CODEX_THREAD_ID: "00000000-0000-4000-8000-000000000001",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Packaged taskctl failed");
  }
  return JSON.parse(result.stdout);
}

async function waitForListening(server, stderr) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error(stderr.value || "Packaged server did not start")),
      15_000,
    );
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/Agent Desk listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    server.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(stderr.value || "Packaged server exited during startup"));
    });
  });
}

async function reserveLoopbackPort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a loopback port for packaged verification");
  }
  await new Promise((resolve) => reservation.close(resolve));
  return address.port;
}

await stat(nodePath);
await stat(wrapperPath);
await stat(path.join(appRoot, "node_modules", "smol-toml", "package.json"));
const wrapper = await readFile(wrapperPath, "utf8");
if (!wrapper.includes("agentdesk.mjs")) {
  throw new Error("Packaged taskctl wrapper does not use the hardened runtime descriptor");
}

const temporaryLocalAppData = await mkdtemp(path.join(os.tmpdir(), "agent-desk-packaged-cli."));
const dataDirectory = path.join(temporaryLocalAppData, "AgentDesk", "data");
const runtimeDirectory = path.join(temporaryLocalAppData, "AgentDesk", "runtime");
await mkdir(dataDirectory, { recursive: true });
await mkdir(runtimeDirectory, { recursive: true });
const instanceToken = randomUUID();
const port = await reserveLoopbackPort();
const server = spawn(nodePath, [path.join(appRoot, "server", "index.mjs")], {
  cwd: appRoot,
  env: {
    ...process.env,
    CODEX_TASKBOARD_DATA_DIR: dataDirectory,
    CODEX_TASKBOARD_HOST: "127.0.0.1",
    CODEX_TASKBOARD_PORT: String(port),
    CODEX_TASKBOARD_INSTANCE_TOKEN: instanceToken,
    CODEX_TASKBOARD_INSTANCE_SECRET: randomBytes(32).toString("hex"),
    CODEX_TASKBOARD_VERSION: "preflight",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const stderr = { value: "" };
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { stderr.value += chunk; });
try {
  const listeningPort = await waitForListening(server, stderr);
  if (listeningPort !== port) throw new Error("Packaged server listened on an unexpected port");
  await writeFile(
    path.join(runtimeDirectory, "launcher-runtime.json"),
    `${JSON.stringify({
      version: 1,
      pid: server.pid,
      url: `http://127.0.0.1:${port}/${instanceToken}`,
    })}\n`,
  );
  const environment = { LOCALAPPDATA: temporaryLocalAppData };
  const projects = runTaskctl(environment, ["project", "list", "--json"]);
  const projectId = projects.projects?.[0]?.id;
  if (!projectId) throw new Error("Packaged taskctl did not list the local project");
  const created = runTaskctl(environment, [
    "issue", "create", "--project", projectId, "--title", "Packaged taskctl preflight",
    "--status", "todo", "--thread-id", "00000000-0000-4000-8000-000000000001", "--json",
  ]).task;
  const fetched = runTaskctl(environment, ["issue", "get", created.id, "--json"]).task;
  if (fetched.title !== "Packaged taskctl preflight") throw new Error("Packaged issue get failed");
  const comment = runTaskctl(environment, [
    "comment", "add", created.id, "--body", "packaged endpoint verified",
    "--thread-id", "00000000-0000-4000-8000-000000000001", "--json",
  ]).comment;
  if (comment.body !== "packaged endpoint verified") throw new Error("Packaged comment add failed");

  server.kill("SIGTERM");
  await waitForExit(server, 10_000);
  const takeover = createServer();
  await new Promise((resolve, reject) => {
    takeover.once("error", reject);
    takeover.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => takeover.close(resolve));
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await waitForExit(server, 2_000).catch(() => {});
  }
  await rm(temporaryLocalAppData, { recursive: true, force: true });
}

console.log("Verified packaged Windows taskctl discovery, CRUD, and clean listener shutdown");
