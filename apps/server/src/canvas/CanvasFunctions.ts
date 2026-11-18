import type { CanvasError, CanvasFunctionName } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CanvasTarget } from "./CanvasStore.ts";

/** Runs the functions a canvas declares in `canvas.json`. Nothing undeclared ever runs. */
export class CanvasFunctions extends Context.Service<
  CanvasFunctions,
  {
    /**
     * Resolves with the function's stdout, parsed as JSON when it parses and returned as a string
     * otherwise. A `change` function fails with `function-needs-gesture` unless `gesture` is true.
     */
    readonly call: (
      input: CanvasTarget & {
        readonly function: CanvasFunctionName;
        readonly args?: unknown;
        readonly gesture: boolean;
      },
    ) => Effect.Effect<unknown, CanvasError>;
  }
>()("t3/canvas/CanvasFunctions") {}
