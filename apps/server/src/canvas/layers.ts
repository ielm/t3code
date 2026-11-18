import * as Layer from "effect/Layer";

import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as CanvasDiagnostics from "./CanvasDiagnostics.ts";
import * as CanvasFunctions from "./CanvasFunctions.ts";
import * as CanvasHttp from "./CanvasHttp.ts";
import * as CanvasLibrary from "./CanvasLibrary.ts";
import * as CanvasScreenshot from "./CanvasScreenshot.ts";
import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadCleanup from "./CanvasThreadCleanup.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

/**
 * Every canvas service, composed once. Layers memoize by reference, so providing this one value
 * gives the WebSocket handlers, the HTTP route and the MCP toolkit the same instances. The same
 * holds for `HtmlRender.layer` and `PreviewBrowser.layer`: the server's routes provide those
 * references again and reuse the instances built here.
 */
export const layer = Layer.mergeAll(
  CanvasDiagnostics.layer,
  CanvasFunctions.layer,
  CanvasScreenshot.layer.pipe(
    Layer.provide(HtmlRender.layer.pipe(Layer.provide(PreviewBrowser.layer))),
  ),
  CanvasThreadCleanup.layer,
).pipe(
  Layer.provideMerge(CanvasHttp.layer),
  Layer.provideMerge(CanvasService.layer),
  Layer.provideMerge(CanvasLibrary.layer),
  Layer.provide(Layer.merge(CanvasStore.layer, CanvasThreadPort.layer)),
);
