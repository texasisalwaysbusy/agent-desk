// Package identity and signatures are checked by the native launcher. A version
// number only admits a read-only probe; it never authorizes renderer mutation.
const minimumWindowsCodexVersion = "26.818.5229.0";

const rendererContractProbeExpression = String.raw`(() => {
  const normalizedLabel = (value) => String(value || "").trim().toLowerCase();
  const pluginLabels = ["插件", "plugins"];
  const appProtocol = window.location.protocol === "app:";
  const topFrame = window.top === window;
  const visibleSidebar = (candidate) => {
    if (!candidate || candidate.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && rect.width >= 160 && rect.height >= 180;
  };
  const visibleFlow = (candidate) => candidate && !candidate.closest('[hidden], [inert], [aria-hidden="true"]')
    && getComputedStyle(candidate).display !== "none" && getComputedStyle(candidate).visibility !== "hidden"
    && candidate.getBoundingClientRect().width >= 100;
  const legacyScrolls = Array.from(document.querySelectorAll(
    "[data-app-action-sidebar-scroll]",
  )).filter((candidate) => visibleSidebar(candidate.closest("aside")) && visibleFlow(candidate));
  const legacyScroll = legacyScrolls.length === 1 ? legacyScrolls[0] : null;
  const modernSidebars = Array.from(document.querySelectorAll(
    'aside[data-app-shell-left-panel-appearance]',
  )).filter(visibleSidebar);
  const modernSidebar = modernSidebars.length === 1 ? modernSidebars[0] : null;
  const modernNavigations = Array.from(modernSidebar?.querySelectorAll(
    'nav[role="navigation"][aria-label]',
  ) || []).filter(visibleFlow);
  const modernNavigation = modernNavigations.length === 1 ? modernNavigations[0] : null;
  const modernScrolls = Array.from(modernNavigation?.querySelectorAll("div.overflow-y-auto") || []).filter(visibleFlow);
  const modernScroll = modernScrolls.length === 1 ? modernScrolls[0] : null;
  const ambiguousSidebars = legacyScrolls.length > 1 || modernSidebars.length > 1
    || (legacyScroll && modernSidebar && !modernSidebar.contains(legacyScroll));
  const sidebarScroll = ambiguousSidebars ? null
    : legacyScroll || (modernSidebar?.contains(modernScroll) ? modernScroll : null);
  const sidebar = legacyScroll?.closest("aside") || modernSidebar;
  const viewport = document.querySelector("main[data-app-shell-main-content-layout]")
    || document.querySelector('main[data-app-shell-main-surface="default"] [data-app-shell-main-content-layout]')
    || document.querySelector("main [data-app-shell-main-content-layout]");
  const directFrameHost = document.querySelector(".app-shell-main-content-frame");
  let frameHost = directFrameHost?.closest?.("[data-app-shell-main-content-layout]")
    ? directFrameHost
    : null;
  if (!frameHost && viewport) {
    const focusHosts = Array.from(viewport.children).filter((candidate) => (
      candidate.querySelector('[data-app-shell-focus-area="main"]')
    ));
    if (focusHosts.length === 1) frameHost = focusHosts[0];
  }
  if (!frameHost && viewport) {
    const viewportRect = viewport.getBoundingClientRect();
    frameHost = Array.from(viewport.children).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8
        && rect.height >= viewportRect.height * 0.7;
    }) || null;
  }
  const surface = viewport?.matches("main") ? viewport : viewport?.parentElement || null;
  const pageMount = Boolean(
    frameHost
    && viewport
    && surface
    && surface.closest("main"),
  );
  const buttons = sidebarScroll ? Array.from(sidebarScroll.querySelectorAll("button")) : [];
  const pluginButton = buttons.find((button) => pluginLabels.includes(normalizedLabel(
    button.textContent || button.getAttribute("aria-label"),
  )));
  const firstSection = sidebarScroll?.querySelector("[data-app-action-sidebar-section]") || null;
  const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
  const fallbackGroup = sidebarScroll
    ? Array.from(sidebarScroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    }).sort((left, right) => right.children.length - left.children.length)[0]
    : null;
  const modernButton = modernScroll?.querySelector("button.sidebar-item");
  const modernLink = modernScroll?.querySelector("a.sidebar-item[href]");
  const modernReference = modernScroll?.querySelector("button.sidebar-item, a.sidebar-item[href]");
  // In the 26.924 shell the fixed navigation header precedes the thread scroller.
  // Require their unique direct-child relationship before accepting its native row.
  const scrollHosts = modernNavigation && modernScroll
    ? Array.from(modernNavigation.children).filter((child) => child.contains(modernScroll)) : [];
  const scrollHost = scrollHosts.length === 1 ? scrollHosts[0] : null;
  // The unique native scroll host gains our own adjacent quota section. It is not a
  // new native navigation section; ignore only its exact owner and position.
  const nativeNavigationChildren = Array.from(modernNavigation?.children || []).filter(visibleFlow).filter((child) => !(
    child.tagName === "SECTION" && child.id === "codex-taskboard-quota-display"
    && child.getAttribute("data-codex-taskboard-owned") === "quota-display"
    && scrollHost && child.previousElementSibling === scrollHost
    && scrollHost.parentElement === modernNavigation
  ) && !(
    child.tagName === "BUTTON" && child.id === "codex-taskboard-entry"
    && child.getAttribute("data-codex-taskboard-owned") === "true"
    && child.getAttribute("data-codex-taskboard-entry-layout") === "navigation"
    && scrollHost && child.nextElementSibling === scrollHost
    && document.querySelectorAll("#codex-taskboard-entry").length === 1
  ));
  const headerHost = nativeNavigationChildren.length === 2
    && nativeNavigationChildren[1] === scrollHost
    ? nativeNavigationChildren[0] : null;
  const headerButtons = headerHost
    ? Array.from(headerHost.querySelectorAll("button.sidebar-item"))
      .filter((button) => !(button.id === "codex-taskboard-entry"
        && button.getAttribute("data-codex-taskboard-owned") === "true")) : [];
  const headerReference = headerButtons.length === 1 && !modernScroll?.contains(headerButtons[0])
    && Boolean(headerButtons[0].parentElement);
  const legacyReference = Boolean(pluginButton?.parentElement
    || Array.from(fallbackGroup?.children || []).some((child) => child.tagName === "BUTTON"));
  const referenceButton = Boolean(
    legacyReference
    || (modernReference && sidebarScroll?.contains(modernReference))
    || (headerReference && sidebarScroll === modernScroll),
  );
  const nativeBridge = Boolean(
    window.electronBridge
    && typeof window.electronBridge.sendMessageFromView === "function",
  );
  const count = (root, selector) => Math.min(root?.querySelectorAll(selector).length || 0, 1000);
  const shape = {
    sameScroll: Boolean(legacyScroll && modernScroll && legacyScroll === modernScroll),
    navigationElements: count(modernNavigation, "*"),
    navigationButtons: count(modernNavigation, "button"),
    navigationLinks: count(modernNavigation, "a[href]"),
    navigationRoleButtons: count(modernNavigation, '[role="button"]'),
    scrollButtons: count(sidebarScroll, "button"),
    scrollLinks: count(sidebarScroll, "a[href]"),
    scrollRoleButtons: count(sidebarScroll, '[role="button"]'),
    scrollSidebarItems: count(sidebarScroll, ".sidebar-item"),
    scrollElements: count(sidebarScroll, "*"),
    scrollDirectChildren: Math.min(sidebarScroll?.children.length || 0, 1000),
  };
  const fullPanel = Boolean(appProtocol && topFrame && sidebarScroll && pageMount && referenceButton);
  return {
    schemaVersion: 1,
    shape,
    checks: {
      appProtocol,
      topFrame,
      sidebarScroll: Boolean(sidebarScroll),
      sidebar: Boolean(sidebar),
      pageMount,
      referenceButton,
      nativeBridge,
      legacyScroll: Boolean(legacyScroll),
      modernScroll: Boolean(modernScroll),
      legacyReference,
      modernButton: Boolean(modernButton),
      modernLink: Boolean(modernLink),
      modernReferenceInChosenScroll: Boolean(modernReference && sidebarScroll?.contains(modernReference)),
      headerReference: Boolean(headerReference && sidebarScroll === modernScroll),
    },
    capabilities: {
      fullPanel,
      quotaDisplay: Boolean(fullPanel && sidebar && sidebarScroll?.parentElement && nativeBridge),
      taskNavigation: Boolean(fullPanel && nativeBridge),
    },
  };
})()`;

