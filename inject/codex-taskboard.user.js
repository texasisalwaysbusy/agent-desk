(() => {
  "use strict";

  const VERSION = "0.6.22";
  const SOURCE_HASH = window.__CODEX_TASKBOARD_SOURCE_HASH__;
  const SENTINEL_KEY = "__codexTaskboardInjection__";
  const DEFAULT_TASKBOARD_URL = "http://127.0.0.1:47823/?host=codex";
  const ENTRY_ID = "codex-taskboard-entry";
  const PAGE_ID = "codex-taskboard-page";
  const FRAME_ID = "codex-taskboard-frame";
  const DRAG_REGION_ID = "codex-taskboard-drag-region";
  const NO_DRAG_LEFT_ID = "codex-taskboard-no-drag-left";
  const NO_DRAG_RIGHT_ID = "codex-taskboard-no-drag-right";
  const STATUS_ID = "codex-taskboard-status";
  const STYLE_ID = "codex-taskboard-inject-style";
  const OWNED_ATTRIBUTE = "data-codex-taskboard-owned";
  const HIDDEN_ATTRIBUTE = "data-codex-taskboard-native-hidden";
  const HOST_ATTRIBUTE = "data-codex-taskboard-page-host";
  const NATIVE_SELECTED_ATTRIBUTE = "data-codex-taskboard-native-selected";
  const HOST_REQUEST_MESSAGE = "__codexTaskboardHostRequestV1";
  const HOST_RESPONSE_MESSAGE = "__codexTaskboardHostResponseV1";
  const HOST_HEARTBEAT_MESSAGE = "__codexTaskboardHostHeartbeatV1";
  const HOST_STARTUP_TOKEN_NAME = "__codexTaskboardHostStartupTokenV1";
  const HOST_CAPABILITY = window.__CODEX_TASKBOARD_HOST_CAPABILITY__;
  const COMPATIBILITY_CAPABILITIES = window.__CODEX_TASKBOARD_COMPATIBILITY_CAPABILITIES__ || {};
  const REATTACH_DELAY_MS = 160;
  const FRAME_READY_TIMEOUT_MS = 12_000;
  const HOST_REQUEST_TIMEOUT_MS = 12_000;
  const HOST_HEARTBEAT_MAX_AGE_MS = 8_000;
  const MACOS_TITLEBAR_SAFE_LEFT = 80;
  const FRAME_REFRESH_PARAM = "__codex_taskboard_refresh";
  const PLUGIN_LABELS = ["插件", "plugins"];
  const NATIVE_PAGE_LABELS = [
    "新建任务",
    "新对话",
    "新聊天",
    "new task",
    "new chat",
    "拉取请求",
    "pull requests",
    "站点",
    "sites",
    "已安排",
    "scheduled",
    "插件",
    "plugins",
  ];
  const PROJECT_SECTION_LABELS = ["projects", "项目"];
  const TASK_SECTION_LABELS = ["tasks", "任务", "chats", "对话"];

  const previous = window[SENTINEL_KEY];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let entry = null;
  let entryReference = null;
  let page = null;
  let frame = null;
  let dragRegion = null;
  let noDragLeft = null;
  let noDragRight = null;
  let status = null;
  let frameOrigin = "";
  let taskboardOrigin = "";
  let frameTaskboardUrl = "";
  let frameCapability = "";
  let frameChallenge = "";
  let frameReady = false;
  let frameReadyWaiters = new Set();
  let hostRequests = new Map();
  let hostRequestSequence = 0;
  let hostHeartbeatAt = 0;
  let observer = null;
  let reattachTimer = null;
  let hostContextTimer = null;
  let hostUiLanguage = null;
  let entryLabel = null;
  let statusView = "idle";
  let loadError = null;
  let lastFocusedElement = null;
  let hostContextSnapshot = null;
  let codexProjectMetadata = new Map();
  let mutedNativeSelections = new Map();
  let openGeneration = 0;
  let pendingThreadCreation = null;
  let lastNativeThreadId = "";
  let lastNativeProjectId = "";
  let suspendedNativeBrowserPanel = null;
  let active = false;
  let destroyed = false;
  let workbenchSequence = 0;
  let workbenchFingerprint = "";
  const workbenchTrace = [];
  let lastLoadFailure = "none";
  let mountState = "parked";
  let frameLoadEvents = 0;
  let frameAwaitingChallenge = false;
  let frameLoadAcknowledged = false;
  let loadStage = "idle";
  let parkReason = "none";
  let framePreparation = null;

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function hostLanguage() {
    return document.documentElement.lang || navigator.language;
  }

  function resolvedHostLanguage() {
    const language = hostLanguage().trim().replaceAll("_", "-").toLowerCase();
    return language === "zh" || language.startsWith("zh-") ? "zh" : "en";
  }

  function hostText(chinese, english) {
    return resolvedHostLanguage() === "zh" ? chinese : english;
  }

  function hostError(chinese, english) {
    const error = new Error(hostText(chinese, english));
    error.taskboardText = { chinese, english };
    return error;
  }

  function hostErrorText(error) {
    if (error?.taskboardText) {
      return hostText(error.taskboardText.chinese, error.taskboardText.english);
    }
    return error instanceof Error ? error.message : String(error || "");
  }

  function normalizeThreadId(value) {
    return String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  }

  function resolveTaskboardUrl() {
    const configured = typeof window.__CODEX_TASKBOARD_URL__ === "string"
      ? window.__CODEX_TASKBOARD_URL__.trim()
      : "";
    try {
      const url = new URL(configured || DEFAULT_TASKBOARD_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported taskboard URL protocol");
      }
      if (!url.searchParams.has("host")) url.searchParams.set("host", "codex");
      return url;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL);
    }
  }

  function isLocalTaskboardOrigin(origin) {
    try {
      const { protocol, hostname } = new URL(origin);
      return (protocol === "http:" || protocol === "https:")
        && (hostname === "127.0.0.1" || hostname === "localhost");
    } catch (_) {
      return false;
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_ATTRIBUTE, "true");
    style.textContent = `
      #${ENTRY_ID} {
        box-sizing: border-box !important;
        position: static !important;
        display: flex !important;
        align-items: center !important;
        justify-content: flex-start !important;
        flex: 0 0 var(--agent-desk-entry-height, 32px) !important;
        height: var(--agent-desk-entry-height, 32px) !important;
        min-height: var(--agent-desk-entry-height, 32px) !important;
        max-height: var(--agent-desk-entry-height, 32px) !important;
        width: 100%;
        min-width: 0;
        max-width: 100%;
        padding: 4px var(--agent-desk-entry-padding, 8px) !important;
        border: 0 !important;
        border-radius: 10px;
        background: transparent;
        color: var(--color-token-foreground, CanvasText);
        font-family: var(--agent-desk-entry-font-family, inherit);
        font-size: var(--agent-desk-entry-font-size, 14px);
        font-weight: var(--agent-desk-entry-font-weight, 400);
        line-height: var(--agent-desk-entry-line-height, 20px);
        letter-spacing: var(--agent-desk-entry-letter-spacing, normal);
        cursor: pointer;
        gap: var(--agent-desk-entry-gap, 8px);
        overflow: hidden !important;
        -webkit-app-region: no-drag;
      }
      #${ENTRY_ID}:hover { background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent)); }
      #${ENTRY_ID} > svg { width: var(--agent-desk-entry-icon, 18px); height: var(--agent-desk-entry-icon, 18px); flex: 0 0 var(--agent-desk-entry-icon, 18px); }
      #${ENTRY_ID} > .entry-chevron { width:12px; height:12px; flex:0 0 12px; margin-left:auto; color:var(--color-token-description-foreground, currentColor); opacity:.55; }
      #${ENTRY_ID} > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      #${ENTRY_ID}[hidden] {
        display: none !important;
      }
      #${ENTRY_ID}[data-codex-taskboard-entry-layout="navigation"]:not([hidden]) {
        box-sizing: border-box !important;
        display: flex !important;
        align-self: stretch !important;
        width: calc(100% - 16px) !important;
        max-width: calc(100% - 16px) !important;
        min-width: 0 !important;
        margin: 4px 8px !important;
        gap: var(--agent-desk-entry-gap, 8px);
        justify-content: flex-start;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis;
      }
      [${HOST_ATTRIBUTE}="true"] {
        position: relative !important;
        z-index: 31 !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] {
        background-color: transparent !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] [class*="text-token-list-active-selection"] {
        color: var(--color-token-foreground, inherit) !important;
      }
      #${PAGE_ID} {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 3;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${FRAME_ID}[hidden] {
        display: none !important;
      }
      #${DRAG_REGION_ID} {
        position: absolute;
        z-index: 4;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: drag;
      }
      #${NO_DRAG_LEFT_ID},
      #${NO_DRAG_RIGHT_ID} {
        position: absolute;
        z-index: 4;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: no-drag;
      }
      #${DRAG_REGION_ID}[hidden],
      #${NO_DRAG_LEFT_ID}[hidden],
      #${NO_DRAG_RIGHT_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
      }
      #${STATUS_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} button {
        margin-top: 10px;
        border: 1px solid var(--color-token-border, color-mix(in srgb, CanvasText 16%, transparent));
        border-radius: 7px;
        padding: 5px 10px;
        background: var(--color-token-main-surface-secondary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    const text = normalizedLabel(button.textContent || button.getAttribute("aria-label"));
    return labels.includes(text);
  }

  function visibleNativeFlow(candidate) {
    return candidate && !candidate.closest('[hidden], [inert], [aria-hidden="true"]')
      && getComputedStyle(candidate).display !== "none" && getComputedStyle(candidate).visibility !== "hidden"
      && candidate.getBoundingClientRect().width >= 100;
  }

  function visibleNativeRow(candidate) {
    return candidate && !candidate.closest('[hidden], [inert], [aria-hidden="true"]')
      && getComputedStyle(candidate).display !== "none" && getComputedStyle(candidate).visibility !== "hidden"
      && candidate.getBoundingClientRect().width > 0 && candidate.getBoundingClientRect().height > 0;
  }

  function findReferenceButton() {
    const visibleSidebar = (candidate) => {
      if (!candidate || candidate.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden"
        && rect.width >= 160 && rect.height >= 180;
    };
    const legacyScrolls = Array.from(document.querySelectorAll(
      "[data-app-action-sidebar-scroll]",
    )).filter((candidate) => visibleSidebar(candidate.closest("aside")) && visibleNativeFlow(candidate));
    if (legacyScrolls.length > 1) return null;
    const scroll = legacyScrolls[0] || null;
    const sidebars = Array.from(document.querySelectorAll(
      'aside[data-app-shell-left-panel-appearance]',
    )).filter(visibleSidebar);
    if (sidebars.length > 1 || (scroll && sidebars.length === 1
      && !sidebars[0].contains(scroll))) return null;
    const sidebar = sidebars.length === 1 ? sidebars[0] : null;
    const navigations = Array.from(sidebar?.querySelectorAll(
      'nav[role="navigation"][aria-label]',
    ) || []).filter(visibleNativeFlow);
    const navigation = navigations.length === 1 ? navigations[0] : null;
    const modernScrolls = Array.from(navigation?.querySelectorAll("div.overflow-y-auto") || []).filter(visibleNativeFlow);
    const modernScroll = modernScrolls.length === 1 ? modernScrolls[0] : null;
    const modernReference = modernScroll?.querySelector(
      "button.sidebar-item, a.sidebar-item[href]",
    );
    const scrollHosts = navigation && modernScroll
      ? Array.from(navigation.children).filter((child) => child.contains(modernScroll)) : [];
    const scrollHost = scrollHosts.length === 1 ? scrollHosts[0] : null;
    const nativeChildren = nativeNavigationChildren(navigation, modernScroll);
    const headerHost = nativeChildren.length === 2
      && nativeChildren[1] === scrollHost
      ? nativeChildren[0] : null;
    const headerButtons = headerHost
      ? Array.from(headerHost.querySelectorAll("button.sidebar-item"))
        .filter((button) => visibleNativeRow(button)
          && button.closest('nav[role="navigation"][aria-label]') === navigation
          && !button.closest('[role="menu"], [role="dialog"], dialog')
          && !(button.id === ENTRY_ID
            && button.getAttribute(OWNED_ATTRIBUTE) === "true")) : [];
    const headerReference = headerButtons.length >= 1 && headerButtons.length <= 8
      && !modernScroll?.contains(headerButtons[0])
      && headerButtons[0].parentElement ? headerButtons[0] : null;
    if (!scroll) {
      return sidebar?.contains(modernScroll) ? headerReference || modernReference : null;
    }
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin?.parentElement) return plugin;

    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    const legacyReference = Array.from(group?.children || [])
      .filter((child) => child.tagName === "BUTTON").at(-1) || null;
    return legacyReference || (scroll === modernScroll ? headerReference : null)
      || (scroll.contains(modernReference) ? modernReference : null);
  }

  function nativeNavigationChildren(navigation, scroll) {
    const scrollHosts = Array.from(navigation?.children || []).filter((child) => child.contains(scroll));
    const scrollHost = scrollHosts.length === 1 ? scrollHosts[0] : null;
    return Array.from(navigation?.children || []).filter(visibleNativeFlow).filter((child) => !(
      child.tagName === "SECTION" && child.id === "codex-taskboard-quota-display"
      && child.getAttribute(OWNED_ATTRIBUTE) === "quota-display"
      && scrollHost && child.previousElementSibling === scrollHost && scrollHost.parentElement === navigation
    ) && !(
      child.tagName === "BUTTON" && child.id === ENTRY_ID
      && child.getAttribute(OWNED_ATTRIBUTE) === "true"
      && child.getAttribute("data-codex-taskboard-entry-layout") === "navigation"
      && scrollHost && child.nextElementSibling === scrollHost
      && document.querySelectorAll(`#${ENTRY_ID}`).length === 1
    ));
  }

  function headerMountForReference(reference) {
    const navigation = reference?.closest('nav[role="navigation"][aria-label]');
    const scrolls = Array.from(navigation?.querySelectorAll("div.overflow-y-auto") || []).filter(visibleNativeFlow);
    const nativeChildren = nativeNavigationChildren(navigation, scrolls[0]);
    if (!navigation || scrolls.length !== 1 || nativeChildren.length !== 2) return null;
    const scrollHost = Array.from(navigation.children)
      .filter((child) => child.contains(scrolls[0]));
    const headerHost = nativeChildren[0];
    if (scrollHost.length !== 1 || nativeChildren[1] !== scrollHost[0]
      || !headerHost?.contains(reference)) return null;
    const nativeButtons = Array.from(headerHost.querySelectorAll("button.sidebar-item"))
      .filter((button) => visibleNativeRow(button)
        && button.closest('nav[role="navigation"][aria-label]') === navigation
        && !button.closest('[role="menu"], [role="dialog"], dialog')
        && !(button.id === ENTRY_ID
          && button.getAttribute(OWNED_ATTRIBUTE) === "true"));
    return nativeButtons.length >= 1 && nativeButtons.length <= 8 && nativeButtons.includes(reference)
      ? { navigation, scrollHost: scrollHost[0], headerHost } : null;
  }

  function replaceEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = `
      <rect x="3.5" y="4" width="17" height="16" rx="2.5"></rect>
      <path d="M9 4v16M14.5 8h2.5M14.5 12h2.5M14.5 16h2.5"></path>
    `;
  }

  function createEntry() {
    // Native action classes/inline styles are contextual (e.g. height:100%).
    // A separate row owns its markup and sizing, never clones action attributes.
    const button = document.createElement("button");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    entryLabel = document.createElement("span");
    button.append(icon, entryLabel);
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("class", "entry-chevron");
    chevron.setAttribute("viewBox", "0 0 16 16");
    chevron.setAttribute("fill", "none");
    chevron.setAttribute("stroke", "currentColor");
    chevron.setAttribute("stroke-width", "1.5");
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = '<path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />';
    button.append(chevron);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    syncEntryText(button);
    replaceEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTaskboard();
    });
    return button;
  }

  function syncEntryText(button = entry) {
    if (!button) return;
    button.setAttribute("aria-label", hostText("打开智能体工作台", "Open Agent Desk"));
    button.setAttribute("title", hostText("智能体工作台", "Agent Desk"));
    if (entryLabel) entryLabel.textContent = hostText("智能体工作台", "Agent Desk");
    else button.textContent = hostText("智能体工作台", "Agent Desk");
  }

  function syncEntryState() {
    if (!entry) return;
    if (active && entry.getAttribute("aria-current") !== "page") {
      entry.setAttribute("aria-current", "page");
    } else if (!active && entry.hasAttribute("aria-current")) {
      entry.removeAttribute("aria-current");
    }
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) {
      if (entry && !entry.hidden) entry.hidden = true;
      return;
    }
    if (entry?.hidden) entry.hidden = false;
    entryReference = reference;
    if (!entry) entry = createEntry();
    syncEntryAppearance(reference);
    const headerMount = headerMountForReference(reference);
    if (headerMount) {
      // New Chat's container may be a horizontal action row. Our button occupies
      // its own navigation row without restyling the native container.
      entry.setAttribute("data-codex-taskboard-entry-layout", "navigation");
      entry.style.setProperty("order", getComputedStyle(headerMount.headerHost).order, "important");
      if (entry.parentElement !== headerMount.navigation || entry.nextElementSibling !== headerMount.scrollHost) {
        headerMount.scrollHost.before(entry);
      }
    } else {
      entry.removeAttribute("data-codex-taskboard-entry-layout");
      entry.style.removeProperty("order");
      if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
        reference.after(entry);
      }
    }
    syncEntryState();
  }

  function syncEntryAppearance(reference) {
    const label = reference.querySelector(".text-fade-truncate,span") || reference;
    const font = getComputedStyle(label), buttonStyle = getComputedStyle(reference);
    const icon = reference.querySelector("svg"), iconRect = icon?.getBoundingClientRect();
    const navRect = reference.closest('nav[role="navigation"]')?.getBoundingClientRect();
    const padding = iconRect?.width > 0 && navRect
      ? iconRect.left - navRect.left - 8 : parseFloat(buttonStyle.paddingLeft) || 8;
    const labelRect = label.getBoundingClientRect();
    const gap = iconRect?.width > 0 && label !== reference ? labelRect.left - iconRect.right : 8;
    const values = {
      height: `${Math.max(28, Math.min(40, reference.getBoundingClientRect().height || 32))}px`,
      padding: `${Math.max(4, Math.min(24, padding))}px`,
      icon: `${Math.max(14, Math.min(20, iconRect?.width || 18))}px`,
      gap: `${Math.max(4, Math.min(12, gap || 8))}px`,
      "font-family": font.fontFamily || "inherit", "font-size": font.fontSize || "14px",
      "font-weight": font.fontWeight || "400", "line-height": font.lineHeight || "20px",
      "letter-spacing": font.letterSpacing || "normal",
    };
    for (const [key, value] of Object.entries(values)) {
      const property = `--agent-desk-entry-${key}`;
      if (entry.style.getPropertyValue(property) !== value) entry.style.setProperty(property, value);
    }
  }

  function findPageHost() {
    // Native routes can retain a connected, hidden previous surface. Connectivity
    // alone cannot select the current page. Ignore only our own suppression.
    const available = (node) => {
      if (node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none") return false;
        if (style.visibility === "hidden" && !parent.closest(`[${HIDDEN_ATTRIBUTE}="true"]`)) return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const direct = Array.from(document.querySelectorAll(".app-shell-main-content-frame"))
      .filter((node) => node.closest("main[data-app-shell-main-content-layout], main [data-app-shell-main-content-layout]") && available(node));
    if (direct.length) return direct.length === 1 ? direct[0] : null;

    const viewports = Array.from(document.querySelectorAll(
      "main[data-app-shell-main-content-layout], main [data-app-shell-main-content-layout]",
    )).filter(available);
    if (viewports.length !== 1) return null;
    const viewport = viewports[0];
    const focusHosts = Array.from(viewport.children).filter((candidate) => (
      available(candidate) && candidate.querySelector('[data-app-shell-focus-area="main"]')
    ));
    if (focusHosts.length === 1) return focusHosts[0];
    const viewportRect = viewport.getBoundingClientRect();
    const candidates = Array.from(viewport.children).filter((candidate) => {
      if (candidate.getAttribute(OWNED_ATTRIBUTE) === "true") return false;
      if (!available(candidate)) return false;
      const rect = candidate.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8
        && rect.height >= viewportRect.height * 0.7;
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function findPageMount() {
    const frameHost = findPageHost();
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]");
    // Some conversation routes put the layout marker on main itself. Mount
    // inside that validated main, never in its unvalidated outer ancestor.
    const surface = viewport?.matches("main") ? viewport : viewport?.parentElement;
    if (!frameHost || !viewport || !surface || !surface.closest("main")) return null;
    return { frameHost, surface };
  }

  function muteNativeSelection() {
    if (!active) return;
    document.querySelectorAll('aside nav[role="navigation"] [aria-current]')
      .forEach((node) => {
        if (node === entry || node.closest(`#${ENTRY_ID}`)) return;
        if (!mutedNativeSelections.has(node)) {
          mutedNativeSelections.set(node, node.getAttribute("aria-current"));
        }
        node.removeAttribute("aria-current");
        node.setAttribute(NATIVE_SELECTED_ATTRIBUTE, "true");
      });
  }

  function restoreNativeSelection() {
    mutedNativeSelections.forEach((ariaCurrent, node) => {
      if (!node.isConnected) return;
      node.setAttribute("aria-current", ariaCurrent);
      node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE);
    });
    mutedNativeSelections.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE));
  }

  function hideNativeHeader() {
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]')
      .forEach((surface) => {
        Array.from(surface.children).forEach((child) => {
          if (child.getAttribute(OWNED_ATTRIBUTE) !== "true" && !child.contains(page)) {
            child.setAttribute(HIDDEN_ATTRIBUTE, "true");
          }
        });
        // New Chat renders its mode switch beside, rather than inside, the titlebar
        // surface. Restrict suppression to native chrome in that same shell header;
        // leave its drag area and unmarked window controls intact.
        const header = surface.closest("header[data-app-shell-header-layout]");
        header?.querySelectorAll("[data-app-shell-header-obstacle]").forEach((child) => {
          if (child.closest("header[data-app-shell-header-layout]") === header
            && !child.closest(`[${OWNED_ATTRIBUTE}="true"]`) && !child.contains(page)) {
            child.setAttribute(HIDDEN_ATTRIBUTE, "true");
          }
        });
      });
  }

  function currentTheme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    try {
      return window.getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function threadIdFromLocation() {
    const source = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function activeThreadRow() {
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
    return rows.find((row) => row.getAttribute("data-app-action-sidebar-thread-active") === "true")
      || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current")))
      || null;
  }

  function requestNativeFetch(path, body) {
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      const requestId = `taskboard-native-fetch-${crypto.randomUUID()}`;
      let settled = false;
      const finish = (value = null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "fetch-response"
          || message.requestId !== requestId
        ) return;
        try {
          finish(JSON.parse(message.bodyJsonString || "null"));
        } catch (_) {
          finish();
        }
      };
      const timeout = window.setTimeout(finish, 1_000);
      window.addEventListener("message", onMessage);
      try {
        bridge.sendMessageFromView({
          type: "fetch",
          requestId,
          method: "POST",
          url: `vscode://codex/${path}`,
          body: JSON.stringify(body),
        });
      } catch (_) {
        finish();
      }
    });
  }

  async function selectedNativeProjectId() {
    const selectedProject = (await requestNativeFetch(
      "get-global-state",
      { key: "selected-project" },
    ))?.value;
    return typeof selectedProject?.projectId === "string" ? selectedProject.projectId : "";
  }

  async function readCodexProjectMetadata() {
    const bootstrap = await window.electronBridge?.getInitialSidebarBootstrap?.();
    const entries = new Map(
      (Array.isArray(bootstrap?.globalStateEntries) ? bootstrap.globalStateEntries : [])
        .map((entry) => [entry?.key, entry?.value]),
    );
    const metadata = new Map();
    const localProjects = entries.get("local-projects");
    if (localProjects && typeof localProjects === "object" && !Array.isArray(localProjects)) {
      Object.entries(localProjects).forEach(([projectId, project]) => {
        const id = projectId.trim();
        const workspacePath = Array.isArray(project?.rootPaths)
          ? project.rootPaths.find((root) => typeof root === "string" && root.trim())?.trim()
          : "";
        if (!id) return;
        metadata.set(id, {
          projectKind: "local",
          hostId: "local",
          ...(workspacePath ? { workspacePath } : {}),
        });
      });
    }
    const remoteProjects = entries.get("remote-projects");
    if (Array.isArray(remoteProjects)) {
      remoteProjects.forEach((project) => {
        const id = typeof project?.id === "string" ? project.id.trim() : "";
        const workspacePath = typeof project?.remotePath === "string"
          ? project.remotePath.trim()
          : "";
        const hostId = typeof project?.hostId === "string" ? project.hostId.trim() : "";
        if (!id || !workspacePath || !hostId) return;
        metadata.set(id, {
          projectKind: "remote",
          workspacePath,
          hostId,
        });
      });
    }
    return metadata;
  }

  async function activeNativeWorkspaceRoots() {
    const roots = (await requestNativeFetch("active-workspace-roots", {}))?.roots;
    return Array.isArray(roots) ? roots.filter((root) => typeof root === "string") : [];
  }

  function normalizeNativeRootPath(value) {
    const path = String(value || "").trim();
    if (!path) return "";
    const windowsPath = /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\");
    const normalizedSlashes = windowsPath ? path.replace(/\\/g, "/") : path;
    const withoutTrailingSlash = normalizedSlashes.replace(/\/+$/, "")
      || (normalizedSlashes.startsWith("/") ? "/" : normalizedSlashes);
    if (!windowsPath || !/^[A-Za-z]:/.test(withoutTrailingSlash)) return withoutTrailingSlash;
    return `${withoutTrailingSlash[0].toLowerCase()}${withoutTrailingSlash.slice(1)}`;
  }

  function readCodexProjects(metadata = codexProjectMetadata) {
    const seen = new Set();
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .flatMap((row) => {
        const id = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
        const name = (
          row.getAttribute("data-app-action-sidebar-project-label")
          || row.getAttribute("aria-label")
          || ""
        ).trim();
        if (!id || !name || seen.has(id)) return [];
        seen.add(id);
        return [{ id, name, ...metadata.get(id) }];
      });
  }

  function findProjectsSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section-heading]"))
      .find((node) => PROJECT_SECTION_LABELS.includes(normalizedLabel(
        node.getAttribute("data-app-action-sidebar-section-heading") || node.textContent,
      )))
      ?.closest("[data-app-action-sidebar-section]") || null;
  }

  function findTasksSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section]"))
      .find((section) => {
        const heading = section.querySelector("[data-app-action-sidebar-section-heading]");
        const label = heading?.getAttribute("data-app-action-sidebar-section-heading")
          || heading?.textContent
          || section.textContent;
        return TASK_SECTION_LABELS.includes(normalizedLabel(label));
      }) || null;
  }

  async function captureHostContext() {
    const todoProgress = nativeTodoProgress();
    const [selectedProjectId, projectMetadata] = await Promise.all([
      selectedNativeProjectId(),
      readCodexProjectMetadata(),
    ]);
    codexProjectMetadata = projectMetadata;
    if (selectedProjectId) lastNativeProjectId = selectedProjectId;
    let projects = readCodexProjects(projectMetadata);
    let section = findProjectsSection();
    const sectionDeadline = Date.now() + 1_200;
    while (!section && Date.now() < sectionDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    const tasksSection = findTasksSection();
    const expandedSections = [section, tasksSection].filter((candidate) => (
      candidate?.getAttribute("data-app-action-sidebar-section-collapsed") === "true"
    ));
    expandedSections.forEach((candidate) => (
      candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click()
    ));
    if (expandedSections.length > 0) {
      const deadline = Date.now() + 1_200;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        projects = readCodexProjects(projectMetadata);
      } while ((projects.length === 0 || !activeThreadRow()) && Date.now() < deadline);
    }
    const context = readHostContext(projects, lastNativeProjectId);
    if (context.threadRunning && todoProgress) context.threadTodoProgress = todoProgress;
    expandedSections.forEach((candidate) => {
      if (candidate.isConnected && candidate.getAttribute("data-app-action-sidebar-section-collapsed") === "false") {
        candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
      }
    });
    return context;
  }

  function workspaceFromLocation() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("workspace") || url.searchParams.get("cwd") || "";
    } catch (_) {
      return "";
    }
  }

  function titlebarLeftInset() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return 0;
    if (nativeSidebarCollapsed()) return MACOS_TITLEBAR_SAFE_LEFT;
    const surfaceLeft = findPageMount()?.surface.getBoundingClientRect().left;
    if (!Number.isFinite(surfaceLeft)) return 0;
    return Math.max(0, Math.ceil(MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft));
  }

  function nativeSidebarTrigger() {
    const triggers = Array.from(
      document.querySelectorAll('[data-app-shell-sidebar-trigger="true"]'),
    );
    return triggers.find((trigger) => getComputedStyle(trigger).visibility !== "hidden")
      || triggers[0]
      || null;
  }

  function nativeSidebarCollapsed() {
    const label = normalizedLabel(nativeSidebarTrigger()?.getAttribute("aria-label"));
    return label.startsWith("显示") || label.startsWith("show ");
  }

  function sidebarThreadRow(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((candidate) => normalizeThreadId(
        candidate.getAttribute("data-app-action-sidebar-thread-id"),
      ) === normalizedThreadId) || null;
  }

  function nativeRunningThreadRow(preferredThreadId, preferredProjectId) {
    const rows = Array.from(document.querySelectorAll(".sidebar-item .animate-spin"))
      .map((spinner) => spinner.closest("[data-app-action-sidebar-thread-id]"))
      .filter(Boolean);
    const normalizedPreferredThreadId = normalizeThreadId(preferredThreadId);
    if (normalizedPreferredThreadId) {
      return rows.find((candidate) => normalizeThreadId(
        candidate.getAttribute("data-app-action-sidebar-thread-id"),
      ) === normalizedPreferredThreadId) || null;
    }
    if (preferredProjectId) {
      const projectRows = rows.filter((candidate) => (
        candidate.closest("[data-app-action-sidebar-project-list-id]")
          ?.getAttribute("data-app-action-sidebar-project-list-id") === preferredProjectId
      ));
      if (projectRows.length === 1) return projectRows[0];
    }
    return rows.length === 1 ? rows[0] : null;
  }

  function nativeThreadRunning(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const threadRow = sidebarThreadRow(normalizedThreadId);
    if (threadRow?.querySelector(".animate-spin")) return true;
    const running = Array.from(document.querySelectorAll("button[aria-label]")).some((button) => {
      const label = normalizedLabel(button.getAttribute("aria-label"));
      return ["停止", "停止生成", "stop", "stop generating"].includes(label);
    });
    const activeThreadId = normalizeThreadId(
      activeThreadRow()?.getAttribute("data-app-action-sidebar-thread-id"),
    );
    if (running && (!normalizedThreadId || activeThreadId === normalizedThreadId)) return true;
    if (threadRow) return false;
    const composer = document.querySelector(
      "[contenteditable='true'][role='textbox'], textarea",
    );
    return composer ? false : undefined;
  }

  function nativeTodoProgress() {
    const indicator = Array.from(
      document.querySelectorAll('[data-in-progress-fixed-content="true"]'),
    ).at(-1);
    const label = Array.from(indicator?.querySelectorAll("span") ?? [])
      .map((element) => element.textContent?.trim() ?? "")
      .find((text) => /\d+\s*\/\s*\d+/.test(text));
    const match = label?.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;
    const current = Number(match[1]);
    const total = Number(match[2]);
    return {
      completed: Math.max(0, Math.min(total, current - 1)),
      total,
    };
  }

  function expandNativeSidebar() {
    const trigger = nativeSidebarTrigger();
    if (!trigger || !nativeSidebarCollapsed()) return;
    trigger.click();
    window.setTimeout(postHostContext, REATTACH_DELAY_MS);
  }

  function userIdFromName(name) {
    const slug = name.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96);
    if (slug) return slug;
    let hash = 2166136261;
    for (const character of name) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `codex-user-${(hash >>> 0).toString(36)}`;
  }

  function readCodexUser() {
    const avatar = Array.from(document.querySelectorAll("img"))
      .find((image) => image.src.includes("cdn.auth0.com/avatars/"));
    const profileButton = avatar?.closest("button")
      || Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => (
        normalizedLabel(button.getAttribute("aria-label")).includes("profile")
        || normalizedLabel(button.getAttribute("aria-label")).includes("个人资料")
      ));
    const name = profileButton?.textContent?.replace(/\s+/g, " ").trim();
    if (!name) return null;
    const avatarUrl = avatar?.currentSrc || avatar?.src || null;
    return {
      type: "user",
      id: userIdFromName(name),
      name,
      avatarUrl,
    };
  }

  function readHostContext(projects = readCodexProjects(), preferredProjectId = lastNativeProjectId) {
    const row = activeThreadRow();
    const activeThreadId = normalizeThreadId(row?.getAttribute("data-app-action-sidebar-thread-id"));
    const projectList = row?.closest?.("[data-app-action-sidebar-project-list-id]");
    const projectRow = row?.closest?.("[data-app-action-sidebar-project-id]")
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    const projectId = projectList?.getAttribute("data-app-action-sidebar-project-list-id")
      || projectRow?.getAttribute("data-app-action-sidebar-project-id")
      || preferredProjectId
      || "";
    const preferredThreadId = activeThreadId || lastNativeThreadId;
    const runningThreadId = normalizeThreadId(
      nativeRunningThreadRow(preferredThreadId, projectId)
        ?.getAttribute("data-app-action-sidebar-thread-id"),
    );
    const currentThreadId = activeThreadId || runningThreadId || lastNativeThreadId;
    if (activeThreadId || (!lastNativeThreadId && runningThreadId)) {
      lastNativeThreadId = currentThreadId;
    }
    const threadId = currentThreadId || lastNativeThreadId || normalizeThreadId(threadIdFromLocation());
    const workspacePath = workspaceFromLocation()
      || projects.find((project) => project.id === projectId)?.workspacePath
      || "";
    const threadRunning = nativeThreadRunning(threadId);
    const payload = {
      language: hostLanguage(),
      theme: currentTheme(),
      projects,
      user: readCodexUser() ?? undefined,
      titlebarLeftInset: titlebarLeftInset(),
      sidebarCollapsed: nativeSidebarCollapsed(),
    };
    if (threadRunning !== undefined) payload.threadRunning = threadRunning;
    if (threadRunning) {
      const todoProgress = nativeTodoProgress();
      if (todoProgress) payload.threadTodoProgress = todoProgress;
    }
    if (workspacePath) payload.workspacePath = workspacePath;
    if (projectId) payload.projectId = projectId;
    if (threadId) payload.threadId = threadId;
    return payload;
  }

  function postToFrame(message, allowUnready = false) {
    if (!frame?.contentWindow || !frameOrigin || (!allowUnready && !frameReady)) return;
    frame.contentWindow.postMessage(message, frameOrigin === "null" ? "*" : frameOrigin);
  }

  function dispatchHostMessage(message) {
    window.postMessage(message, window.location.origin);
  }

  function postFrameChallenge() {
    if (!frameChallenge) return;
    postToFrame({
      type: "taskboard:frame-challenge",
      payload: { challenge: frameChallenge },
    }, true);
  }

  function postHostContext() {
    syncHostUiLanguage();
    if (!frame) return;
    const liveContext = readHostContext();
    const payload = hostContextSnapshot
      ? {
          ...hostContextSnapshot,
          ...liveContext,
          projects: liveContext.projects.length > 0
            ? liveContext.projects
            : hostContextSnapshot.projects,
        }
      : liveContext;
    postToFrame({ type: "taskboard:host-context", payload });
    postToFrame({ type: "taskboard:theme", theme: payload.theme });
  }

  function findThreadRow(threadId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)) || null;
  }

  function routeForThread(threadId) {
    return `/local/${encodeURIComponent(threadId)}`;
  }

  function threadRowProjectId(row) {
    return row?.closest?.("[data-app-action-sidebar-project-list-id]")
      ?.getAttribute("data-app-action-sidebar-project-list-id")
      || row?.closest?.("[data-app-action-sidebar-project-id]")
        ?.getAttribute("data-app-action-sidebar-project-id")
      || "";
  }

  function findThreadRowInProject(threadId, projectId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => (
        normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)
        && threadRowProjectId(row) === projectId
      )) || null;
  }

  function projectRowById(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => row.getAttribute("data-app-action-sidebar-project-id") === projectId.trim()) || null;
  }

  async function waitForRemoteProject(projectId, hostId, workspacePath) {
    if (!projectId || !hostId || hostId === "local") {
      throw new Error(hostText(
        "SSH 远程项目缺少精确的项目或主机标识",
        "The SSH remote project is missing its exact project or host identity",
      ));
    }
    await ensureProjectRows();
    const deadline = Date.now() + 8_000;
    let row = null;
    while (!row && Date.now() < deadline) {
      row = projectRowById(projectId);
      if (!row) await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (!row) {
      throw new Error(hostText(
        "Codex 中找不到精确的 SSH 远程项目",
        "The exact SSH remote project is not available in Codex",
      ));
    }
    if (row.getAttribute("data-app-action-sidebar-project-collapsed") === "true") {
      row.click?.();
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    const selectProject = row.querySelector("[data-app-action-sidebar-select-project]");
    if (!selectProject) {
      throw new Error(hostText(
        "Codex 中找不到对应的 SSH 远程项目",
        "The SSH remote project is not available in Codex",
      ));
    }
    selectProject.click?.();
    while (Date.now() < deadline) {
      const [selectedProjectId, metadata] = await Promise.all([
        selectedNativeProjectId(),
        readCodexProjectMetadata(),
      ]);
      const selectedProject = metadata.get(projectId);
      if (
        selectedProjectId === projectId
        && selectedProject?.projectKind === "remote"
        && selectedProject.hostId === hostId
        && (!workspacePath || selectedProject.workspacePath === workspacePath)
      ) {
        codexProjectMetadata = metadata;
        lastNativeProjectId = projectId;
        return row;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error(hostText(
      "Codex 没有确认目标 SSH 远程项目和主机",
      "Codex did not confirm the target SSH remote project and host",
    ));
  }

  async function waitForRemoteThreadRow(threadId, projectId) {
    const deadline = Date.now() + 8_000;
    let row = findThreadRowInProject(threadId, projectId);
    while (!row && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      row = findThreadRowInProject(threadId, projectId);
    }
    return row;
  }

  async function openThread(payload) {
    if (COMPATIBILITY_CAPABILITIES.taskNavigation === false) {
      postToFrame({
        type: "taskboard:thread-open-error",
        payload: {
          error: hostText(
            "当前 Codex 小版本未通过原生对话跳转兼容检查",
            "This Codex patch did not pass native conversation navigation compatibility checks",
          ),
        },
      });
      return;
    }
    const threadId = typeof payload?.threadId === "string" ? payload.threadId : "";
    if (typeof threadId !== "string" || !threadId.trim()) return;
    const normalizedThreadId = normalizeThreadId(threadId);
    const remoteProject = payload?.codexProjectKind === "remote";
    if (remoteProject) {
      try {
        const projectId = typeof payload?.codexProjectId === "string"
          ? payload.codexProjectId.trim()
          : "";
        const hostId = typeof payload?.codexHostId === "string"
          ? payload.codexHostId.trim()
          : "";
        const workspacePath = typeof payload?.workspacePath === "string"
          ? payload.workspacePath.trim()
          : "";
        await waitForRemoteProject(projectId, hostId, workspacePath);
        const row = await waitForRemoteThreadRow(normalizedThreadId, projectId);
        if (!row?.isConnected) {
          throw new Error(hostText(
            "目标 SSH 远程项目中找不到该对话",
            "The conversation is not available in the target SSH remote project",
          ));
        }
        lastNativeThreadId = normalizedThreadId;
        closeTaskboard(false);
        row.click?.();
      } catch (error) {
        postToFrame({
          type: "taskboard:thread-open-error",
          payload: {
            error: error instanceof Error
              ? error.message
              : hostText("无法打开 Codex 对话", "Could not open the Codex conversation"),
          },
        });
      }
      return;
    }
    lastNativeThreadId = normalizedThreadId;
    const row = findThreadRow(normalizedThreadId);
    closeTaskboard(false);

    if (row?.isConnected) {
      row.click?.();
      return;
    }

    try {
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: routeForThread(normalizedThreadId),
      });
    } catch (_) {}
  }

  async function nativeProjectContext() {
    const bootstrap = await window.electronBridge?.getInitialSidebarBootstrap?.();
    const entries = bootstrap?.globalStateEntries ?? [];
    const localProjects = entries.find((entry) => entry.key === "local-projects")?.value ?? {};
    return {
      projects: Object.entries(localProjects).flatMap(([id, project]) => (
        project && Array.isArray(project.rootPaths)
          ? [{ ...project, id }]
          : []
      )),
    };
  }

  async function resolveNativeProject(requestedProjectId, workspacePath) {
    const context = await nativeProjectContext();
    const normalizedWorkspacePath = normalizeNativeRootPath(workspacePath);
    const project = context.projects.find((candidate) => (
      candidate.id === requestedProjectId
      || candidate.rootPaths.some((root) => (
        normalizeNativeRootPath(root) === normalizedWorkspacePath
      ))
    )) ?? null;
    const targetRoot = normalizedWorkspacePath ? workspacePath : project?.rootPaths[0];
    return project && typeof targetRoot === "string" && normalizeNativeRootPath(targetRoot)
      ? { projectId: project.id, targetRoot }
      : null;
  }

  async function ensureProjectRows() {
    let section = findProjectsSection();
    const deadline = Date.now() + 1_200;
    while (!section && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    if (section?.getAttribute("data-app-action-sidebar-section-collapsed") === "true") {
      section.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
    }
    while (readCodexProjects().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  async function waitForNativeProject(targetRoot) {
    const deadline = Date.now() + 8_000;
    const normalizedTargetRoot = normalizeNativeRootPath(targetRoot);
    while (Date.now() < deadline) {
      const [projectId, activeRoots] = await Promise.all([
        selectedNativeProjectId(),
        activeNativeWorkspaceRoots(),
      ]);
      if (
        projectId
        && normalizeNativeRootPath(activeRoots[0]) === normalizedTargetRoot
      ) return projectId;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error(hostText(
      "Codex 未在限定时间内切换到目标项目或 worktree",
      "Codex did not switch to the target project or worktree in time",
    ));
  }

  async function createThreadForTask(payload) {
    const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
    const identifier = typeof payload?.identifier === "string" ? payload.identifier.trim() : "";
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const workspacePath = typeof payload?.workspacePath === "string"
      ? payload.workspacePath.trim()
      : "";
    const projectless = payload?.projectless === true;
    const codexProjectKind = payload?.codexProjectKind === "remote" ? "remote" : "local";
    const requestedProjectId = typeof payload?.codexProjectId === "string"
      ? payload.codexProjectId.trim()
      : "";
    if (
      !taskId
      || !identifier
      || !title
      || !instruction
      || pendingThreadCreation
    ) return;
    pendingThreadCreation = taskId;
    try {
      if (COMPATIBILITY_CAPABILITIES.taskNavigation === false) {
        throw new Error(hostText(
          "当前 Codex 小版本未通过原生对话跳转兼容检查",
          "This Codex patch did not pass native conversation navigation compatibility checks",
        ));
      }
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        throw new Error(hostText(
          "当前 Codex 版本没有提供原生对话导航能力",
          "This Codex version does not provide native conversation navigation",
        ));
      }

      if (!projectless && codexProjectKind === "remote") {
        const codexHostId = typeof payload?.codexHostId === "string"
          ? payload.codexHostId.trim()
          : "";
        const codexProjectWorkspacePath = typeof payload?.codexProjectWorkspacePath === "string"
          ? payload.codexProjectWorkspacePath.trim()
          : "";
        await waitForRemoteProject(requestedProjectId, codexHostId, codexProjectWorkspacePath);
      } else if (!projectless) {
        const target = await resolveNativeProject(requestedProjectId, workspacePath);
        if (!target) {
          throw new Error(hostText(
            "Codex 中没有映射目标项目或 worktree",
            "The target project or worktree is not mapped in Codex",
          ));
        }
        const { targetRoot } = target;
        bridge.sendMessageFromView({
          type: "electron-add-new-workspace-root-option",
          root: targetRoot,
        });
        lastNativeProjectId = await waitForNativeProject(targetRoot);
      }

      closeTaskboard(false);
      const focusComposerNonce = crypto.randomUUID();
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: "/",
        state: {
          focusComposerNonce,
          prefillPrompt: instruction,
          ...(projectless ? { project: null } : {}),
        },
      });
      postToFrame({ type: "taskboard:thread-prepared", payload: { taskId } });
    } catch (error) {
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: {
          taskId,
          error: error instanceof Error
            ? error.message
            : hostText("无法创建 Codex 对话", "Could not create the Codex conversation"),
        },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  function buildAutomationHostPayload(payload) {
    return {
      requestId: payload.requestId,
      operation: payload.operation,
      taskboardProjectId: payload.taskboardProjectId,
      codexProjectId: payload.codexProjectId,
      codexProjectKind: payload.codexProjectKind,
      codexHostId: payload.codexHostId,
      projectName: payload.projectName,
      workspacePath: payload.workspacePath,
      ...(payload.remoteProjects === undefined ? {} : { remoteProjects: payload.remoteProjects }),
      skillPath: payload.skillPath,
      ...(payload.automationId === undefined ? {} : { automationId: payload.automationId }),
      ...(payload.controllerThreadId === undefined
        ? {}
        : { controllerThreadId: payload.controllerThreadId }),
      enabledByUser: payload.enabledByUser,
      quotaAware: payload.quotaAware,
      intervalMinutes: payload.intervalMinutes,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
    };
  }

  async function handleAutomationRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    if (!isLocalTaskboardOrigin(taskboardOrigin)) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: {
          requestId,
          ok: false,
          error: hostText("仅本地任务面板可用", "Available only in the local Taskboard"),
        },
      });
      return;
    }
    try {
      const response = await requestHost(
        "automation",
        buildAutomationHostPayload(payload),
      );
      postToFrame({
        type: "taskboard:automation-response",
        payload: response.error
          ? { requestId, ok: false, error: response.error }
          : {
              requestId,
              ok: true,
              item: response.item,
              items: response.items,
              quota: response.quota,
              policy: response.policy,
            },
      });
    } catch (error) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error
            ? error.message
            : hostText("Codex 自动任务操作失败", "The Codex automation operation failed"),
        },
      });
    }
  }

  async function handleModelCatalogRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!/^[a-z0-9-]{1,80}$/i.test(requestId)) return;
    const challenge = frameChallenge;
    try {
      if (!isLocalTaskboardOrigin(taskboardOrigin)) throw new Error("Available only in the local Taskboard");
      const codexHostId = payload.codexHostId;
      if (codexHostId !== "local" && !readCodexProjects().some((project) => project.hostId === codexHostId)) {
        throw new Error("Codex model catalog host is unavailable");
      }
      const response = await requestHost("model-catalog", { codexHostId });
      if (challenge !== frameChallenge) return;
      postToFrame({ type: "taskboard:model-catalog-response", challenge, payload: {
        requestId, ok: !response.error, models: response.models, error: response.error,
      } });
    } catch (error) {
      if (challenge !== frameChallenge) return;
      postToFrame({ type: "taskboard:model-catalog-response", challenge, payload: {
        requestId, ok: false, error: error instanceof Error ? error.message : "Codex model catalog is unavailable",
      } });
    }
  }

  async function handleApprovalRequest(payload) {
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || !/^[a-z0-9-]{1,80}$/i.test(requestId)) return;
    const challenge = frameChallenge;
    try {
      if (!frameReady || !active || !isLocalTaskboardOrigin(taskboardOrigin)) throw new Error("请在已打开的智能体工作台内审批");
      const result = await requestHost("handoff-approval", { request: payload.request });
      if (challenge !== frameChallenge) return;
      postToFrame({ type: "taskboard:approval-response", challenge, payload: { requestId, ...result } });
    } catch (error) {
      if (challenge !== frameChallenge) return;
      postToFrame({ type: "taskboard:approval-response", challenge, payload: { requestId, ok: false, error: error.message } });
    }
  }

  function handleExternalOpen(payload) {
    try {
      const url = new URL(payload?.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      void requestHost("open-external", { url: url.href }).catch(() => {});
    } catch (_) {}
  }

  async function handleAttachmentOpen(payload) {
    try {
      await requestHost("open-attachment", {
        attachmentId: payload?.attachmentId,
        filename: payload?.filename,
      });
    } catch (_) {
      postToFrame({
        type: "taskboard:attachment-open-error",
        payload: {
          error: hostText(
            "无法在 Finder 中显示附件，请重试。",
            "Could not reveal the attachment in Finder. Try again.",
          ),
        },
      });
    }
  }

  function challengeFrameDocument(event) {
    if (!frame || event.currentTarget !== frame) return;
    frameLoadEvents = Math.min(frameLoadEvents + 1, 1000);
    frameReady = false;
    frameChallenge = crypto.randomUUID();
    if (active && statusView !== "error" && continuePreparation(openGeneration)) showLoading();
    recordWorkbenchState();
    postFrameChallenge();
  }

  function onFrameMessage(event) {
    if (!frame?.isConnected || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const message = event.data;
    if (
      !message
      || typeof message !== "object"
      || !frameCapability
      || message.capability !== frameCapability
    ) return;
    if (message.type === "taskboard:frame-awaiting-challenge") {
      if (statusView === "error") return;
      frameAwaitingChallenge = true;
      postFrameChallenge();
      return;
    }
    if (!frameChallenge || message.challenge !== frameChallenge) return;
    if (message.type === "taskboard:ready") {
      if (statusView === "error") return;
      if (frameReady) return;
      frameReady = true;
      frameReadyWaiters.forEach(({ resolve, timer }) => {
        window.clearTimeout(timer);
        resolve();
      });
      frameReadyWaiters.clear();
      if (active && frameLoadAcknowledged && continuePreparation(openGeneration)) showFrame();
      postHostContext();
      return;
    }
    if (message.type === "taskboard:drag-region") {
      updateDragRegion(message.payload);
      return;
    }
    if (message.type === "taskboard:open-thread") {
      void openThread(message.payload);
      return;
    }
    if (message.type === "taskboard:expand-sidebar") {
      expandNativeSidebar();
      return;
    }
    if (message.type === "taskboard:automation-request") {
      void handleAutomationRequest(message.payload);
      return;
    }
    if (message.type === "taskboard:model-catalog-request") {
      void handleModelCatalogRequest(message.payload);
      return;
    }
    if (message.type === "taskboard:approval-request") {
      void handleApprovalRequest(message.payload);
      return;
    }
    if (message.type === "taskboard:open-external") {
      handleExternalOpen(message.payload);
      return;
    }
    if (message.type === "taskboard:open-attachment") {
      void handleAttachmentOpen(message.payload);
      return;
    }
    if (message.type === "taskboard:create-thread") void createThreadForTask(message.payload);
  }

  function updateDragRegion(payload) {
    if (!dragRegion || !noDragLeft || !noDragRight) return;
    const [x, y, width, height] = [payload?.x, payload?.y, payload?.width, payload?.height];
    if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      dragRegion.hidden = true;
      noDragLeft.hidden = true;
      noDragRight.hidden = true;
      return;
    }
    const left = Math.max(0, x);
    const right = left + width;
    dragRegion.style.left = `${left}px`;
    dragRegion.style.top = `${Math.max(0, y)}px`;
    dragRegion.style.width = `${width}px`;
    dragRegion.style.height = `${height}px`;
    noDragLeft.style.left = "0";
    noDragLeft.style.top = `${Math.max(0, y)}px`;
    noDragLeft.style.width = `${left}px`;
    noDragLeft.style.height = `${height}px`;
    noDragRight.style.left = `${right}px`;
    noDragRight.style.top = `${Math.max(0, y)}px`;
    noDragRight.style.right = "0";
    noDragRight.style.height = `${height}px`;
    dragRegion.hidden = false;
    noDragLeft.hidden = left <= 0;
    noDragRight.hidden = right >= page.clientWidth;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", hostText("智能体工作台", "Agent Desk"));

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_REGION_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED_ATTRIBUTE, "true");
    dragRegion.setAttribute("aria-hidden", "true");
    section.appendChild(dragRegion);

    noDragLeft = document.createElement("div");
    noDragLeft.id = NO_DRAG_LEFT_ID;
    noDragLeft.hidden = true;
    noDragLeft.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragLeft.setAttribute("aria-hidden", "true");
    section.appendChild(noDragLeft);

    noDragRight = document.createElement("div");
    noDragRight.id = NO_DRAG_RIGHT_ID;
    noDragRight.hidden = true;
    noDragRight.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragRight.setAttribute("aria-hidden", "true");
    section.appendChild(noDragRight);
    return section;
  }

  function showLoading() {
    statusView = "loading";
    loadError = null;
    lastLoadFailure = "none";
    renderLoading();
    recordWorkbenchState();
  }

  function renderLoading() {
    if (!status) return;
    status.replaceChildren(document.createTextNode(hostText("正在启动智能体工作台…", "Starting Agent Desk…")));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function showFrame() {
    statusView = "frame";
    loadError = null;
    if (status) status.hidden = true;
    if (frame) {
      frame.hidden = false;
      frame.focus?.();
    }
    lastLoadFailure = "none";
    recordWorkbenchState();
  }

  function showLoadError(error) {
    statusView = "error";
    loadError = error;
    renderLoadError();
    lastLoadFailure = error?.diagnosticCode === "frame-timeout" ? "frame-timeout" : "load-failed";
    recordWorkbenchState();
  }

  function currentWorkbenchMount() {
    // A main layout can survive after its Codex sidebar has changed routes.
    // Both structural anchors must be available before hiding native content.
    if (!findReferenceButton()) return null;
    return findPageMount();
  }

  function continuePreparation(generation) {
    if (!active || generation !== openGeneration) return false;
    const mount = currentWorkbenchMount();
    if (!mount || page?.parentElement !== mount.surface || !page?.isConnected || page.hidden) {
      parkForRoute();
      return false;
    }
    return true;
  }

  function parkForRoute() {
    parkReason = "route-unavailable";
    closeTaskboard(false);
  }

  function renderLoadError() {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = hostErrorText(loadError);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = hostText("重新加载面板", "Reload panel");
    retry.addEventListener("click", openTaskboard, { once: true });
    content.append(text, retry);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function syncHostUiLanguage() {
    const language = resolvedHostLanguage();
    if (hostUiLanguage === language) return;
    hostUiLanguage = language;
    syncEntryText();
    if (page) page.setAttribute("aria-label", hostText("任务面板", "Taskboard"));
    if (frame) frame.title = hostText("任务面板", "Taskboard");
    if (statusView === "loading") renderLoading();
    else if (statusView === "error") renderLoadError();
  }

  function cancelFrameReadyWaiters(error) {
    frameReadyWaiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(error);
    });
    frameReadyWaiters.clear();
  }

  function waitForFrameReady() {
    if (frameReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          frameReadyWaiters.delete(waiter);
          const error = hostError("任务面板页面加载超时", "Taskboard page load timed out");
          error.diagnosticCode = "frame-timeout";
          reject(error);
        }, FRAME_READY_TIMEOUT_MS),
      };
      frameReadyWaiters.add(waiter);
    });
  }

  function resetTaskboardFrame() {
    cancelFrameReadyWaiters(hostError("任务面板正在重新加载", "Taskboard is reloading"));
    frame?.remove();
    frame = null;
    frameTaskboardUrl = "";
    frameCapability = "";
    frameChallenge = "";
    frameReady = false;
    frameLoadEvents = 0;
    frameAwaitingChallenge = false;
    frameLoadAcknowledged = false;
    if (dragRegion) dragRegion.hidden = true;
    if (noDragLeft) noDragLeft.hidden = true;
    if (noDragRight) noDragRight.hidden = true;
  }

  function loadTaskboardFrame(cacheBust = false) {
    resetTaskboardFrame();

    const taskboardUrl = resolveTaskboardUrl();
    if (cacheBust) {
      taskboardUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    taskboardOrigin = taskboardUrl.origin;
    frameTaskboardUrl = taskboardUrl.href;
    frameOrigin = "null";
    const frameName = `codex-taskboard-${crypto.randomUUID()}`;
    frameCapability = crypto.randomUUID();
    // A CDP document replacement can finish before the initial blank load event.
    // Establish this fresh frame's challenge before its first awaiting message.
    frameChallenge = crypto.randomUUID();
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.name = frameName;
    nextFrame.hidden = true;
    nextFrame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-downloads");
    nextFrame.src = "about:blank";
    nextFrame.title = hostText("任务面板", "Taskboard");
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    nextFrame.addEventListener("load", challengeFrameDocument);
    frame = nextFrame;
    page.appendChild(nextFrame);
    recordWorkbenchState();
    return { frameName, frameCapability };
  }

  function reloadFrame() {
    if (!frame || !active || !continuePreparation(openGeneration)) return false;
    const generation = ++openGeneration;
    showLoading();
    void prepareFrame(generation, true)
      .then(() => {
          if (!continuePreparation(generation)) return;
          loadStage = "ready";
          showFrame();
          postHostContext();
      })
      .catch((error) => {
        if (!continuePreparation(generation)) return;
        showLoadError(error);
      });
    return true;
  }

  function managedTaskboardOrigin() {
    const configured = typeof window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ === "string"
      ? window.__CODEX_TASKBOARD_MANAGED_ORIGIN__.trim()
      : "";
    try {
      return new URL(configured || DEFAULT_TASKBOARD_URL).origin;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL).origin;
    }
  }

  function hasLiveHostBinding() {
    return typeof HOST_CAPABILITY === "string"
      && HOST_CAPABILITY.length > 0
      && Number.isFinite(hostHeartbeatAt)
      && Date.now() - hostHeartbeatAt <= HOST_HEARTBEAT_MAX_AGE_MS;
  }

  function requestHost(action, payload = {}, timeoutMs = HOST_REQUEST_TIMEOUT_MS) {
    if (!hasLiveHostBinding()) {
      if (action === "handoff-approval") {
        return Promise.reject(hostError(
          "审批通道未连接，请从 Agent Desk 托盘打开 Codex，再刷新审批中心核对状态",
          "The approval channel is disconnected. Open Codex from the Agent Desk tray, then refresh the approval center to check its state",
        ));
      }
      return Promise.reject(hostError(
        "Taskboard 启动器未运行，无法操作 Codex 对话输入框",
        "The Taskboard launcher is not running, so the Codex composer is unavailable",
      ));
    }

    const id = `${Date.now().toString(36)}-${(++hostRequestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs === null
        ? null
        : window.setTimeout(() => {
          hostRequests.delete(id);
          const error = action === "handoff-approval"
            ? hostError("审批通道没有响应，请刷新核对状态；不要重复提交", "The approval channel did not respond. Refresh to check its state; do not submit again")
            : hostError("任务面板启动器没有响应", "The Taskboard launcher did not respond");
          if (action === "start-task-conversation") error.uncertain = true;
          reject(error);
        }, timeoutMs);
      hostRequests.set(id, { resolve, reject, timeout });
      try {
        window.postMessage({
          type: HOST_REQUEST_MESSAGE,
          capability: HOST_CAPABILITY,
          payload: { ...payload, id, action },
        }, window.location.origin);
      } catch (error) {
        if (timeout !== null) window.clearTimeout(timeout);
        hostRequests.delete(id);
        reject(error);
      }
    });
  }

  function requestHostEnsure(taskboardUrl) {
    if (taskboardUrl.origin !== managedTaskboardOrigin() || !hasLiveHostBinding()) {
      return Promise.resolve({ managed: false, restarted: false });
    }
    return requestHost("ensure");
  }

  function requestHostLoadFrame({ frameName, frameCapability: capability }) {
    return requestHost("load-frame", { frameName, frameCapability: capability });
  }

  async function prepareFrame(generation, cacheBust = false) {
    // A superseded host bootstrap must restore CSP before another is issued.
    // Wait for its settlement; do not retry it or accept its old authority.
    while (framePreparation) {
      loadStage = "queued";
      recordWorkbenchState();
      try { await framePreparation; } catch (_) {}
      if (!continuePreparation(generation)) return;
    }
    if (!continuePreparation(generation)) return;
    loadStage = "bootstrap";
    const frameRequest = loadTaskboardFrame(cacheBust);
    const pending = requestHostLoadFrame(frameRequest);
    framePreparation = pending;
    try { await pending; }
    finally { if (framePreparation === pending) framePreparation = null; }
    if (!continuePreparation(generation)) return;
    frameLoadAcknowledged = true;
    loadStage = "handshake";
    recordWorkbenchState();
    await waitForFrameReady();
  }

  function frameMatchesTaskboardUrl(taskboardUrl) {
    if (!frame || !frameTaskboardUrl) return false;
    try {
      const loadedUrl = new URL(frameTaskboardUrl);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(taskboardUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function onHostResponse(response) {
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = hostRequests.get(response.id);
    if (!pending) return;
    if (pending.timeout !== null) window.clearTimeout(pending.timeout);
    hostRequests.delete(response.id);
    if (response.ok) pending.resolve(response);
    else {
      const error = response.error
        ? new Error(response.error)
        : hostError("任务面板服务启动失败", "The Taskboard service failed to start");
      if (typeof response.threadId === "string") error.threadId = response.threadId;
      if (response.uncertain === true) error.uncertain = true;
      pending.reject(error);
    }
  }

  function onHostBridgeMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.capability !== HOST_CAPABILITY) return;
    if (message.type === HOST_HEARTBEAT_MESSAGE) {
      hostHeartbeatAt = Number(message.at) || 0;
      window[HOST_STARTUP_TOKEN_NAME] = message.startupToken ?? null;
      return;
    }
    if (message.type === HOST_RESPONSE_MESSAGE) onHostResponse(message.response);
  }

  async function prepareTaskboard(generation) {
    if (!continuePreparation(generation)) return;
    const taskboardUrl = resolveTaskboardUrl();
    const canReuseFrame = Boolean(
      frameReady
      && frameLoadAcknowledged
      && frame?.isConnected
      && frameMatchesTaskboardUrl(taskboardUrl),
    );
    if (canReuseFrame) showFrame();
    else showLoading();

    try {
      // Native project metadata is supplemental. Slow or failed queries must not
      // gate a usable panel; late data can only update the current open generation.
      void captureHostContext().then((context) => {
        if (!active || generation !== openGeneration) return;
        hostContextSnapshot = { ...hostContextSnapshot, ...context,
          projects: context.projects.length > 0 ? context.projects : hostContextSnapshot?.projects ?? [] };
        postHostContext();
      }, () => {});
      loadStage = "ensure";
      recordWorkbenchState();
      const result = await requestHostEnsure(taskboardUrl);
      if (!continuePreparation(generation)) return;
      if (!frameReady || !frameLoadAcknowledged || !frame?.isConnected || result.restarted || !frameMatchesTaskboardUrl(taskboardUrl)) {
        showLoading();
        await prepareFrame(generation);
      }
      if (!continuePreparation(generation)) return;
      loadStage = "ready";
      showFrame();
      postHostContext();
    } catch (error) {
      if (!continuePreparation(generation)) return;
      const bindingAvailable = hasLiveHostBinding();
      showLoadError(bindingAvailable
        ? error
        : hostError(
          "任务面板服务未就绪。请保持 Taskboard 启动器运行后重试。",
          "The Taskboard service is not ready. Keep the Taskboard launcher running and try again.",
        ));
    }
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN_ATTRIBUTE));
    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HOST_ATTRIBUTE));
  }

  function closeNativeBrowserPanel() {
    if (suspendedNativeBrowserPanel) return;
    const browserPanel = Array.from(
      document.querySelectorAll("[data-browser-sidebar-webview]"),
    ).find((node) => window.getComputedStyle(node).visibility !== "hidden");
    if (!browserPanel) return;
    const webview = browserPanel.querySelector("webview");
    suspendedNativeBrowserPanel = {
      conversationId: webview?.getAttribute("data-browser-sidebar-conversation-id") || null,
      browserTabId: webview?.getAttribute("data-browser-sidebar-browser-tab-id") || null,
    };
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "toggle-browser-panel",
        open: false,
        source: "manual",
        initiator: "taskboard_open",
      },
    }));
  }

  function restoreNativeBrowserPanel() {
    const browserPanel = suspendedNativeBrowserPanel;
    suspendedNativeBrowserPanel = null;
    if (!browserPanel) return;
    const data = {
      type: "toggle-browser-panel",
      open: true,
      source: "manual",
      initiator: "taskboard_close",
    };
    if (browserPanel.conversationId) data.conversationId = browserPanel.conversationId;
    if (browserPanel.browserTabId) data.browserTabId = browserPanel.browserTabId;
    window.dispatchEvent(new MessageEvent("message", { data }));
  }

  function mountActivePage() {
    if (!active) return;
    const mount = currentWorkbenchMount();
    if (!mount) { parkForRoute(); return; }
    if (!page) page = createPage();
    const { surface } = mount;

    const frameReset = page.parentElement !== surface && Boolean(frame);
    if (page.parentElement !== surface) {
      // Moving a subtree reloads its iframe browsing context to about:blank.
      // Drop its old capability/readiness before moving; load only a fresh frame.
      if (frameReset) resetTaskboardFrame();
      restoreNativeContent();
      surface.appendChild(page);
    }
    surface.setAttribute(HOST_ATTRIBUTE, "true");
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
        child.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    });
    hideNativeHeader();
    muteNativeSelection();
    page.hidden = false;
    mountState = "mounted";
    document.documentElement.setAttribute("data-codex-taskboard-open", "true");
    return frameReset;
  }

  function closeTaskboard(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    openGeneration += 1;
    active = false;
    mountState = "parked";
    loadStage = "idle";
    statusView = "idle";
    lastLoadFailure = "none";
    cancelFrameReadyWaiters(hostError("任务面板已关闭", "Taskboard was closed"));
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeBrowserPanel();
    restoreNativeSelection();
    document.documentElement.removeAttribute("data-codex-taskboard-open");
    syncEntryState();
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
    hostContextSnapshot = null;
    recordWorkbenchState();
  }

  function openTaskboard() {
    if (destroyed) return;
    parkReason = "none";
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = readHostContext();
    }
    const generation = ++openGeneration;
    active = true;
    closeNativeBrowserPanel();
    ensureEntry();
    mountActivePage();
    if (mountState !== "mounted") {
      // Never reuse a ready frame in a hidden previous route. Retain native
      // content and report the structural refusal on our own entry only.
      closeTaskboard(false);
      mountState = "unavailable";
      statusView = "error";
      lastLoadFailure = "mount-unavailable";
      if (entry) entry.title = hostText("当前页面缺少可用的工作台挂载位置，请稍后重试", "No workbench mount is available on this page; try again later");
      recordWorkbenchState();
      return;
    }
    if (entry) entry.removeAttribute("title");
    syncEntryState();
    recordWorkbenchState();
    void prepareTaskboard(generation);
  }

  function isNativePageNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!clickable || clickable === entry || clickable.closest(`#${ENTRY_ID}`)) return false;
    if (!clickable.closest("aside nav[role='navigation']")) return false;
    if (clickable.hasAttribute("data-app-action-sidebar-section-toggle")) return false;
    // Every native row in the validated fixed header changes the native page,
    // including Pro's Your dot. Never depend on its translated/custom label.
    if (headerMountForReference(clickable)) return true;
    if (buttonMatches(clickable, NATIVE_PAGE_LABELS)) return true;
    return Boolean(clickable.closest(
      "[data-app-action-sidebar-thread-id],"
      + "[data-app-action-sidebar-project-row],"
      + "[data-app-action-sidebar-project-id]",
    ));
  }

  function onDocumentClick(event) {
    const threadRow = event.target?.closest?.("[data-app-action-sidebar-thread-id]");
    const clickedThreadId = normalizeThreadId(threadRow?.getAttribute?.("data-app-action-sidebar-thread-id"));
    if (clickedThreadId) lastNativeThreadId = clickedThreadId;
    if (!active || !isNativePageNavigation(event.target)) return;
    closeTaskboard(false);
  }

  function scheduleRefresh() {
    if (destroyed || reattachTimer !== null) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = null;
      ensureEntry();
      const frameReset = mountActivePage();
      if (frameReset) void prepareTaskboard(++openGeneration);
      postHostContext();
    }, REATTACH_DELAY_MS);
  }

  function refresh() {
    ensureEntry();
    const frameReset = mountActivePage();
    if (frameReset) void prepareTaskboard(++openGeneration);
    postHostContext();
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "data-theme",
        "data-color-theme",
        "data-app-action-sidebar-thread-active",
        "aria-label",
        "aria-current",
        "hidden", "inert", "aria-hidden", "role", "data-app-shell-left-panel-appearance",
      ],
    });
    hostContextTimer = window.setInterval(postHostContext, 1_000);
    postHostContext();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    recordWorkbenchState();
    if (reattachTimer !== null) window.clearTimeout(reattachTimer);
    reattachTimer = null;
    if (hostContextTimer !== null) window.clearInterval(hostContextTimer);
    hostContextTimer = null;
    observer?.disconnect();
    observer = null;
    cancelFrameReadyWaiters(hostError("任务面板已关闭", "Taskboard was closed"));
    hostRequests.forEach(({ reject, timeout }) => {
      if (timeout !== null) window.clearTimeout(timeout);
      reject(hostError("任务面板已关闭", "Taskboard was closed"));
    });
    hostRequests.clear();
    pendingThreadCreation = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("message", onHostBridgeMessage);
    window.removeEventListener("popstate", onNativeRouteChange);
    window.removeEventListener("hashchange", onNativeRouteChange);
    window.removeEventListener("resize", scheduleRefresh);
    closeTaskboard(false);
    document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    entry = null;
    entryReference = null;
    entryLabel = null;
    page = null;
    frame = null;
    dragRegion = null;
    noDragLeft = null;
    noDragRight = null;
    status = null;
    frameOrigin = "";
    taskboardOrigin = "";
    frameTaskboardUrl = "";
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  function onNativeRouteChange() {
    if (active) closeTaskboard(false);
  }

  function recordWorkbenchState() {
    const entryRect = entry?.getBoundingClientRect();
    const referenceRect = entryReference?.getBoundingClientRect();
    const visibility = (node) => {
      if (!node?.isConnected) return "disconnected";
      if (node.hidden) return "hidden";
      if (node.closest('[hidden], [inert], [aria-hidden="true"]')) return "native-hidden";
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return "zero-size";
      let depth = 0;
      for (let parent = node; parent; parent = parent.parentElement) {
        if (++depth > 64) return "depth-limit";
        const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return parent.closest(`[${HIDDEN_ATTRIBUTE}="true"]`) ? "suppressed" : "native-hidden";
        if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)
          && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) return "clipped";
        if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)
          && (rect.left < box.left - 1 || rect.right > box.right + 1)) return "clipped";
      }
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth ? "visible" : "offscreen";
    };
    const visible = node => visibility(node) === "visible";
    const scroll = entry?.parentElement?.querySelector("div.overflow-y-auto");
    const boundedSize = (value) => Number.isFinite(value) ? Math.min(32768, Math.max(0, Math.round(value))) : 0;
    const frameBox = frame?.getBoundingClientRect();
    const frameOccluded = Boolean(active && visible(frame) && typeof document.elementFromPoint === "function"
      && document.elementFromPoint(frameBox.left + frameBox.width / 2, frameBox.top + frameBox.height / 2) !== frame);
    const value = { phase: statusView, active, destroyed, frameReady,
      frameLoadEvents, frameAwaitingChallenge, frameLoadAcknowledged,
      pageConnected: Boolean(page?.isConnected), frameConnected: Boolean(frame?.isConnected),
      hostBindingLive: hasLiveHostBinding(), openGeneration, failure: lastLoadFailure,
      mountState, loadStage, parkReason, routeEligible: Boolean(currentWorkbenchMount()),
      pageHidden: Boolean(page?.hidden), pageVisibility: visibility(page), frameVisibility: visibility(frame),
      entryConnected: Boolean(entry?.isConnected),
      entryHidden: Boolean(entry?.hidden),
      entryHeight: boundedSize(entryRect?.height),
      entryOversized: Boolean(entryRect?.height > 48),
      entryVisible: visible(entry),
      listUsable: Boolean(scroll?.isConnected && scroll.getBoundingClientRect().height >= 80 && visible(scroll)),
      pageVisible: visible(page), frameVisible: visible(frame), frameOccluded,
      entrySeparateRow: Boolean(entry?.isConnected && entryReference?.isConnected
        && entry.getAttribute("data-codex-taskboard-entry-layout") === "navigation"
        && entry.parentElement !== entryReference.parentElement),
      entrySharesNativeRow: Boolean(entry?.isConnected && entryReference?.isConnected
        && entryRect?.height > 0 && referenceRect?.height > 0
        && Math.min(entryRect.bottom, referenceRect.bottom) > Math.max(entryRect.top, referenceRect.top) + 1) };
    const fingerprint = JSON.stringify(value);
    if (fingerprint === workbenchFingerprint) return;
    workbenchFingerprint = fingerprint;
    workbenchTrace.push({ ...value, sequence: ++workbenchSequence, atMs: Date.now() });
    if (workbenchTrace.length > 64) workbenchTrace.shift();
  }

  function diagnostics(afterSequence = 0) {
    recordWorkbenchState();
    const after = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    return { schemaVersion: 1, sequence: workbenchSequence,
      events: workbenchTrace.filter((event) => event.sequence > after).map((event) => ({ ...event })) };
  }

  const api = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    get ready() {
      return frameReady;
    },
    refresh,
    reloadFrame,
    open: openTaskboard,
    close: closeTaskboard,
    destroy,
    diagnostics,
  };
  window[SENTINEL_KEY] = api;

  window.addEventListener("message", onFrameMessage);
  window.addEventListener("message", onHostBridgeMessage);
  window.addEventListener("popstate", onNativeRouteChange);
  window.addEventListener("hashchange", onNativeRouteChange);
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("click", onDocumentClick, true);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
