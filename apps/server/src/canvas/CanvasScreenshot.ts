import {
  CANVAS_DEFAULT_ENTRY,
  CanvasError,
  type CanvasName,
  type CanvasSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { CANVAS_BRIDGE_VERSION, type CanvasHostMessage } from "@t3tools/shared/canvas";
import {
  HTML_RENDER_MEASURE_FONTS,
  htmlRenderTheme,
  htmlRenderThemeMessage,
} from "@t3tools/shared/htmlRender";
import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  type ThemeAppearance,
} from "@t3tools/shared/themePalettes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerResponse } from "effect/http";

import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import type { ConsoleMessage } from "../htmlRender/headlessChrome.ts";
import * as CanvasHttp from "./CanvasHttp.ts";
import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";

/** A canvas fills its panel, so a capture is one fixed viewport, not the page's scroll height. */
export const CANVAS_SCREENSHOT_HEIGHT = 900;

// The preview browser reaches no local address, so nothing is ever fetched from this origin: it
// only names the folder while files are read through CanvasHttp and inlined.
const FOLDER_ORIGIN = "http://t3-canvas.localhost";
const THEME_STYLE_MARKER = '<style id="t3-theme">';

export interface CanvasScreenshotResult {
  readonly mimeType: "image/png";
  /** Base64. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly consoleMessages: ReadonlyArray<ConsoleMessage>;
}

export class CanvasScreenshot extends Context.Service<
  CanvasScreenshot,
  {
    /**
     * Renders the canvas as its panel shows it: the entry page with the runtime and kit, the
     * current state delivered over the bridge, and the app theme. Fails with `not-found` for a
     * missing canvas and `storage-failed` when the page cannot be rendered.
     */
    readonly capture: (input: {
      readonly threadId: ThreadId;
      readonly name: CanvasName;
      readonly width?: number | undefined;
      readonly appearance?: ThemeAppearance | undefined;
    }) => Effect.Effect<CanvasScreenshotResult, CanvasError>;
  }
>()("t3/canvas/CanvasScreenshot") {}

/** The message the panel answers a page's `ready` with. */
export function canvasInitMessage(snapshot: CanvasSnapshot): CanvasHostMessage {
  return {
    t3canvas: CANVAS_BRIDGE_VERSION,
    type: "init",
    name: snapshot.name,
    title: snapshot.title,
    state: snapshot.state,
    stateRevision: snapshot.stateRevision,
    functions: snapshot.functions,
  };
}

// Plays the panel for one page load: answers the first `ready` with `init` and the theme, and
// repeats the page's reported errors on the console the capture records. Only the first, because
// the frame's window outlives its document and a later `ready` may not be the canvas's.
const HOST_SCRIPT = `(function(){
var config=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(document.getElementById("t3-canvas-host").getAttribute("data-config")),function(c){return c.charCodeAt(0);})));
var frame=document.getElementById("canvas");
var answered=false;
window.addEventListener("message",function(event){
var data=event.data;
if(event.source!==frame.contentWindow||!data||data.t3canvas!==config.init.t3canvas)return;
if(data.type==="ready"){if(answered)return;answered=true;frame.contentWindow.postMessage(config.init,"*");frame.contentWindow.postMessage(config.theme,"*");}
else if(data.type==="log"){if(data.level==="warning")console.warn(String(data.text));else console.error(String(data.text));}
});
frame.srcdoc=config.document;
})();`;

/**
 * A page that hosts the canvas document the way CanvasPanel does. Everything from the canvas is
 * carried as base64, because the preview pipeline scans the page it is given for viewport units
 * and local image paths, and neither rule applies to a canvas.
 */
export function canvasScreenshotHarness(input: {
  /** The entry document as served, with the runtime and kit already injected. */
  readonly document: string;
  readonly snapshot: CanvasSnapshot;
  readonly appearance: ThemeAppearance;
}): string {
  const theme = htmlRenderTheme(
    input.appearance === "light" ? T3_CODE_LIGHT_THEME_COLORS : T3_CODE_DARK_THEME_COLORS,
    input.appearance,
    HTML_RENDER_MEASURE_FONTS,
  );
  const config = Buffer.from(
    JSON.stringify({
      document: input.document,
      init: canvasInitMessage(input.snapshot),
      theme: htmlRenderThemeMessage(theme),
    }),
    "utf8",
  ).toString("base64");
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    // A parent's `frame-src` governs every navigation of its frames. `srcdoc` is not a fetch, so
    // the canvas document still loads, and nothing it navigates to does.
    `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'">`,
    `<style>html{height:${CANVAS_SCREENSHOT_HEIGHT}px;padding:0;overflow:hidden}body{height:100%}iframe{display:block;border:0;width:100%;height:100%;color-scheme:${input.appearance}}</style>`,
    "</head><body>",
    '<iframe id="canvas" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>',
    `<script id="t3-canvas-host" data-config="${config}">${HOST_SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

const REFERENCING_TAG = /<(script|link|img|source|video|audio)\b[^>]*>/gi;
const URL_ATTRIBUTE = /\s(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/dgi;

interface PageReference {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

const findPageReferences = (html: string): ReadonlyArray<PageReference> =>
  Array.from(html.matchAll(REFERENCING_TAG)).flatMap((tag) => {
    const wanted = tag[1]!.toLowerCase() === "link" ? "href" : "src";
    return Array.from(tag[0].matchAll(URL_ATTRIBUTE)).flatMap((attribute) => {
      const group = [2, 3, 4].find((index) => attribute[index] !== undefined);
      const span = group === undefined ? undefined : attribute.indices?.[group];
      if (span === undefined || attribute[1]!.toLowerCase() !== wanted) return [];
      const start = tag.index + span[0];
      const end = tag.index + span[1];
      return [{ start, end, value: html.slice(start, end) }];
    });
  });

// A meta policy cannot carry `sandbox`; the frame's own attribute sandboxes the page.
const inlinedPolicy = (policy: string, folderSource: string) =>
  policy
    .replaceAll(folderSource, "data:")
    .split("; ")
    .filter((directive) => !directive.startsWith("sandbox"))
    .join("; ");

const withPolicy = (document: string, policy: string | null, folderSource: string) => {
  const at = document.indexOf(THEME_STYLE_MARKER);
  if (policy === null || at === -1) return document;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${inlinedPolicy(policy, folderSource).replaceAll('"', "&quot;")}">`;
  return `${document.slice(0, at)}${meta}${document.slice(at)}`;
};