function parseWindowsCodexVersion(version) {
  if (typeof version !== "string" || !/^\d{1,5}(?:\.\d{1,5}){3}$/.test(version.trim())) {
    return null;
  }
  const parts = version.trim().split(".").map(Number);
  return parts.every((part) => part <= 65_535) ? parts : null;
}

function classifyWindowsCodexCompatibility({ platform, version }) {
  const parts = parseWindowsCodexVersion(version);
  const baseline = parseWindowsCodexVersion(minimumWindowsCodexVersion);
  const differentPart = parts?.findIndex((part, index) => part !== baseline[index]);
  const atOrAboveBaseline = parts && (differentPart === -1
    || parts[differentPart] > baseline[differentPart]);
  const reason = platform !== "win32" ? "unsupported-platform"
    : !parts ? "invalid-package-version"
      : !atOrAboveBaseline ? "below-tested-baseline" : null;
  return {
    mode: reason ? "shortcut-plugin-only" : "contract-probe",
    reason,
    family: parts ? `${parts[0]}.${parts[1]}` : null,
    capabilities: null,
  };
}

function normalizeRendererContractProbe(value) {
  if (!value || value.schemaVersion !== 1) {
    return {
      compatible: false,
      reason: "invalid-probe-result",
      checks: null,
      capabilities: null,
    };
  }
  const checks = {
    appProtocol: value.checks?.appProtocol === true,
    topFrame: value.checks?.topFrame === true,
    sidebarScroll: value.checks?.sidebarScroll === true,
    sidebar: value.checks?.sidebar === true,
    pageMount: value.checks?.pageMount === true,
    referenceButton: value.checks?.referenceButton === true,
    nativeBridge: value.checks?.nativeBridge === true,
    legacyScroll: value.checks?.legacyScroll === true,
    modernScroll: value.checks?.modernScroll === true,
    legacyReference: value.checks?.legacyReference === true,
    modernButton: value.checks?.modernButton === true,
    modernLink: value.checks?.modernLink === true,
    modernReferenceInChosenScroll: value.checks?.modernReferenceInChosenScroll === true,
    headerReference: value.checks?.headerReference === true,
  };
  const shapeKeys = [
    "navigationElements", "navigationButtons", "navigationLinks", "navigationRoleButtons",
    "scrollButtons", "scrollLinks", "scrollRoleButtons", "scrollSidebarItems",
    "scrollElements", "scrollDirectChildren",
  ];
  const shape = {
    ...(typeof value.shape?.sameScroll === "boolean"
      ? { sameScroll: value.shape.sameScroll } : {}),
    ...Object.fromEntries(shapeKeys
      .filter((key) => Number.isInteger(value.shape?.[key])
        && value.shape[key] >= 0 && value.shape[key] <= 1000)
      .map((key) => [key, value.shape[key]])),
  };
  // Never accept a claimed capability when its prerequisite checks are absent.
  const fullPanel = checks.appProtocol && checks.topFrame && checks.sidebarScroll
    && checks.pageMount && checks.referenceButton && value.capabilities?.fullPanel === true;
  const capabilities = {
    fullPanel,
    quotaDisplay: fullPanel && checks.sidebar && checks.nativeBridge
      && value.capabilities?.quotaDisplay === true,
    taskNavigation: fullPanel && checks.nativeBridge && value.capabilities?.taskNavigation === true,
  };
  return {
    compatible: capabilities.fullPanel,
    reason: capabilities.fullPanel ? null : "renderer-contract-mismatch",
    checks,
    capabilities,
    shape,
  };
}

