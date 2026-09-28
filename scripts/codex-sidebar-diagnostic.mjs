// Source-candidate-only, read-only snapshot. This is not an injection contract.
const sidebarDiagnosticExpression = String.raw`(() => {
  const max = (value, limit) => Math.min(value, limit);
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return !node.closest('[inert], [aria-hidden="true"]')
      && style.display !== "none" && style.visibility !== "hidden"
      && rect.width >= 160 && rect.height >= 180;
  };
  const tags = ["ASIDE", "NAV", "DIV", "SECTION", "BUTTON", "A", "SPAN", "UL", "LI"];
  const roles = ["navigation", "button", "link", "list", "listitem", "menu", "menuitem", "tab", "tree", "treeitem"];
  const knownClasses = ["sidebar-item", "overflow-y-auto", "cursor-pointer", "group"];
  const summary = (node) => ({
    tag: tags.includes(node.tagName) ? node.tagName.toLowerCase() : "other",
    role: roles.includes(node.getAttribute("role")) ? node.getAttribute("role") : null,
    tabIndex: node.hasAttribute("tabindex"),
    href: node.hasAttribute("href"),
    ariaLabel: node.hasAttribute("aria-label"),
    children: max(node.children.length, 100),
    classes: knownClasses.filter((name) => node.classList.contains(name)),
    dataNames: Array.from(node.attributes).map((attr) => attr.name)
      .filter((name) => /^data-app-(?:action-sidebar|shell)-[a-z-]{1,45}$/.test(name))
      .slice(0, 6),
  });
  const asides = Array.from(document.querySelectorAll("aside")).filter(visible).slice(0, 3);
  return {
    schemaVersion: 1,
    appProtocol: location.protocol === "app:",
    topFrame: window.top === window,
    visibleAsideCount: max(Array.from(document.querySelectorAll("aside")).filter(visible).length, 10),
    asides: asides.map((aside) => {
      const navs = Array.from(aside.querySelectorAll("nav")).slice(0, 4);
      const scrolls = Array.from(new Set(Array.from(aside.querySelectorAll(
        '[data-app-action-sidebar-scroll], .overflow-y-auto',
      )))).slice(0, 5);
      const tree = [];
      const queue = [{ node: aside, depth: 0 }];
      while (queue.length && tree.length < 64) {
        const { node, depth } = queue.shift();
        tree.push({ depth, ...summary(node) });
        if (depth < 5) Array.from(node.children).slice(0, 12)
          .forEach((child) => queue.push({ node: child, depth: depth + 1 }));
      }
      const allInteractives = Array.from(aside.querySelectorAll(
        'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex]',
      ));
      const interactives = Array.from(new Set([
        ...allInteractives.slice(0, 24), ...allInteractives.slice(-12),
      ])).slice(0, 36).map((node) => ({
        ...summary(node),
        scroll: scrolls.findIndex((scroll) => scroll.contains(node)),
        nav: navs.findIndex((nav) => nav.contains(node)),
        depth: max((() => {
          let depth = 0;
          for (let parent = node.parentElement; parent && parent !== aside; parent = parent.parentElement) depth++;
          return depth;
        })(), 20),
      }));
      return {
        marker: aside.hasAttribute("data-app-shell-left-panel-appearance"),
        elementCount: max(aside.querySelectorAll("*").length, 1000),
        buttonCount: max(aside.querySelectorAll("button").length, 1000),
        linkCount: max(aside.querySelectorAll("a[href]").length, 1000),
        interactiveCount: max(allInteractives.length, 1000),
        navigationCount: max(aside.querySelectorAll("nav").length, 10),
        scrollCount: max(aside.querySelectorAll(
          '[data-app-action-sidebar-scroll], .overflow-y-auto',
        ).length, 10),
        navs: navs.map((nav) => ({ ...summary(nav), scrolls: scrolls
          .map((scroll, index) => nav.contains(scroll) ? index : -1).filter((index) => index >= 0) })),
        scrolls: scrolls.map((scroll) => ({
          ...summary(scroll),
          legacy: scroll.hasAttribute("data-app-action-sidebar-scroll"),
          buttons: max(scroll.querySelectorAll("button").length, 100),
          links: max(scroll.querySelectorAll("a[href]").length, 100),
          roles: max(scroll.querySelectorAll('[role="button"], [role="link"]').length, 100),
          elements: max(scroll.querySelectorAll("*").length, 1000),
        })),
        tree,
        interactives,
      };
    }),
  };
})()`;

function normalizeSidebarDiagnostic(value) {
  if (value?.schemaVersion !== 1) return null;
  const bounded = (number, ceiling) => Number.isInteger(number)
    && number >= 0 && number <= ceiling ? number : null;
  const node = (item) => {
    if (!item || typeof item !== "object") return null;
    const tag = ["aside", "nav", "div", "section", "button", "a", "span", "ul", "li", "other"]
      .includes(item.tag) ? item.tag : "other";
    const role = ["navigation", "button", "link", "list", "listitem", "menu", "menuitem", "tab", "tree", "treeitem"]
      .includes(item.role) ? item.role : null;
    return {
      tag, role, tabIndex: item.tabIndex === true, href: item.href === true,
      ariaLabel: item.ariaLabel === true, children: bounded(item.children, 100),
      classes: Array.isArray(item.classes) ? Array.from(item.classes).filter((name) =>
        ["sidebar-item", "overflow-y-auto", "cursor-pointer", "group"].includes(name)).slice(0, 4) : [],
      dataNames: Array.isArray(item.dataNames) ? Array.from(item.dataNames).filter((name) =>
        typeof name === "string" && /^data-app-(?:action-sidebar|shell)-[a-z-]{1,45}$/.test(name)).slice(0, 6) : [],
    };
  };
  const nodes = (items, limit, extra) => Array.isArray(items)
    ? Array.from(items).slice(0, limit).map((item) => ({ ...node(item), ...extra(item) })) : [];
  return {
    schemaVersion: 1,
    appProtocol: value.appProtocol === true,
    topFrame: value.topFrame === true,
    visibleAsideCount: bounded(value.visibleAsideCount, 10),
    asides: Array.isArray(value.asides) ? Array.from(value.asides).slice(0, 3).map((aside) => ({
      marker: aside?.marker === true,
      elementCount: bounded(aside?.elementCount, 1000),
      buttonCount: bounded(aside?.buttonCount, 1000),
      linkCount: bounded(aside?.linkCount, 1000),
      interactiveCount: bounded(aside?.interactiveCount, 1000),
      navigationCount: bounded(aside?.navigationCount, 10),
      scrollCount: bounded(aside?.scrollCount, 10),
      navs: nodes(aside?.navs, 4, (item) => ({ scrolls: Array.isArray(item?.scrolls)
        ? Array.from(item.scrolls).filter((index) => bounded(index, 4) !== null).slice(0, 5) : [] })),
      scrolls: nodes(aside?.scrolls, 5, (item) => ({
        legacy: item?.legacy === true,
        buttons: bounded(item?.buttons, 100), links: bounded(item?.links, 100),
        roles: bounded(item?.roles, 100), elements: bounded(item?.elements, 1000),
      })),
      tree: nodes(aside?.tree, 64, (item) => ({ depth: bounded(item?.depth, 5) })),
      interactives: nodes(aside?.interactives, 36, (item) => ({
        scroll: bounded(item?.scroll, 4) ?? -1,
        nav: bounded(item?.nav, 3) ?? -1,
        depth: bounded(item?.depth, 20),
      })),
    })) : [],
  };
}

export { normalizeSidebarDiagnostic, sidebarDiagnosticExpression };
