import * as Layer from "effect/Layer";

import * as CanvasFunctions from "./CanvasFunctions.ts";
import * as CanvasHttp from "./CanvasHttp.ts";
import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadCleanup from "./CanvasThreadCleanup.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

/**
 * Every canvas service, composed once. Layers memoize by reference, so providing this one value
 * gives the WebSocket handlers, the HTTP route and the MCP toolkit the same instances.
 */
export const layer = Layer.mergeAll(
  CanvasFunctions.layer,
  CanvasHttp.layer,
  CanvasThreadCleanup.layer,
).pipe(
  Layer.provideMerge(CanvasService.layer),
  Layer.provide(Layer.merge(CanvasStore.layer, CanvasThreadPort.layer)),
);