function guardRendererInjectionSource(source, allowedCapabilities, {
  timeoutMs = 20_000,
  retryMs = 250,
} = {}) {
  // addScriptToEvaluateOnNewDocument also runs in child frames and after reloads.
  // No configuration, host capability or UI code reaches an unvalidated document.
  return `(async () => {
    if (window.top !== window || window.location.protocol !== "app:") return;
    const pendingKey = "__CODEX_TASKBOARD_PENDING_INJECTION__";
    if (window[pendingKey]) window[pendingKey].cancelled = true;
    const pending = { cancelled: false };
    window[pendingKey] = pending;
    const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
    const allowed = ${JSON.stringify(allowedCapabilities)};
    try {
    do {
      if (pending.cancelled) return;
      let probe;
      try {
        probe = (${normalizeRendererContractProbe.toString()})(${rendererContractProbeExpression});
      } catch (_) { probe = null; }
      if (probe?.compatible) {
        window.__CODEX_TASKBOARD_COMPATIBILITY_CAPABILITIES__ = {
          fullPanel: allowed.fullPanel === true,
          quotaDisplay: allowed.quotaDisplay === true && probe.capabilities.quotaDisplay,
          taskNavigation: allowed.taskNavigation === true && probe.capabilities.taskNavigation,
        };
        if (!allowed.fullPanel) return;
        ${source}
        return;
      }
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(retryMs)}));
    } while (Date.now() <= deadline);
    } finally {
      if (window[pendingKey] === pending) delete window[pendingKey];
    }
  })()`;
}

async function probeRendererContract(send, {
  timeoutMs = 20_000,
  retryMs = 250,
  now = () => Date.now(),
  wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  const deadline = now() + Math.max(0, timeoutMs);
  let latest = normalizeRendererContractProbe(null);
  do {
    try {
      const evaluation = await send("Runtime.evaluate", {
        expression: rendererContractProbeExpression,
        returnByValue: true,
      });
      latest = evaluation?.exceptionDetails
        ? {
          compatible: false,
          reason: "probe-evaluation-failed",
          checks: null,
          capabilities: null,
        }
        : normalizeRendererContractProbe(evaluation?.result?.value);
      if (latest.compatible) return latest;
    } catch (_) {
      latest = {
        compatible: false,
        reason: "probe-transport-failed",
        checks: null,
        capabilities: null,
      };
    }
    if (now() >= deadline) return latest;
    await wait(Math.min(retryMs, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return latest;
}

export {
  classifyWindowsCodexCompatibility,
  guardRendererInjectionSource,
  minimumWindowsCodexVersion,
  normalizeRendererContractProbe,
  probeRendererContract,
  rendererContractProbeExpression,
  parseWindowsCodexVersion,
};
