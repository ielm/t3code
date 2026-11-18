import * as NodeVM from "node:vm";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  applyCanvasStatePatch,
  CANVAS_BRIDGE_VERSION,
  CANVAS_LOG_ENTRY_MAX_LENGTH,
  decodeCanvasPageMessage,
  type CanvasHostMessage,
} from "./canvas.ts";
import { CANVAS_KIT_CSS, CANVAS_RUNTIME_SCRIPT, injectCanvasBootstrap } from "./canvasRuntime.ts";
import {
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderLinkRequest,
} from "./htmlRender.ts";
import { T3_CODE_LIGHT_THEME_COLORS } from "./themePalettes.ts";

interface PageCanvas {
  readonly state: Record<string, unknown>;
  readonly name: string;
  readonly title: string;
  readonly functions: ReadonlyArray<{ name: string; kind: string }>;
  readonly ready: PromiseLike<void>;
  onState(listener: (state: Record<string, unknown>) => void): () => void;
  setState(patch: unknown): void;
  send(event: string, payload?: unknown): void;
  call(name: string, args?: unknown): PromiseLike<unknown>;
}

type Listener = (event: Record<string, unknown>) => void;

const PAGE_URL = "https://env.test/api/canvas/token/index.html?v=1";

function boot(options: { readonly hash?: string } = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const parent = {
    postMessage: (message: unknown, targetOrigin: string) => {
      expect(targetOrigin).toBe("*");
      posted.push(structuredClone(message) as Record<string, unknown>);
    },
  };
  const listeners = new Map<string, Array<Listener>>();
  const clickListeners: Array<Listener> = [];
  const themeStyle = { textContent: "" };
  const consoleErrors: Array<ReadonlyArray<unknown>> = [];
  const replacedUrls: Array<string> = [];
  const clock = { now: 0 };
  const pageConsole = {
    error: (...args: ReadonlyArray<unknown>) => {
      consoleErrors.push(args);
    },
  };
  const window: { parent: object; addEventListener: unknown; canvas?: PageCanvas } = {
    parent,
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  NodeVM.runInNewContext(CANVAS_RUNTIME_SCRIPT, {
    window,
    document: {
      baseURI: PAGE_URL,
      getElementById: (id: string) => (id === "t3-theme" ? themeStyle : null),
      addEventListener: (type: string, listener: Listener, capture: boolean) => {
        expect([type, capture]).toEqual(["click", true]);
        clickListeners.push(listener);
      },
    },
    location: {
      href: PAGE_URL,
      hash: options.hash ?? "",
      pathname: "/canvas/index.html",
      search: "?v=1",
    },
    URL,
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: string) => replacedUrls.push(url),
    },
    console: pageConsole,
    Date: { now: () => clock.now },
  });
  const dispatch = (type: string, event: Record<string, unknown>) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    canvas: window.canvas!,
    posted,
    themeStyle,
    consoleErrors,
    pageConsole,
    replacedUrls,
    clock,
    dispatch,
    /** Clicks a child of a link with this `href`, or of no link when it is `null`. */
    click: (href: string | null, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) => {
      let prevented = false;
      const element = (selector: string | null) => ({
        matches: (query: string) => query === selector,
        getAttribute: () => href,
      });
      const event = {
        ...modifiers,
        composedPath: () => [element(null), element(href === null ? null : "a[href]"), {}],
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const listener of clickListeners) listener(event);
      return { prevented };
    },
    host: (data: CanvasHostMessage | object, source: object = parent) =>
      dispatch("message", { source, data }),
    init: (state: Record<string, unknown> = {}) =>
      dispatch("message", {
        source: parent,
        data: {
          t3canvas: CANVAS_BRIDGE_VERSION,
          type: "init",
          name: "board",
          title: "Board",
          state,
          stateRevision: 1,
          functions: [{ name: "listFiles", kind: "read" }],
        } satisfies CanvasHostMessage,
      }),
    postedOfType: (type: string) => posted.filter((message) => message.type === type),
  };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("CANVAS_RUNTIME_SCRIPT", () => {
  it("posts ready once and only messages the panel can decode", () => {
    const page = boot();
    page.init();
    page.canvas.setState({ a: 1 });
    page.canvas.send("picked", { id: 3 });
    page.canvas.send("refresh");
    void page.canvas.call("listFiles", { dir: "." });
    void page.canvas.call("listFiles");
    page.dispatch("error", { message: "boom", filename: "index.html", lineno: 4 });

    expect(page.posted.map((message) => message.type)).toEqual([
      "ready",
      "setState",
      "event",
      "event",
      "call",
      "call",
      "log",
    ]);
    for (const message of page.posted) {
      expect(Option.isSome(decodeCanvasPageMessage(message)), JSON.stringify(message)).toBe(true);
    }
    expect(page.postedOfType("event")).toEqual([
      { t3canvas: 1, type: "event", event: "picked", payload: { id: 3 } },
      { t3canvas: 1, type: "event", event: "refresh" },
    ]);
    const [first, second] = page.postedOfType("call");
    expect(first).toMatchObject({ function: "listFiles", args: { dir: "." } });
    expect(second).not.toHaveProperty("args");
    expect(first?.id).not.toBe(second?.id);
  });

  it("exposes init to the page, resolves ready and delivers state to listeners", async () => {
    const page = boot();
    const early: Array<unknown> = [];
    page.canvas.onState((state) => early.push(plain(state)));
    expect(early).toEqual([]);

    page.init({ count: 1 });
    await page.canvas.ready;

    expect(page.canvas.name).toBe("board");
    expect(page.canvas.title).toBe("Board");
    expect(plain(page.canvas.functions)).toEqual([{ name: "listFiles", kind: "read" }]);
    expect(plain(page.canvas.state)).toEqual({ count: 1 });
    expect(early).toEqual([{ count: 1 }]);

    const late: Array<unknown> = [];
    const unsubscribe = page.canvas.onState((state) => late.push(plain(state)));
    expect(late).toEqual([{ count: 1 }]);

    unsubscribe();
    page.host({ t3canvas: 1, type: "state", state: { count: 2 }, stateRevision: 2 });
    expect(late).toEqual([{ count: 1 }]);
    expect(early).toEqual([{ count: 1 }, { count: 2 }]);
  });

  it("applies setState locally as a merge patch, then lets the host's state replace it", () => {
    const page = boot();
    const initial = { keep: 1, drop: 2, nested: { a: 1, b: 2 }, list: [1, 2], scalar: 5 };
    const patch = { drop: null, nested: { b: null, c: 3 }, list: [9], scalar: { deep: true } };
    page.init(initial);
    const seen: Array<unknown> = [];
    page.canvas.onState((state) => seen.push(plain(state)));

    page.canvas.setState(patch);

    const expected = structuredClone(applyCanvasStatePatch(initial, patch));
    expect(plain(page.canvas.state)).toEqual(expected);
    expect(seen).toEqual([initial, expected]);
    expect(page.postedOfType("setState")).toEqual([{ t3canvas: 1, type: "setState", patch }]);

    patch.list.push(10);
    expect(plain(page.canvas.state)).toEqual(expected);

    page.host({ t3canvas: 1, type: "state", state: { server: true }, stateRevision: 2 });
    expect(plain(page.canvas.state)).toEqual({ server: true });
    expect(seen.at(-1)).toEqual({ server: true });
  });

  it("rejects a patch that is not a JSON object without changing state or posting", () => {
    const page = boot();
    page.init({ a: 1 });
    for (const patch of [[1], "x", null, undefined, 3]) {
      expect(() => page.canvas.setState(patch)).toThrow();
    }
    expect(plain(page.canvas.state)).toEqual({ a: 1 });
    expect(page.postedOfType("setState")).toEqual([]);
  });

  it("keeps notifying other listeners when one throws", () => {
    const page = boot();
    const seen: Array<unknown> = [];
    page.canvas.onState(() => {
      throw new Error("listener broke");
    });
    page.canvas.onState((state) => seen.push(plain(state)));
    page.init({ a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
    expect(page.postedOfType("log")).toHaveLength(1);
  });

  it("settles each call from its own callResult", async () => {
    const page = boot();
    const ok = page.canvas.call("listFiles");
    const failed = page.canvas.call("deploy", { env: "prod" });
    const [okCall, failedCall] = page.postedOfType("call");

    page.host({ t3canvas: 1, type: "callResult", id: "unknown", ok: true, value: "stray" });
    page.host({
      t3canvas: 1,
      type: "callResult",
      id: String(failedCall?.id),
      ok: false,
      reason: "function-needs-gesture",
      message: "That function changes things, so it only runs from a click or key press.",
    });
    page.host({
      t3canvas: 1,
      type: "callResult",
      id: String(okCall?.id),
      ok: true,
      value: { files: ["a.ts"] },
    });

    expect(plain(await ok)).toEqual({ files: ["a.ts"] });
    const failure = await Promise.resolve(failed).then(
      () => undefined,
      (error: Error & { reason?: string }) => error,
    );
    expect(failure?.reason).toBe("function-needs-gesture");
    expect(failure?.message).toBe(
      "That function changes things, so it only runs from a click or key press.",
    );
  });

  it("ignores messages that do not come from the parent window", async () => {
    const page = boot();
    const stranger = {};
    const seen: Array<unknown> = [];
    page.canvas.onState((state) => seen.push(plain(state)));
    const call = page.canvas.call("listFiles");
    const callId = String(page.postedOfType("call")[0]?.id);
    const light = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");

    page.host(
      {
        t3canvas: 1,
        type: "init",
        name: "evil",
        title: "Evil",
        state: { hijacked: true },
        stateRevision: 9,
        functions: [],
      },
      stranger,
    );
    page.host(
      { t3canvas: 1, type: "state", state: { hijacked: true }, stateRevision: 9 },
      stranger,
    );
    page.host({ t3canvas: 1, type: "callResult", id: callId, ok: true, value: "forged" }, stranger);
    page.host(htmlRenderThemeMessage(light), stranger);

    expect(page.canvas.name).toBe("");
    expect(plain(page.canvas.state)).toEqual({});
    expect(seen).toEqual([]);
    expect(page.themeStyle.textContent).toBe("");

    page.host({ t3canvas: 1, type: "callResult", id: callId, ok: true, value: "real" });
    expect(await call).toBe("real");
  });

  it("ignores canvas traffic from another bridge version", () => {
    const page = boot();
    page.host({ t3canvas: 2, type: "state", state: { future: true }, stateRevision: 1 });
    page.host({ type: "state", state: { unmarked: true }, stateRevision: 1 });
    expect(plain(page.canvas.state)).toEqual({});
  });

  it("forwards console errors, uncaught errors and rejections, truncated", () => {
    const page = boot();
    const logs = () => page.postedOfType("log");

    page.pageConsole.error("failed", { code: 7 });
    page.dispatch("error", { message: "x is not defined", filename: "app.js", lineno: 12 });
    page.dispatch("unhandledrejection", { reason: "nope" });
    page.dispatch("error", { message: "y".repeat(CANVAS_LOG_ENTRY_MAX_LENGTH * 2) });

    expect(page.consoleErrors).toHaveLength(1);
    expect(logs().map((entry) => entry.text)).toEqual([
      'failed {"code":7}',
      "x is not defined (app.js:12)",
      "Unhandled rejection: nope",
      "y".repeat(CANVAS_LOG_ENTRY_MAX_LENGTH),
    ]);
    expect(logs().every((entry) => entry.level === "error")).toBe(true);
  });

  it("stops forwarding a flood of errors until the window passes", () => {
    const page = boot();
    const logs = () => page.postedOfType("log");
    const flood = () => {
      for (let index = 0; index < 500; index += 1) page.dispatch("error", { message: "loop" });
    };

    flood();
    const firstBurst = logs();
    expect(firstBurst.length).toBeLessThan(50);
    expect(firstBurst.at(-1)).toMatchObject({ level: "warning" });
    expect(firstBurst.filter((entry) => entry.level === "warning")).toHaveLength(1);

    page.clock.now += 5_000;
    flood();
    expect(logs()).toHaveLength(firstBurst.length);

    page.clock.now += 5_000;
    page.dispatch("error", { message: "later" });
    expect(logs().at(-1)).toMatchObject({ level: "error", text: "later" });
  });

  it("takes the theme from the URL fragment and from the panel's existing theme message", () => {
    const light = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");
    const page = boot({ hash: htmlRenderThemeFragment(light) });

    expect(page.themeStyle.textContent).toContain(":root{color-scheme:light;");
    expect(page.themeStyle.textContent).toContain(
      `--background:${light.variables["--background"]};`,
    );
    expect(page.replacedUrls).toEqual(["/canvas/index.html?v=1"]);

    page.host(
      htmlRenderThemeMessage({
        appearance: "dark",
        variables: { "--background": "#000;}body{display:none", "bad name": "x" },
      }),
    );
    expect(page.themeStyle.textContent).toBe(
      ":root{color-scheme:dark;--background:#000bodydisplay:none;}",
    );
  });

  it("asks the panel to open http and https links instead of navigating", () => {
    const page = boot();
    page.posted.length = 0;

    expect(page.click("https://example.com/docs?q=1#top", { metaKey: true })).toEqual({
      prevented: true,
    });
    expect(page.click("//cdn.example.com/x")).toEqual({ prevented: true });

    expect(page.posted.map(readHtmlRenderLinkRequest)).toEqual([
      { id: "t3-link-1", url: "https://example.com/docs?q=1#top", metaKey: true, ctrlKey: false },
      { id: "t3-link-2", url: "https://cdn.example.com/x", metaKey: false, ctrlKey: false },
    ]);
  });

  it.each([
    ["a fragment of this page", "#section", false],
    ["an empty fragment", "#", false],
    ["this page's own URL with a fragment", `${PAGE_URL}#section`, false],
    ["a javascript: URL", "javascript:void(0)", false],
    ["an address that does not parse", "https://[", false],
    ["this page without a fragment", "", true],
    ["a mailto: address", "mailto:someone@example.com", true],
    ["a file: path", "file:///etc/hosts", true],
  ])("posts nothing for %s", (_name, href, prevented) => {
    const page = boot();
    page.posted.length = 0;

    expect(page.click(href)).toEqual({ prevented });
    expect(page.posted).toEqual([]);
  });

  it("leaves clicks outside a link alone", () => {
    const page = boot();
    page.posted.length = 0;

    expect(page.click(null)).toEqual({ prevented: false });
    expect(page.posted).toEqual([]);
  });
});

describe("injectCanvasBootstrap", () => {
  const scriptTag = `<script>${CANVAS_RUNTIME_SCRIPT}</script>`;
  const kitTag = `<style id="t3-canvas-kit">${CANVAS_KIT_CSS}</style>`;

  it("cannot be closed early by its own contents", () => {
    expect(CANVAS_RUNTIME_SCRIPT).not.toMatch(/<\/script/i);
    expect(CANVAS_KIT_CSS).not.toMatch(/<\/style/i);
  });

  it("inserts at the start of an existing head, before the page's own scripts", () => {
    const html =
      '<!DOCTYPE html>\n<!-- <head> in a comment -->\n<html lang="en">\n<head data-x=">">\n<script>page()</script></head><body><p>hi</p></body></html>';
    const injected = injectCanvasBootstrap(html);
    const headEnd = html.indexOf('<head data-x=">">') + '<head data-x=">">'.length;

    expect(injected.slice(0, headEnd)).toBe(html.slice(0, headEnd));
    expect(injected.endsWith(html.slice(headEnd))).toBe(true);
    expect(injected.slice(headEnd).startsWith("<meta charset")).toBe(true);
    expect(injected.match(/<head[\s>]/g)).toHaveLength(2);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(kitTag));
    expect(injected.indexOf(kitTag)).toBeLessThan(injected.indexOf(scriptTag));
    expect(injected.indexOf(scriptTag)).toBeLessThan(injected.indexOf("page()"));
  });

  it.each([
    [
      "an html element",
      '<!doctype html><html class="x"><body><script>page()</script></body></html>',
      '<!doctype html><html class="x">',
    ],
    ["only a doctype", "<!doctype html><script>page()</script><p>hi</p>", "<!doctype html>"],
    ["no document structure", "<script>page()</script><p>hi</p>", "<!doctype html>"],
    [
      "a head tag that is only text in the body",
      "<!doctype html><p>hi</p><script>var s = '<head>'; page()</script>",
      "<!doctype html>",
    ],
  ])("creates a head when the document has %s", (_name, html, prefix) => {
    const injected = injectCanvasBootstrap(html);
    expect(injected.startsWith(`${prefix}<head><meta charset="utf-8">`)).toBe(true);
    expect(injected.indexOf(`${scriptTag}</head>`)).toBeGreaterThan(0);
    expect(injected.indexOf(scriptTag)).toBeLessThan(injected.indexOf("page()"));
    const rest = html.startsWith(prefix) ? html.slice(prefix.length) : html;
    expect(injected.endsWith(`</head>${rest}`)).toBe(true);
  });

  it("keeps the page's own charset and viewport", () => {
    const injected = injectCanvasBootstrap(
      '<head><meta charset="utf-8"><meta name="viewport" content="width=600"></head>',
    );
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/viewport/g)).toHaveLength(1);
  });

  it("ships default light and dark variables that the kit sheet reads", () => {
    const injected = injectCanvasBootstrap("<p>hi</p>");
    expect(injected).toContain(":root{color-scheme:dark;");
    expect(injected).toContain("@media (prefers-color-scheme: light){:root{color-scheme:light;");
    const defined = new Set(injected.match(/--[a-z0-9-]+(?=:)/g));
    const used = new Set(
      [...CANVAS_KIT_CSS.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]),
    );
    expect([...used].filter((name) => !defined.has(name!))).toEqual([]);
  });
});
