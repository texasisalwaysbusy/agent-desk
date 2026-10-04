import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CdpLoopbackConnection } from "../../scripts/codex-cdp-loopback-candidate.mjs";

export const chrome = [process.env.CHROME_BIN, process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find(p => p && existsSync(p));
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Only our freshly spawned headless Chrome and disposable synthetic profile.
// Never discovers, attaches to, or terminates Codex or an existing browser.
export async function offlineBrowser(url, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-desk-offline-browser-"));
  const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", `--user-data-dir=${directory}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let page, browser;
  try {
    let descriptor;
    for (let n = 0; n < 300; n++) {
      try { descriptor = await readFile(path.join(directory, "DevToolsActivePort"), "utf8"); break; } catch {}
      if (child.exitCode !== null) throw new Error("Owned offline Chrome exited before ready");
      await delay(50);
    }
    assert.ok(descriptor, "Owned offline Chrome did not publish its port");
    const [port, socket] = descriptor.trim().split(/\r?\n/);
    assert.match(port, /^\d+$/); assert.match(socket, /^\/devtools\/browser\/[\w-]+$/);
    browser = new CdpLoopbackConnection(`ws://127.0.0.1:${port}${socket}`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(t => t.type === "page" && t.url === "about:blank");
    assert.ok(target); assert.ok(target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`));
    page = new CdpLoopbackConnection(target.webSocketDebuggerUrl);
    await page.send("Page.enable"); await page.send("Page.navigate", { url });
    return await callback(page);
  } finally {
    page?.close();
    if (browser) { try { await browser.send("Browser.close"); } catch {} browser.close(); }
    for (let n = 0; n < 60 && child.exitCode === null; n++) await delay(50);
    if (child.exitCode === null) { child.kill(); await delay(200); }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("agent-desk-offline-browser-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
