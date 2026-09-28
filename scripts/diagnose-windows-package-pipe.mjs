import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const probeScript = fileURLToPath(new URL("./diagnose-windows-package-pipe.ps1", import.meta.url));
const windowsPowerShellRoot = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
const powerShell = path.join(windowsPowerShellRoot, "powershell.exe");
const args = process.argv.slice(2);
const preflightOnly = args.includes("--preflight-only");

if (process.platform !== "win32" || args.some((arg) => arg !== "--preflight-only")) {
  throw new Error("This Windows-only probe accepts only --preflight-only");
}

function waitForVersionReply(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let buffer = Buffer.alloc(0);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.stdio[4].on("data", (chunk) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 64 * 1024) return finish(false);
      const end = buffer.indexOf(0);
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        finish(message.id === 1 && !message.error && typeof message.result?.protocolVersion === "string");
      } catch {
        finish(false);
      }
    });
    child.stdio[4].once("end", () => finish(false));
    child.stdio[4].once("error", () => finish(false));
    child.stdio[3].write(`${JSON.stringify({ id: 1, method: "Browser.getVersion" })}\0`, (error) => {
      if (error) finish(false);
    });
  });
}

function waitForActivator(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk.slice(0, 4096); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk.slice(0, 4096); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `Activator exited ${code}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error("Activator returned invalid metadata")); }
    });
  });
}

const child = spawn(powerShell, [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probeScript,
  ...(preflightOnly ? ["-PreflightOnly"] : []),
], {
  stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, PSModulePath: path.join(windowsPowerShellRoot, "Modules") },
});

const versionReply = preflightOnly ? Promise.resolve(false) : waitForVersionReply(child, 20_000);
try {
  const activation = await waitForActivator(child);
  console.log(JSON.stringify({
    ...activation,
    privatePipeReplied: await versionReply,
    transport: "private-pipe",
    rendererInspected: false,
  }));
} catch (error) {
  await versionReply;
  console.error(error.message);
  process.exitCode = 1;
}
