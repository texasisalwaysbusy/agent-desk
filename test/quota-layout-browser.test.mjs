import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const chrome = [process.env.CHROME_BIN, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].find((candidate) => candidate && existsSync(candidate));
const source = await readFile(new URL("../inject/codex-quota-display.user.js", import.meta.url), "utf8");

function fixture({ width, zoom, reset }) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    ${reset ? "*,::before,::after { box-sizing:border-box; margin:0; padding:0; border:0 solid; }" : ""}
    html,body { margin:0; font-family:system-ui; background:white; }
    body { zoom:${zoom}; }
    aside { position:relative; width:${width}px; height:420px; background:#f5f5f5; overflow:hidden; }
    nav { height:100%; display:flex; flex-direction:column; }
    [data-app-action-sidebar-scroll] { flex:1; min-height:0; overflow:auto; }
    .tasks { height:900px; padding:16px; }
    footer { position:absolute; bottom:0; left:0; right:0; height:40px; padding:8px 16px;
      box-sizing:border-box; background:#ddd9; z-index:2; display:flex; justify-content:space-between; }
    [data-settings-panel-slug] { width:400px; height:300px; }
  </style><aside class="app-shell-left-panel"><nav><div data-app-action-sidebar-scroll><div class="tasks">模拟会话列表</div></div></nav>
  <footer><button>◉ 用户</button><button>语音</button></footer></aside><pre id="result"></pre>
  <script>
    const attach = HTMLElement.prototype.attachShadow;
    let shadow;
    HTMLElement.prototype.attachShadow = function(options) {
      const value = attach.call(this, options);
      if (this.id === 'codex-taskboard-quota-display') shadow = value;
      return value;
    };
    const nativeBefore = document.querySelector('aside').outerHTML;
    (0,eval)(${JSON.stringify(source)});
    const api = window.__codexTaskboardQuotaDisplay__;
    const snapshot = {schemaVersion:1,fetchedAtMs:Date.now(),buckets:[{id:'codex',windows:[
      {kind:'primary',remainingPercent:47,durationMinutes:300,resetsAtMs:Date.now()+8100000},
      {kind:'secondary',remainingPercent:38,durationMinutes:10080,resetsAtMs:Date.now()+360000000}
    ]}]};
    const rect = (element) => element.getBoundingClientRect();
    const host = document.getElementById('codex-taskboard-quota-display');
    function measure() {
      const card = rect(shadow.querySelector('.quota-card'));
      const footer = rect(document.querySelector('footer'));
      const sidebar = rect(document.querySelector('aside'));
      const reset = rect([...shadow.querySelectorAll('.quota-reset')].at(-1));
      return { gap:(footer.top-card.bottom)/${zoom}, margin:getComputedStyle(host).marginBottom,
        fits:card.top>=sidebar.top && card.left>=sidebar.left && card.right<=sidebar.right,
        resetVisible:reset.bottom<=footer.top && reset.width>0,
        scrollable:document.querySelector('[data-app-action-sidebar-scroll]').clientHeight>0,
        visible:api.status().mounted };
    }
    api.update(snapshot);
    const initial = measure();
    api.update(snapshot);
    const refreshed = measure();
    const settings = document.createElement('section');
    settings.dataset.settingsPanelSlug = 'general';
    document.body.append(settings);
    api.heartbeat();
    const hiddenInSettings = !api.status().mounted && rect(host).height===0;
    settings.remove();
    api.heartbeat();
    const restored = measure();
    api.cleanup();
    const clean = !document.getElementById('codex-taskboard-quota-display')
      && document.querySelector('aside').outerHTML===nativeBefore;
    api.mount(); api.update(snapshot);
    document.getElementById('result').textContent=JSON.stringify({initial,refreshed,hiddenInSettings,restored,clean});
  </script></html>`;
}

test("quota layout survives outer CSS reset, resizing and refresh without covering the footer", {
  skip: !chrome && "Chrome/Chromium unavailable for layout verification",
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "taskboard-quota-layout-"));
  try {
    for (const scenario of [
      { name: "reset", width: 280, zoom: 1, reset: true },
      { name: "narrow", width: 200, zoom: 1, reset: true },
      { name: "zoomed", width: 240, zoom: 1.5, reset: true },
      { name: "zoom200", width: 200, zoom: 2, reset: true },
      { name: "no-reset", width: 280, zoom: 1, reset: false },
    ]) {
      const html = path.join(temporary, `${scenario.name}.html`);
      await writeFile(html, fixture(scenario));
      const profile = await mkdtemp(path.join(temporary, "chrome-"));
      const screenshot = process.env.QUOTA_LAYOUT_SCREENSHOT_DIR
        ? [`--screenshot=${path.resolve(process.env.QUOTA_LAYOUT_SCREENSHOT_DIR, `${scenario.name}.png`)}`] : [];
      const { stdout } = await promisify(execFile)(chrome, [
        "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--disable-extensions", `--user-data-dir=${profile}`, "--window-size=700,1050", "--dump-dom",
        ...screenshot, pathToFileURL(html).href,
      ], { timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
      const result = JSON.parse(stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] || "null");
      assert.ok(result, `${scenario.name}: browser must return layout measurements`);
      for (const phase of ["initial", "refreshed", "restored"]) {
        assert.ok(result[phase].gap >= 7.5, `${scenario.name}/${phase}: ${JSON.stringify(result[phase])}`);
        assert.equal(result[phase].fits, true);
        assert.equal(result[phase].resetVisible, true);
        assert.equal(result[phase].scrollable, true);
        assert.equal(result[phase].visible, true);
      }
      assert.equal(result.hiddenInSettings, true, "Settings must hide the card in actual layout");
      assert.equal(result.clean, true, "cleanup must restore unchanged native elements");
      console.log(JSON.stringify({ scenario: scenario.name, ...result }));
    }
  } finally {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("taskboard-quota-layout-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});