const make = Effect.gen(function* () {
  const canvasService = yield* CanvasService.CanvasService;
  const store = yield* CanvasStore.CanvasStore;
  const canvasHttp = yield* CanvasHttp.CanvasHttp;
  const htmlRender = yield* HtmlRender.HtmlRender;

  const read = Effect.fn("CanvasScreenshot.read")(function* (pathname: string) {
    const response = HttpServerResponse.toWeb(yield* canvasHttp.respond({ pathname }));
    if (response.status !== 200) return null;
    const bytes = yield* Effect.promise(() => response.arrayBuffer());
    return { bytes: Buffer.from(bytes), headers: response.headers };
  });

  const capture: CanvasScreenshot["Service"]["capture"] = Effect.fn("CanvasScreenshot.capture")(
    function* (input) {
      const target = { threadId: input.threadId, name: input.name };
      const { snapshot } = yield* canvasService.get(target);
      const folder = yield* store.get(target);
      const minted = yield* canvasHttp.mintUrl({ ...target, origin: FOLDER_ORIGIN });
      const folderPath = minted.url.slice(0, -CanvasHttp.CANVAS_WRAPPER_PATH.length);
      const entry = folder.manifest?.entry ?? CANVAS_DEFAULT_ENTRY;
      const entryUrl = new URL(
        `${folderPath}${entry.split("/").map(encodeURIComponent).join("/")}`,
        FOLDER_ORIGIN,
      );

      const page = yield* read(entryUrl.pathname);
      if (page === null) {
        return yield* new CanvasError({
          reason: "storage-failed",
          canvas: input.name,
          detail: "The canvas entry page could not be read.",
        });
      }
      const html = page.bytes.toString("utf8");

      // The folder is not reachable from the preview browser, so files the page names are inlined.
      const files = new Map<string, string | null>();
      const parts: Array<string> = [];
      let cursor = 0;
      for (const reference of findPageReferences(html)) {
        if (!URL.canParse(reference.value, entryUrl.href)) continue;
        const { origin, pathname } = new URL(reference.value, entryUrl);
        if (
          origin !== FOLDER_ORIGIN ||
          !pathname.startsWith(folderPath) ||
          pathname === entryUrl.pathname
        ) {
          continue;
        }
        if (!files.has(pathname)) {
          const file = yield* read(pathname);
          const contentType = (
            file?.headers.get("content-type") ?? "application/octet-stream"
          ).replaceAll(" ", "");
          files.set(
            pathname,
            file === null ? null : `data:${contentType};base64,${file.bytes.toString("base64")}`,
          );
        }
        const dataUri = files.get(pathname);
        if (dataUri === null || dataUri === undefined) continue;
        parts.push(html.slice(cursor, reference.start), dataUri);
        cursor = reference.end;
      }
      parts.push(html.slice(cursor));

      const preview = yield* htmlRender
        .preview({
          html: canvasScreenshotHarness({
            document: withPolicy(
              parts.join(""),
              page.headers.get("content-security-policy"),
              `${FOLDER_ORIGIN}${folderPath}`,
            ),
            snapshot,
            appearance: input.appearance ?? "dark",
          }),
          width: input.width,
          appearance: input.appearance,
        })
        .pipe(
          Effect.mapError(
            (cause) => new CanvasError({ reason: "storage-failed", canvas: input.name, cause }),
          ),
        );
      return {
        mimeType: "image/png",
        data: preview.png,
        width: preview.width,
        height: preview.capturedHeight,
        consoleMessages: preview.consoleMessages,
      };
    },
  );

  return CanvasScreenshot.of({ capture });
});

export const layer = Layer.effect(CanvasScreenshot, make);
