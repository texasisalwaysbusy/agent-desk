(function codexTaskboardQuotaDisplayBootstrap() {
  "use strict";

  const GLOBAL_KEY = "__codexTaskboardQuotaDisplay__";
  const HOST_ID = "codex-taskboard-quota-display";
  const VERSION = "1.0.14";
  // Tune this single curve. Stops are remaining percentage, never spatial stops.
  // Public-domain OKLab matrices by Bjorn Ottosson; attribution in docs/quota-visuals.md.
  const COLOR_STOPS = [
    [0, "#8f2437"], [5, "#bc2938"], [15, "#e75132"], [25, "#ee8733"],
    [30, "#e2aa3a"], [35, "#a8b948"], [45, "#38ad59"], [60, "#22b465"],
    [75, "#23bc83"], [80, "#21c9ac"], [90, "#24c9d9"], [100, "#38bdf8"],
  ];
  const linear = (v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  const encoded = (v) => 255 * (v <= .0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - .055);
  const rgb = (hex) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  function toLab(color) {
    const [r, g, b] = color.map(v => linear(v / 255));
    const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
    const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
    const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
    return [.2104542553*l + .793617785*m - .0040720468*s,
      1.9779984951*l - 2.428592205*m + .4505937099*s,
      .0259040371*l + .7827717662*m - .808675766*s];
  }
  function fromLab([L, a, b]) {
    const l = (L + .3963377774*a + .2158037573*b) ** 3;
    const m = (L - .1055613458*a - .0638541728*b) ** 3;
    const s = (L - .0894841775*a - 1.291485548*b) ** 3;
    return [4.0767416621*l - 3.3077115913*m + .2309699292*s,
      -1.2684380046*l + 2.6097574011*m - .3413193965*s,
      -.0041960863*l - .7034186147*m + 1.707614701*s].map(v => Math.max(0, Math.min(255, encoded(v))));
  }
  const blend = (left, right, t) => left.map((v, i) => v + (right[i] - v) * t);
  const labs = COLOR_STOPS.map(([p, hex]) => [p, toLab(rgb(hex))]);
  const css = color => `rgb(${color.map(v => v.toFixed(3)).join(" ")})`;
  const luminance = color => color.map(v => linear(v / 255)).reduce((s, v, i) => s + v * [.2126,.7152,.0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  function readableColor(lab, background, destination) {
    let low = 0, high = 1;
    if (contrast(fromLab(lab), background) >= 4.6) return fromLab(lab);
    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2;
      if (contrast(fromLab(blend(lab, destination, mid)), background) < 4.6) low = mid;
      else high = mid;
    }
    return fromLab(blend(lab, destination, high));
  }
  function appearance(remaining) {
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
    const p = Math.max(0, Math.min(100, remaining));
    const upper = labs.findIndex(([at]) => at >= p);
    const [end, right] = labs[upper], [start, left] = labs[Math.max(0, upper - 1)];
    const t = end === start ? 0 : (p - start) / (end - start);
    const lab = blend(left, right, t*t*(3-2*t)), base = fromLab(lab);
    return { percentage: p, tone: tone(p), base: css(base),
      top: css(fromLab(blend(lab, [1,0,0], .16 + p*.0004))),
      bottom: css(fromLab(blend(lab, [0,0,0], .1 + (100-p)*.0005))),
      textLight: css(readableColor(lab, [249,250,251], [0,0,0])),
      textDark: css(readableColor(lab, [32,33,36], [1,0,0])),
      glow: `rgb(${base.map(v=>v.toFixed(3)).join(" ")} / ${(.05+p*.0008).toFixed(3)})` };
  }
  const SIDEBAR_SELECTORS = [
    "aside.app-shell-left-panel",
    'aside[data-testid="app-shell-floating-left-panel"]',
    'aside[data-app-shell-left-panel-appearance]',
  ];
  const SCROLLER_SELECTOR = "[data-app-action-sidebar-scroll]";
  const SETTINGS_SELECTOR = "[data-settings-panel-slug]";
  const STALE_AFTER_MS = 3 * 60 * 1000;
  const HIDE_AFTER_MS = 15 * 60 * 1000;
  const state = {
    snapshot: null,
    unavailable: null,
    host: null,
    shadow: null,
    observer: null,
    resizeObserver: null,
    timer: null,
    lastHeartbeatAt: Date.now(),
    cleaned: false,
    trace: [],
    traceSequence: 0,
    traceFingerprint: null,
    placement: { reason: "no-sidebar" },
    identities: new WeakMap(),
    identitySequence: 0,
  };

  function locale() {
    const candidates = [document.documentElement.lang, navigator.language]
      .filter((value) => typeof value === "string")
      .map((value) => value.toLowerCase());
    if (candidates.some((value) => value === "zh-tw" || value === "zh-hk" || value.includes("hant"))) {
      return "zh-TW";
    }
    if (candidates.some((value) => value.startsWith("zh"))) return "zh-CN";
    return "en";
  }

  const messages = {
    en: {
      title: "Codex allowance",
      live: "Live",
      refreshing: "Refreshing",
      unavailable: "Unavailable",
      loading: "Reading allowance…",
      remaining: "remaining",
      fiveHour: "5 hours",
      week: "Weekly",
      daily: "Daily",
      monthly: "Monthly",
      reset: "Resets",
      soon: "soon",
    },
    "zh-CN": {
      title: "Codex 额度",
      live: "实时",
      refreshing: "刷新中",
      unavailable: "暂不可用",
      loading: "正在读取额度…",
      remaining: "剩余",
      fiveHour: "5 小时",
      week: "每周",
      daily: "每日",
      monthly: "每月",
      reset: "重置",
      soon: "即将",
    },
    "zh-TW": {
      title: "Codex 額度",
      live: "即時",
      refreshing: "重新整理中",
      unavailable: "暫不可用",
      loading: "正在讀取額度…",
      remaining: "剩餘",
      fiveHour: "5 小時",
      week: "每週",
      daily: "每日",
      monthly: "每月",
      reset: "重設",
      soon: "即將",
    },
  };

  function text() {
    return messages[locale()] || messages.en;
  }

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function percent(value) {
    const number = finite(value);
    return number === null ? null : Math.max(0, Math.min(100, number));
  }

  function safeText(value, maxLength) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength
      ? value
      : null;
  }

  function normalizeWindow(value) {
    if (!value || !["primary", "secondary"].includes(value.kind)) return null;
    const remainingPercent = percent(value.remainingPercent);
    if (remainingPercent === null) return null;
    const durationMinutes = finite(value.durationMinutes);
    const resetsAtMs = finite(value.resetsAtMs);
    return {
      kind: value.kind,
      remainingPercent,
      durationMinutes: durationMinutes !== null && durationMinutes >= 0
        ? Math.round(durationMinutes)
        : null,
      resetsAtMs: resetsAtMs !== null && resetsAtMs > 0 ? Math.round(resetsAtMs) : null,
    };
  }

  function normalizeSnapshot(value) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.buckets)) return null;
    const fetchedAtMs = finite(value.fetchedAtMs);
    if (fetchedAtMs === null || fetchedAtMs <= 0) return null;
    const buckets = value.buckets.slice(0, 32).flatMap((bucket) => {
      if (!bucket || typeof bucket !== "object") return [];
      const id = safeText(bucket.id, 64);
      if (!id || !Array.isArray(bucket.windows)) return [];
      const windows = bucket.windows.map(normalizeWindow).filter(Boolean).slice(0, 2);
      return windows.length ? [{
        id,
        name: safeText(bucket.name, 64),
        planType: safeText(bucket.planType, 32),
        windows,
      }] : [];
    });
    return { schemaVersion: 1, fetchedAtMs: Math.round(fetchedAtMs), buckets };
  }

  function canonical(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function generalBucket() {
    const buckets = state.snapshot?.buckets || [];
    const nonModel = buckets.filter((bucket) => !canonical(bucket.name).includes("spark"));
    const exact = nonModel.filter((bucket) => canonical(bucket.id) === "codex");
    if (exact.length === 1) return exact[0];
    const unnamed = nonModel.filter((bucket) => !bucket.name);
    return unnamed.length === 1 ? unnamed[0] : null;
  }

  function visible(element) {
    if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 160 && rect.height >= 180;
  }

  function activeSidebar() {
    const sidebars = [...new Set(SIDEBAR_SELECTORS.flatMap(
      (selector) => Array.from(document.querySelectorAll(selector)),
    ))].filter(visible);
    return sidebars.length === 1 ? sidebars[0] : null;
  }

  function insertionPoint(sidebar) {
    const reject = (reason) => { state.placement.reason = reason; return null; };
    state.placement = { reason: "no-sidebar" };
    if (!sidebar) return null;
    state.placement.sidebar = sidebar;
    const inFlow = (element) => !element.closest('[hidden], [inert], [aria-hidden="true"]')
      && getComputedStyle(element).display !== "none"
      && getComputedStyle(element).visibility !== "hidden"
      && element.getBoundingClientRect().width >= 100;
    const legacy = Array.from(sidebar.querySelectorAll(SCROLLER_SELECTOR)).filter(inFlow);
    state.placement.legacyCount = legacy.length;
    if (sidebar.matches('aside[data-app-shell-left-panel-appearance]')) {
      const allNavigations = Array.from(sidebar.querySelectorAll('nav[role="navigation"][aria-label]'));
      const navigations = allNavigations.filter(inFlow);
      state.placement.totalNavigations = allNavigations.length;
      state.placement.navigationCount = navigations.length;
      if (navigations.length !== 1) return reject("navigation-count");
      const navigation = navigations[0];
      state.placement.navigation = navigation;
      const style = getComputedStyle(navigation);
      if (style.display !== "flex" || style.flexDirection !== "column") return reject("navigation-flow");
      const scrolls = Array.from(navigation.querySelectorAll(`${SCROLLER_SELECTOR}, div.overflow-y-auto`))
        .filter(inFlow);
      // A native wrapper may contain the scroller. The quota is always a direct
      // navigation child, never inserted into a mode menu or nested list.
      const branches = Array.from(navigation.children).filter((child) => scrolls.some(
        (scroller) => child === scroller || child.contains(scroller),
      ));
      state.placement.scrollCount = scrolls.length;
      state.placement.branchCount = branches.length;
      if (branches.length !== 1 || legacy.some((element) => !navigation.contains(element))) return reject("scroll-branch");
      const allNativeChildren = Array.from(navigation.children).filter((child) => child !== state.host && !(
        child.tagName === "BUTTON" && child.id === "codex-taskboard-entry"
        && child.getAttribute("data-codex-taskboard-owned") === "true"
        && child.getAttribute("data-codex-taskboard-entry-layout") === "navigation"
        && child.nextElementSibling === branches[0]
        && document.querySelectorAll("#codex-taskboard-entry").length === 1
      ));
      const nativeChildren = allNativeChildren.filter(inFlow);
      state.placement.nativeChildren = allNativeChildren.length;
      state.placement.hiddenNativeChildren = allNativeChildren.length - nativeChildren.length;
      state.placement.lastNativeChildTag = ["DIV", "SECTION", "FOOTER", "NAV", "BUTTON", "UL"].includes(nativeChildren.at(-1)?.tagName)
        ? nativeChildren.at(-1).tagName.toLowerCase() : "other";
      if (nativeChildren.at(-1) !== branches[0]) return reject("scroll-order");
      const candidates = scrolls.filter((element) => !scrolls.some(
        (other) => other !== element && other.contains(element),
      ));
      state.placement.candidateCount = candidates.length;
      if (candidates.length !== 1) return reject("scroll-count");
      const scroller = candidates[0];
      const header = nativeChildren.length === 2 && nativeChildren[1] === branches[0]
        ? nativeChildren[0] : null;
      const headerButtons = Array.from(header?.querySelectorAll("button.sidebar-item") || []).filter((button) => !(
        button.id === "codex-taskboard-entry" && button.getAttribute("data-codex-taskboard-owned") === "true"
      ));
      if (!scroller.matches(SCROLLER_SELECTOR)
        && !scroller.querySelector("button.sidebar-item, a.sidebar-item[href]")
        && headerButtons.length !== 1) return reject("reference");
      state.placement.reason = "mounted";
      return { anchor: branches[0], navigation };
    }
    if (legacy.length !== 1) return reject("legacy-scroll");
    const scroller = legacy[0];
    state.placement.reason = scroller.parentElement && sidebar.contains(scroller.parentElement)
      ? "mounted" : "legacy-parent";
    return scroller.parentElement && sidebar.contains(scroller.parentElement)
      ? { anchor: scroller, navigation: null } : null;
  }

  function windowLabel(minutes, copy) {
    if (minutes === 300) return copy.fiveHour;
    if (minutes === 1_440) return copy.daily;
    if (minutes === 10_080) return copy.week;
    if (minutes === 43_200 || minutes === 44_640) return copy.monthly;
    if (Number.isFinite(minutes) && minutes > 0 && minutes % 1_440 === 0) {
      return locale() === "en" ? `${minutes / 1_440} days` : `${minutes / 1_440} 天`;
    }
    return copy.remaining;
  }

  function resetLabel(resetsAtMs, copy) {
    if (!Number.isFinite(resetsAtMs)) return "";
    const delta = Math.max(0, resetsAtMs - Date.now());
    const minutes = Math.ceil(delta / 60_000);
    let countdown;
    if (minutes < 1) countdown = copy.soon;
    else if (minutes < 60) countdown = locale() === "en" ? `${minutes}m` : `${minutes} 分钟`;
    else if (minutes < 1_440) {
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      countdown = locale() === "en"
        ? `${hours}h${remainder ? ` ${remainder}m` : ""}`
        : `${hours} 小时${remainder ? ` ${remainder} 分钟` : ""}`;
    } else {
      const days = Math.floor(minutes / 1_440);
      const hours = Math.floor((minutes % 1_440) / 60);
      countdown = locale() === "en"
        ? `${days}d${hours ? ` ${hours}h` : ""}`
        : `${days} 天${hours ? ` ${hours} 小时` : ""}`;
    }
    return `${copy.reset} ${countdown}`;
  }

  function tone(remaining) {
    if (remaining <= 25) return "critical";
    if (remaining < 45) return "warning";
    if (remaining > 75) return "abundant";
    return "healthy";
  }

  function freshness() {
    if (!state.snapshot) return state.unavailable ? "unavailable" : "loading";
    const age = Date.now() - state.snapshot.fetchedAtMs;
    if (age > HIDE_AFTER_MS) return "unavailable";
    return age > STALE_AFTER_MS ? "stale" : "fresh";
  }

  function syncTheme() {
    const root = document.documentElement;
    const theme = String(root.getAttribute("data-theme") || root.getAttribute("data-color-theme") || "").toLowerCase();
    const dark = theme.includes("dark") || root.classList.contains("dark")
      || (!theme.includes("light") && !root.classList.contains("light")
        && (getComputedStyle(root).colorScheme === "dark" || window.matchMedia?.("(prefers-color-scheme:dark)").matches));
    const value = dark ? "dark" : "light";
    if (state.host?.getAttribute("data-quota-theme") !== value) state.host?.setAttribute("data-quota-theme", value);
  }

  function render() {
    if (!state.shadow) return;
    const copy = text();
    syncTheme();
    const status = freshness();
    const bucket = generalBucket();
    const rows = bucket?.windows.slice().sort((left, right) => (
      (left.durationMinutes ?? Number.MAX_SAFE_INTEGER)
      - (right.durationMinutes ?? Number.MAX_SAFE_INTEGER)
    )) || [];
    const statusText = status === "fresh"
      ? copy.live
      : status === "stale" ? copy.refreshing : status === "loading" ? "" : copy.unavailable;
    const body = rows.length && status !== "unavailable"
      ? rows.map((window) => {
        const rounded = Math.round(window.remainingPercent);
        const colors = appearance(window.remainingPercent);
        return `<div class="quota-row" data-tone="${colors.tone}" style="--quota-base:${colors.base};--quota-top:${colors.top};--quota-bottom:${colors.bottom};--quota-glow:${colors.glow};--quota-text-light:${colors.textLight};--quota-text-dark:${colors.textDark}">
          <div class="quota-line"><span>${windowLabel(window.durationMinutes, copy)}</span><strong>${rounded}%</strong></div>
          <div class="quota-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${rounded}"><i style="width:${window.remainingPercent}%"></i></div>
          <div class="quota-reset">${resetLabel(window.resetsAtMs, copy)}</div>
        </div>`;
      }).join("")
      : `<div class="quota-empty">${status === "loading" ? copy.loading : copy.unavailable}</div>`;
    state.shadow.innerHTML = `<style>
      /* Outer document resets override normal :host rules. Keep the footer reservation
         inside the shadow cascade's protected layout, without styling native elements. */
      :host { display:block !important; flex:0 0 auto !important; width:auto; min-width:0; margin:6px 8px 48px !important; color:var(--color-text, var(--color-token-foreground, CanvasText)); font-family:var(--font-sans, var(--font-family-sans, ui-sans-serif, system-ui, sans-serif)); }
      :host([data-codex-taskboard-quota-layout="content-panel"]) { margin:6px 12px 12px !important; }
      :host([data-codex-taskboard-quota-flow="navigation"]) { order:2147483647 !important; margin-top:auto !important; }
      :host([hidden]) { display:none !important; }
      *,::before,::after { box-sizing:border-box; }
      .quota-card { padding:4px 4px 2px; border:0; border-radius:0; background:transparent; }
      .quota-head,.quota-line { display:flex; align-items:center; justify-content:space-between; min-width:0; gap:8px; }
      .quota-head { flex-wrap:wrap; gap:6px 8px; }
      .quota-title { flex:1 0 auto; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; line-height:16px; font-weight:600; }
      .quota-status { display:inline-flex; align-items:center; gap:4px; flex:none; color:var(--color-text-secondary, var(--color-token-description-foreground, color-mix(in srgb, currentColor 62%, transparent))); font-size:10px; line-height:16px; font-weight:400; }
      .quota-status:empty { display:none; }
      .quota-status::before { content:""; width:4px; height:4px; border-radius:50%; background:var(--color-text-success, #2aa876); }
      .quota-card[data-state="stale"] .quota-status::before { background:var(--color-text-warning, light-dark(#946b00, #d9b75f)); }
      .quota-card[data-state="loading"] .quota-status::before,
      .quota-card[data-state="unavailable"] .quota-status::before { background:#999; box-shadow:none; }
      .quota-list { display:grid; gap:10px; margin-top:8px; }
      .quota-line { color:var(--color-text-secondary, var(--color-token-description-foreground, color-mix(in srgb, currentColor 66%, transparent))); font-size:12px; line-height:18px; }
      .quota-line strong { color:var(--quota-text-light); font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; }
      :host([data-quota-theme="dark"]) .quota-line strong { color:var(--quota-text-dark); }
      .quota-track { height:7px; margin-top:4px; overflow:hidden; border-radius:99px;
        background:color-mix(in srgb, var(--quota-base) 5%, #dfe4e9);
        box-shadow:inset 0 1px 2px #10253820, inset 0 -1px 0 #fff9; }
      :host([data-quota-theme="dark"]) .quota-track { background:#303841;
        box-shadow:inset 0 1px 2px #0007, inset 0 -1px 0 #ffffff15; }
      .quota-track i { display:block; position:relative; height:100%; border-radius:inherit;
        background:linear-gradient(180deg, color-mix(in srgb, var(--quota-base) 68%, white), var(--quota-base) 48%, color-mix(in srgb, var(--quota-base) 90%, #102838));
        box-shadow:inset 0 1px 0 #ffffff91, inset 0 -1px 0 #10283828; }
      .quota-track i::before { content:""; position:absolute; inset:1px 2px 55%; border-radius:inherit;
        background:linear-gradient(180deg, #fff7, transparent); }
      .quota-reset,.quota-empty { margin-top:4px; white-space:normal; overflow-wrap:anywhere; color:var(--color-text-secondary, var(--color-token-description-foreground, color-mix(in srgb, currentColor 62%, transparent))); font-size:11px; line-height:16px; font-variant-numeric:tabular-nums; }
      .quota-empty { margin-top:0; }
      @media (forced-colors:active) { .quota-line strong { color:CanvasText !important; }
        .quota-track { border:1px solid CanvasText; background:Canvas; box-shadow:none; }
        .quota-track i { background:Highlight !important; box-shadow:none; } .quota-track i::before { display:none; } }
    </style><section class="quota-card" data-state="${status}" aria-label="${copy.title}">
      <header class="quota-head"><span class="quota-title">${copy.title}</span><span class="quota-status">${statusText}</span></header>
      <div class="quota-list">${body}</div>
    </section>`;
  }

  function ensureHost() {
    if (state.host) return state.host;
    const host = document.createElement("section");
    host.id = HOST_ID;
    host.setAttribute("data-codex-taskboard-owned", "quota-display");
    state.shadow = host.attachShadow({ mode: "closed" });
    state.host = host;
    render();
    return host;
  }

  function reconcile() {
    if (state.cleaned) return;
    if (state.host) recordTrace();
    const host = ensureHost();
    syncTheme();
    const settingsOpen = Array.from(document.querySelectorAll(SETTINGS_SELECTOR)).some(visible);
    if (settingsOpen) {
      if (!host.hidden) host.hidden = true;
      state.placement = { reason: "settings" };
      recordTrace();
      return;
    }
    const sidebar = activeSidebar();
    const point = insertionPoint(sidebar);
    if (!sidebar || !point) {
      if (!host.hidden) host.hidden = true;
      recordTrace();
      return;
    }
    // In the new content panel, the profile occupies a separate activity rail.
    // Unknown/legacy layouts and embedded footers retain the old clearance.
    const contentPanel = sidebar.matches("aside[data-app-shell-left-panel-appearance]")
      && Boolean(point.navigation)
      && !sidebar.querySelector("footer,[data-app-action-sidebar-footer]");
    const layout = contentPanel ? "content-panel" : "legacy";
    if (host.getAttribute("data-codex-taskboard-quota-layout") !== layout) {
      host.setAttribute("data-codex-taskboard-quota-layout", layout);
    }
    const flow = point.navigation ? "navigation" : "legacy";
    if (host.getAttribute("data-codex-taskboard-quota-flow") !== flow) {
      host.setAttribute("data-codex-taskboard-quota-flow", flow);
    }
    if (host.previousElementSibling !== point.anchor || host.parentElement !== point.anchor.parentElement) {
      point.anchor.insertAdjacentElement("afterend", host);
    }
    if (host.hidden) host.hidden = false;
    recordTrace();
  }

  // Only bounded structure, geometry and our own lifecycle; no text, attributes,
  // URLs, account data or quota snapshot enter this diagnostic ring.
  function recordTrace() {
    try {
      const identity = (node) => {
        if (!node) return 0;
        if (!state.identities.has(node)) state.identities.set(node, ++state.identitySequence);
        return Math.min(state.identities.get(node), 1000000);
      };
      const bounded = (value) => Number.isFinite(value) ? Math.max(-32768, Math.min(32768, Math.round(value))) : 0;
      const host = state.host;
      const rect = host?.getBoundingClientRect();
      let ancestorHidden = false, clipped = false, ancestorLimit = false;
      let depth = 0;
      for (let node = host?.parentElement; node; node = node.parentElement) {
        if (++depth > 64) { ancestorLimit = true; break; }
        const style = getComputedStyle(node);
        ancestorHidden ||= node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true"
          || style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
        const parentRect = node.getBoundingClientRect();
        clipped ||= Boolean(rect && ((["hidden", "clip", "auto", "scroll"].includes(style.overflowY)
          && (rect.top < parentRect.top - 1 || rect.bottom > parentRect.bottom + 1))
          || (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)
          && (rect.left < parentRect.left - 1 || rect.right > parentRect.right + 1))));
      }
      const allSidebars = [...new Set(SIDEBAR_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector))))];
      const value = {
        reason: state.cleaned ? "cleanup" : state.placement.reason,
        connected: Boolean(host?.isConnected), hidden: Boolean(host?.hidden), cleaned: state.cleaned,
        ancestorHidden, clipped, ancestorLimit,
        hostCount: Math.min(document.querySelectorAll(`#${HOST_ID}`).length, 1000),
        sidebarCount: Math.min(allSidebars.length, 1000),
        visibleSidebarCount: Math.min(allSidebars.filter(visible).length, 1000),
        sidebarIdentity: identity(state.placement.sidebar), navigationIdentity: identity(state.placement.navigation),
        parentIdentity: identity(host?.parentElement),
        width: bounded(rect?.width), height: bounded(rect?.height), top: bounded(rect?.top), left: bounded(rect?.left),
        ...(state.placement.lastNativeChildTag ? { lastNativeChildTag: state.placement.lastNativeChildTag } : {}),
        ...Object.fromEntries(["legacyCount", "navigationCount", "totalNavigations", "scrollCount", "branchCount", "nativeChildren", "hiddenNativeChildren", "candidateCount"]
          .filter((key) => Number.isInteger(state.placement[key]))
          .map((key) => [key, Math.min(state.placement[key], 1000)])),
      };
      const fingerprint = JSON.stringify(value);
      if (fingerprint === state.traceFingerprint) return;
      // Keep semantic transitions immediately; resize geometry needs at most
      // one sample per second. The next heartbeat captures the final geometry.
      const semantic = JSON.stringify({ ...value, width: 0, height: 0, top: 0, left: 0 });
      const now = Date.now();
      if (semantic === state.traceSemantic && now - state.traceAt < 1000) return;
      state.traceSemantic = semantic;
      state.traceAt = now;
      state.traceFingerprint = fingerprint;
      state.trace.push({ sequence: ++state.traceSequence, atMs: now, ...value });
      if (state.trace.length > 128) state.trace.shift();
    } catch (_) { /* Diagnostics must never alter placement or cleanup. */ }
  }

  function diagnostics(afterSequence = 0) {
    recordTrace();
    const after = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    return { schemaVersion: 1, version: VERSION, sequence: state.traceSequence,
      oldestSequence: state.trace[0]?.sequence ?? 0, events: state.trace.filter((event) => event.sequence > after).slice(-128) };
  }

  function mount() {
    state.cleaned = false;
    ensureHost();
    if (!state.observer) {
      state.observer = new MutationObserver(reconcile);
      state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden", "aria-busy", "role", "aria-label",
          "data-theme", "data-color-theme", "data-app-shell-left-panel-appearance", "data-testid", "data-app-action-sidebar-scroll", "data-settings-panel-slug"] });
    }
    if (!state.resizeObserver && typeof ResizeObserver === "function") {
      state.resizeObserver = new ResizeObserver(reconcile);
      state.resizeObserver.observe(document.documentElement);
    }
    if (!state.timer) state.timer = window.setInterval(() => { render(); reconcile(); }, 30_000);
    reconcile();
    return status();
  }

  function update(value) {
    const snapshot = normalizeSnapshot(value);
    if (!snapshot) return { ...status(), accepted: false };
    state.snapshot = snapshot;
    state.unavailable = null;
    render();
    reconcile();
    return { ...status(), accepted: true };
  }

  function unavailable(value) {
    state.unavailable = value && value.schemaVersion === 1 ? { atMs: finite(value.atMs) } : { atMs: Date.now() };
    if (!state.snapshot || Date.now() - state.snapshot.fetchedAtMs > HIDE_AFTER_MS) state.snapshot = null;
    render();
    reconcile();
    return status();
  }

  function heartbeat() {
    state.lastHeartbeatAt = Date.now();
    reconcile();
    return status();
  }

  function status() {
    return {
      version: VERSION,
      mounted: Boolean(state.host?.isConnected && !state.host.hidden),
      freshness: freshness(),
      fetchedAtMs: state.snapshot?.fetchedAtMs ?? null,
      bucketCount: state.snapshot?.buckets.length ?? 0,
      cleaned: state.cleaned,
    };
  }

  function cleanup() {
    state.cleaned = true;
    state.observer?.disconnect();
    state.resizeObserver?.disconnect();
    if (state.timer) window.clearInterval(state.timer);
    state.observer = null;
    state.resizeObserver = null;
    state.timer = null;
    state.host?.remove();
    recordTrace();
    return status();
  }

  const existing = window[GLOBAL_KEY];
  if (existing?.version === VERSION) {
    if (existing.status().cleaned) existing.mount();
    else existing.heartbeat();
    return existing.status();
  }
  existing?.cleanup?.();
  window[GLOBAL_KEY] = Object.freeze({ version: VERSION, mount, update, unavailable, heartbeat, status, cleanup, diagnostics, appearance });
  return mount();
})();
