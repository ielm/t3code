import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CanvasError,
  type CanvasManifest,
  type CanvasSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as PayloadSigner from "../auth/PayloadSigner.ts";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import { HtmlRenderBrowserError } from "../htmlRender/headlessChrome.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as CanvasHttp from "./CanvasHttp.ts";
import * as CanvasScreenshot from "./CanvasScreenshot.ts";
import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";

const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";

const threadId = ThreadId.make("thread:canvas-screenshot");
const name = "board";
const unused = () => Effect.die("unused by CanvasScreenshot");

const snapshot: CanvasSnapshot = {
  threadId,
  name,
  title: "Board",
  pageRevision: 2,
  stateRevision: 5,
  state: { count: 3, note: '</script><style>p{height:100vh}</style>"/tmp/shot.png"' },
  functions: [{ name: "refresh", kind: "read" }],
  revealId: "reveal-1",
};

const APP_JS = 'window.fromPart = "part";';
const STYLE_CSS = "main{color:red}";
const PAGE = [
  "<!doctype html><html><head><title>Board</title>",
  '<link rel="stylesheet" href="parts/style.css">',
  "<style>main{min-height:100vh}</style>",
  '<script src="./parts/app.js?v=1"></script>',
  "<script src=parts/missing.js></script>",
  '<script src="https://cdn.example.test/chart.js"></script>',
  "</head><body><main></main><script>",
  "canvas.ready.then(function () {",
  '  console.error("state " + JSON.stringify(canvas.state.count) + " " + window.fromPart + " " + innerWidth + "x" + innerHeight);',
  "});",
  "</script></body></html>",
].join("");

const layerTest = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const decodeBase64 = (value: string) => Buffer.from(value, "base64").toString("utf8");

const readHarness = (html: string) => {
  const host = /<script id="t3-canvas-host" data-config="([^"]*)">([\s\S]*?)<\/script>/.exec(html);
  if (host === null) throw new Error("The harness has no host script.");
  return {
    script: host[2]!,
    encodedConfig: host[1]!,
    config: JSON.parse(decodeBase64(host[1]!)) as {
      readonly document: string;
      readonly init: unknown;
      readonly theme: { readonly params: { readonly theme: string } };
    },
  };
};

const fakePreview = (
  preview: HtmlRender.HtmlRender["Service"]["preview"],
): Layer.Layer<HtmlRender.HtmlRender> =>
  Layer.succeed(
    HtmlRender.HtmlRender,
    HtmlRender.HtmlRender.of({ prepare: unused, publish: unused, preview }),
  );

const setup = Effect.fn("setup")(function* (
  htmlRender: Layer.Layer<HtmlRender.HtmlRender, PlatformError.PlatformError>,
  options: {
    readonly manifest?: CanvasManifest;
    readonly files?: Readonly<Record<string, string>>;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  const canvasDir = path.join(root, name);
  yield* fileSystem.makeDirectory(path.join(canvasDir, "parts"), { recursive: true });
  const files = {
    "parts/app.js": APP_JS,
    "parts/style.css": STYLE_CSS,
    ...(options.files ?? { "index.html": PAGE }),
  };
  for (const [file, content] of Object.entries(files)) {
    yield* fileSystem.writeFileString(path.join(canvasDir, file), content);
  }

  const missing = new CanvasError({ reason: "not-found", canvas: "other" });
  const folder: CanvasStore.CanvasFolder = {
    threadId,
    name,
    path: canvasDir,
    manifest: options.manifest ?? null,
    manifestIssue: null,
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      AssetSigner.AssetSigner,
      yield* PayloadSigner.fromSecret(new Uint8Array(32).fill(7)),
    ),
    Layer.succeed(
      CanvasStore.CanvasStore,
      CanvasStore.CanvasStore.of({
        ensure: unused,
        get: (target) => (target.name === name ? Effect.succeed(folder) : Effect.fail(missing)),
        list: unused,
        changes: () => Stream.die("unused by CanvasScreenshot"),
        resolveFile: (input) => {
          const resolved = path.resolve(canvasDir, input.path);
          return resolved.startsWith(`${canvasDir}${path.sep}`)
            ? Effect.succeed(resolved)
            : Effect.fail(new CanvasError({ reason: "invalid-path", canvas: input.name }));
        },
        readState: unused,
        writeState: unused,
        remove: unused,
        removeThread: unused,
      }),
    ),
  );
  const canvasService = Layer.succeed(
    CanvasService.CanvasService,
    CanvasService.CanvasService.of({
      open: unused,
      close: unused,
      get: (target) =>
        target.name === name ? Effect.succeed({ snapshot, path: canvasDir }) : Effect.fail(missing),
      patchState: unused,
      stream: () => Stream.die("unused by CanvasScreenshot"),
      submitEvent: unused,
      waitForEvent: unused,
      recentEvents: unused,
    }),
  );
  return yield* Effect.service(CanvasScreenshot.CanvasScreenshot).pipe(
    Effect.provide(
      CanvasScreenshot.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            CanvasHttp.layer.pipe(Layer.provide(dependencies)),
            dependencies,
            canvasService,
            htmlRender,
          ),
        ),
      ),
    ),
  );
});

