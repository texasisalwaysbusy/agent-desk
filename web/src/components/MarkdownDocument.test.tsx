import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownDocument } from "./MarkdownDocument";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaid }));
vi.mock("../api", () => ({ resolvePersistedAttachmentUrl: (url: string) => url }));

describe("MarkdownDocument", () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = "light";
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
    mermaid.render.mockResolvedValue({
      svg: '<' + 'svg xmlns="http://www.w3.org/2000/svg"><text>safe diagram</text></svg>',
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hides raw and encoded comments without enabling adjacent raw HTML", () => {
    render(<MarkdownDocument value={[
      "<!-- trace-analysis:v1 raw -->",
      "&lt;!-- trace-analysis:v1 encoded --&gt;",
      "&lt;!-- encoded multiline\nmetadata must stay hidden --&gt;",
      "<!-- multiline\nmetadata --><img src=x onerror=alert(1)>",
      "Visible report",
    ].join("\n")} />);

    expect(screen.getByText("Visible report")).toBeTruthy();
    expect(document.body.textContent).not.toContain("trace-analysis");
    expect(document.body.textContent).not.toContain("metadata");
    expect(document.querySelector("img")).toBeNull();
  });

  it("rejects Mermaid image resources before rendering", async () => {
    const sources = [
      'flowchart LR\n  A@{ img: "https://tracker.invalid/pixel.png" }',
      'sequenceDiagram\n  actor A\n  properties A: {"icon":"https://tracker.invalid/icon.png"}',
      'C4Context\n  Person(A, "User", "", "https://tracker.invalid/sprite.png")',
    ];

    for (const source of sources) {
      const view = render(<MarkdownDocument value={`\`\`\`mermaid\n${source}\n\`\`\``} />);
      expect(await screen.findByRole("alert")).toBeTruthy();
      view.unmount();
    }
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("does not reject ordinary Mermaid labels that mention img fields, URLs, or sprite", async () => {
    const sources = [
      'flowchart LR\n  A["missing img: value"] --> B',
      'flowchart LR\n  A["Docs: https://example.invalid/guide"] --> B',
      'flowchart LR\n  A["sprite"] --> B',
    ];

    for (const source of sources) {
      const view = render(<MarkdownDocument value={`\`\`\`mermaid\n${source}\n\`\`\``} />);
      await expect(screen.findByRole("img", { name: "Mermaid diagram" })).resolves.toBeTruthy();
      view.unmount();
    }
    expect(mermaid.render).toHaveBeenCalledTimes(sources.length);
  });

  it("keeps ordinary fenced code as code and does not load Mermaid", async () => {
    render(<MarkdownDocument value={'```js\nconst ready = true;\n```'} />);

    expect(document.querySelector("pre code.language-js")?.textContent).toContain("const ready = true;");
    await Promise.resolve();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("renders Mermaid lazily with strict security and sanitizes hostile SVG", async () => {
    mermaid.render.mockResolvedValue({
      svg: '<' + 'svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject>unsafe</foreignObject><image href="https://tracker.invalid/pixel.png"/><style>@import url(https://tracker.invalid/style.css)</style><style>.node{fill:#fff}</style><text>safe diagram</text></svg>',
    });
    render(<MarkdownDocument value={'```mermaid\ngraph TD; A-->B\n```'} />);

    expect(screen.getByText("Mermaid source")).toBeTruthy();
    const diagram = await screen.findByRole("img", { name: "Mermaid diagram" });
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "default",
    }));
    expect(diagram.innerHTML).toContain("safe diagram");
    expect(diagram.innerHTML).toContain(".node{fill:#fff}");
    expect(diagram.innerHTML).not.toMatch(/script|foreignObject|<image|tracker\.invalid|href=|onload/i);
  });

  it("renders valid Mermaid when Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    render(<MarkdownDocument value={'```mermaid\nflowchart LR; A-->B\n```'} />);

    await expect(screen.findByRole("img", { name: "Mermaid diagram" })).resolves.toBeTruthy();
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.stringMatching(/^taskboard-mermaid-[A-Za-z0-9_-]+$/),
      expect.stringContaining("flowchart LR"),
    );
    expect(document.querySelector('.markdown-mermaid-fallback[role="alert"]')).toBeNull();
  });

  it("rerenders Mermaid for dark mode", async () => {
    render(<MarkdownDocument value={'```mermaid\ngraph TD; A-->B\n```'} />);
    await screen.findByRole("img", { name: "Mermaid diagram" });

    document.documentElement.dataset.theme = "dark";
    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark" }),
    ));
  });

  it("shows readable source when Mermaid rejects malformed input", async () => {
    mermaid.render.mockRejectedValue(new Error("parse failed"));
    const nodesBeforeRender = document.body.childElementCount;
    render(<MarkdownDocument value={'```mermaid\nnot a diagram <script>alert(1)</script>\n```'} />);

    const fallback = await screen.findByRole("alert");
    expect(fallback.textContent).toContain("Unable to render Mermaid diagram");
    expect(fallback.textContent).toContain("not a diagram <script>alert(1)</script>");
    expect(document.querySelector(".markdown-mermaid svg")).toBeNull();
    expect(document.body.childElementCount).toBe(nodesBeforeRender + 1);
  });

  it("uses the readable fallback when sanitization removes the SVG payload", async () => {
    mermaid.render.mockResolvedValue({ svg: "<script>alert(1)</script>" });
    render(<MarkdownDocument value={'```mermaid\ngraph TD; A-->B\n```'} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(document.querySelector('.markdown-mermaid[role="img"]')).toBeNull();
  });
});
