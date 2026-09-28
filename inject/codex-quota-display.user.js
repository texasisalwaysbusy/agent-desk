(function codexTaskboardQuotaDisplayBootstrap() {
  "use strict";

  const GLOBAL_KEY = "__codexTaskboardQuotaDisplay__";
  const HOST_ID = "codex-taskboard-quota-display";
  const VERSION = "1.0.6";
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
    if (!element?.isConnected || element.closest('[inert], [aria-hidden="true"]')) return false;
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
    const navigation = sidebar?.querySelector('nav[role="navigation"][aria-label]');
    const modernScroll = navigation?.querySelector("div.overflow-y-auto");
    const scroller = sidebar?.querySelector(SCROLLER_SELECTOR)
      || (modernScroll?.querySelector("button.sidebar-item") ? modernScroll : null);
    return scroller?.parentElement && sidebar.contains(scroller.parentElement) ? scroller : null;
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
    if (remaining < 20) return "critical";
    if (remaining <= 50) return "warning";
    return "healthy";
  }

  function freshness() {
    if (!state.snapshot) return state.unavailable ? "unavailable" : "loading";
    const age = Date.now() - state.snapshot.fetchedAtMs;
    if (age > HIDE_AFTER_MS) return "unavailable";
    return age > STALE_AFTER_MS ? "stale" : "fresh";
  }

  function render() {
    if (!state.shadow) return;
    const copy = text();
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
        return `<div class="quota-row" data-tone="${tone(window.remainingPercent)}">
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
      .quota-line strong { color:var(--color-text-success, light-dark(#278459, #66bd92)); font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; }
      .quota-track { height:3px; margin-top:4px; overflow:hidden; border-radius:99px; background:color-mix(in srgb, currentColor 10%, transparent); }
      .quota-track i { display:block; height:100%; border-radius:inherit; background:var(--color-text-success, light-dark(#278459, #66bd92)); transition:width .25s ease; }
      .quota-row[data-tone="warning"] .quota-line strong { color:var(--color-text-warning, light-dark(#946b00, #d9b75f)); }
      .quota-row[data-tone="warning"] .quota-track i { background:var(--color-text-warning, light-dark(#946b00, #d9b75f)); }
      .quota-row[data-tone="critical"] .quota-line strong { color:var(--color-text-danger, var(--color-token-error-foreground, light-dark(#b42318, #f18b88))); }
      .quota-row[data-tone="critical"] .quota-track i { background:var(--color-text-danger, var(--color-token-error-foreground, light-dark(#b42318, #f18b88))); }
      .quota-reset,.quota-empty { margin-top:4px; white-space:normal; overflow-wrap:anywhere; color:var(--color-text-secondary, var(--color-token-description-foreground, color-mix(in srgb, currentColor 62%, transparent))); font-size:11px; line-height:16px; font-variant-numeric:tabular-nums; }
      .quota-empty { margin-top:0; }
      @media (prefers-reduced-motion:reduce) { .quota-track i { transition:none; } }
      @media (forced-colors:active) { .quota-track { border:1px solid CanvasText; background:Canvas; } .quota-track i { background:Highlight !important; } }
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
    const host = ensureHost();
    const settingsOpen = Array.from(document.querySelectorAll(SETTINGS_SELECTOR)).some(visible);
    if (settingsOpen) {
      if (!host.hidden) host.hidden = true;
      return;
    }
    const sidebar = activeSidebar();
    const scroller = insertionPoint(sidebar);
    if (!sidebar || !scroller) {
      if (!host.hidden) host.hidden = true;
      return;
    }
    // In the new content panel, the profile occupies a separate activity rail.
    // Unknown/legacy layouts and embedded footers retain the old clearance.
    const contentPanel = sidebar.matches("aside[data-app-shell-left-panel-appearance]")
      && Boolean(scroller.closest('nav[role="navigation"][aria-label]'))
      && !sidebar.querySelector("footer,[data-app-action-sidebar-footer]");
    const layout = contentPanel ? "content-panel" : "legacy";
    if (host.getAttribute("data-codex-taskboard-quota-layout") !== layout) {
      host.setAttribute("data-codex-taskboard-quota-layout", layout);
    }
    if (host.previousElementSibling !== scroller || host.parentElement !== scroller.parentElement) {
      scroller.insertAdjacentElement("afterend", host);
    }
    if (host.hidden) host.hidden = false;
  }

  function mount() {
    state.cleaned = false;
    ensureHost();
    if (!state.observer) {
      state.observer = new MutationObserver(reconcile);
      state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-busy"] });
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
    return status();
  }

  const existing = window[GLOBAL_KEY];
  if (existing?.version === VERSION) {
    if (existing.status().cleaned) existing.mount();
    else existing.heartbeat();
    return existing.status();
  }
  existing?.cleanup?.();
  window[GLOBAL_KEY] = Object.freeze({ version: VERSION, mount, update, unavailable, heartbeat, status, cleanup });
  return mount();
})();