describe("CanvasScreenshot", () => {
  it("builds a harness that answers the page's ready with init and the theme", () => {
    const document = "<!doctype html><style>main{height:100vh}</style><img src='/tmp/shot.png'>";
    const harness = CanvasScreenshot.canvasScreenshotHarness({
      document,
      snapshot,
      appearance: "light",
    });
    // The preview pipeline rejects viewport units and inlines quoted image paths it can read.
    expect(harness).not.toContain("100vh");
    expect(harness).not.toContain("/tmp/shot.png");
    expect(harness).toContain(`html{height:${CanvasScreenshot.CANVAS_SCREENSHOT_HEIGHT}px;`);
    expect(harness).toContain('<iframe id="canvas" sandbox="allow-scripts"');

    const { script, encodedConfig, config } = readHarness(harness);
    expect(config.init).toEqual(CanvasScreenshot.canvasInitMessage(snapshot));
    expect(config.init).toEqual({
      t3canvas: 1,
      type: "init",
      name,
      title: "Board",
      state: snapshot.state,
      stateRevision: 5,
      functions: snapshot.functions,
    });
    expect(config.theme.params.theme).toBe("light");

    const posted: Array<unknown> = [];
    const logged: Array<readonly [string, string]> = [];
    const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
    const frame = {
      srcdoc: "",
      contentWindow: { postMessage: (message: unknown) => void posted.push(message) },
    };
    new Function("window", "document", "console", script)(
      {
        addEventListener: (_type: string, listener: (typeof listeners)[number]) =>
          void listeners.push(listener),
      },
      {
        getElementById: (id: string) =>
          id === "canvas" ? frame : { getAttribute: () => encodedConfig },
      },
      {
        error: (text: string) => void logged.push(["error", text]),
        warn: (text: string) => void logged.push(["warning", text]),
      },
    );
    const send = (source: unknown, data: unknown) => {
      for (const listener of listeners) listener({ source, data });
    };
    expect(frame.srcdoc).toBe(document);

    send({}, { t3canvas: 1, type: "ready" });
    send(frame.contentWindow, { t3canvas: 2, type: "ready" });
    send(frame.contentWindow, null);
    expect(posted).toEqual([]);

    send(frame.contentWindow, { t3canvas: 1, type: "ready" });
    expect(posted).toEqual([config.init, config.theme]);

    send(frame.contentWindow, { t3canvas: 1, type: "log", level: "error", text: "boom" });
    send(frame.contentWindow, { t3canvas: 1, type: "log", level: "warning", text: "slow down" });
    expect(logged).toEqual([
      ["error", "boom"],
      ["warning", "slow down"],
    ]);
  });

  it.effect("renders the served entry page with its folder files inlined", () =>
    Effect.gen(function* () {
      const previews: Array<Parameters<HtmlRender.HtmlRender["Service"]["preview"]>[0]> = [];
      const screenshot = yield* setup(
        fakePreview((input) =>
          Effect.sync(() => {
            previews.push(input);
            return {
              png: "cG5n",
              width: 500,
              contentHeight: 900,
              capturedHeight: 900,
              consoleMessages: [{ level: "error", text: "boom" }],
            };
          }),
        ),
      );

      expect(
        yield* screenshot.capture({ threadId, name, width: 500, appearance: "light" }),
      ).toEqual({
        mimeType: "image/png",
        data: "cG5n",
        width: 500,
        height: 900,
        consoleMessages: [{ level: "error", text: "boom" }],
      });

      expect(previews).toHaveLength(1);
      const [preview] = previews;
      expect(preview).toMatchObject({ width: 500, appearance: "light" });
      const html = preview !== undefined && "html" in preview ? preview.html : "";
      expect(html).not.toContain("100vh");
      const { config } = readHarness(html);
      expect(config.init).toEqual(CanvasScreenshot.canvasInitMessage(snapshot));
      expect(config.theme.params.theme).toBe("light");

      const page = config.document;
      const base64 = (text: string) => Buffer.from(text).toString("base64");
      expect(page).toContain('<style id="t3-canvas-kit">');
      expect(page).toContain('Object.defineProperty(window, "canvas"');
      expect(page).toContain(
        `<script src="data:text/javascript;charset=utf-8;base64,${base64(APP_JS)}"></script>`,
      );
      expect(page).toContain(
        `<link rel="stylesheet" href="data:text/css;charset=utf-8;base64,${base64(STYLE_CSS)}">`,
      );
      expect(page).toContain("<script src=parts/missing.js></script>");
      expect(page).toContain('<script src="https://cdn.example.test/chart.js"></script>');
      expect(page).toContain("<style>main{min-height:100vh}</style>");

      // The panel's policy, with the folder's files now arriving as data URLs.
      const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page);
      expect(policy?.[1]).toBe(
        "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob: data:; font-src data: data:; media-src data: blob: data:; connect-src data:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      );
      expect(policy?.index).toBeLessThan(page.indexOf('<style id="t3-theme">'));
      expect(policy?.index).toBeLessThan(page.indexOf("<script"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("resolves page references against an entry in a subfolder", () =>
    Effect.gen(function* () {
      const previews: Array<string> = [];
      const screenshot = yield* setup(
        fakePreview((input) =>
          Effect.sync(() => {
            previews.push("html" in input ? input.html : "");
            return {
              png: "cG5n",
              width: 728,
              contentHeight: 900,
              capturedHeight: 900,
              consoleMessages: [],
            };
          }),
        ),
        {
          manifest: { title: "Board", entry: "parts/view.html" },
          files: {
            "parts/view.html":
              '<!doctype html><script src="app.js"></script><img src="../logo.svg"><img src="../../secret.png">',
            "logo.svg": "<svg/>",
          },
        },
      );

      yield* screenshot.capture({ threadId, name });

      const page = readHarness(previews[0] ?? "").config.document;
      const base64 = (text: string) => Buffer.from(text).toString("base64");
      expect(page).toContain(
        `<script src="data:text/javascript;charset=utf-8;base64,${base64(APP_JS)}"></script>`,
      );
      expect(page).toContain(`<img src="data:image/svg+xml;base64,${base64("<svg/>")}">`);
      expect(page).toContain('<img src="../../secret.png">');
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails with not-found for a missing canvas and wraps a render failure", () =>
    Effect.gen(function* () {
      const cause = new HtmlRenderBrowserError({ reason: "the browser could not be started" });
      const screenshot = yield* setup(fakePreview(() => Effect.fail(cause)));

      const missing = yield* screenshot.capture({ threadId, name: "other" }).pipe(Effect.flip);
      expect(missing).toBeInstanceOf(CanvasError);
      expect(missing.reason).toBe("not-found");

      const failed = yield* screenshot.capture({ threadId, name }).pipe(Effect.flip);
      expect(failed).toMatchObject({ reason: "storage-failed", canvas: name });
      expect(failed.cause).toBe(cause);

      const previews: Array<unknown> = [];
      const withoutEntry = yield* setup(
        fakePreview((input) => Effect.sync(() => previews.push(input)).pipe(Effect.andThen(cause))),
        { files: {} },
      );
      const unreadable = yield* withoutEntry.capture({ threadId, name }).pipe(Effect.flip);
      expect(unreadable).toMatchObject({ reason: "storage-failed", canvas: name });
      expect(unreadable.cause).toBeUndefined();
      expect(previews).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("captures the page at the panel size once the bridge has delivered its state", (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
      if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
      const htmlRender = HtmlRender.layer.pipe(
        Layer.provide(
          Layer.succeed(
            PreviewBrowser.PreviewBrowser,
            PreviewBrowser.PreviewBrowser.of({
              executable: Effect.succeed(executable),
              installed: Effect.succeedSome(executable),
            }),
          ),
        ),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-canvas-screenshot-" })),
        Layer.provide(NodeServices.layer),
      );
      const screenshot = yield* setup(htmlRender);

      const result = yield* screenshot.capture({ threadId, name });

      expect(result).toMatchObject({
        mimeType: "image/png",
        width: 728,
        height: CanvasScreenshot.CANVAS_SCREENSHOT_HEIGHT,
      });
      expect(Buffer.from(result.data, "base64").subarray(1, 4).toString("latin1")).toBe("PNG");
      expect(result.consoleMessages).toContainEqual({
        level: "error",
        text: `state 3 part 728x${CanvasScreenshot.CANVAS_SCREENSHOT_HEIGHT}`,
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
