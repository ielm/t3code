import { type CanvasError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CanvasToolkit } from "./tools.ts";

const CALLER_ERRORS: ReadonlySet<CanvasError["reason"]> = new Set([
  "not-found",
  "too-many-canvases",
  "invalid-path",
  "state-too-large",
]);

const toFailure = (error: CanvasError) =>
  new OrchestratorMcpFailure({
    code: CALLER_ERRORS.has(error.reason) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const callerThreadId = Effect.fn("CanvasToolkit.callerThreadId")(function* (operation: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
  return thread.threadId;
});

const handlers = {
  canvas_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("canvas_open");
      const canvases = yield* CanvasService.CanvasService;
      const { snapshot, path } = yield* canvases
        .open({ ...input, threadId })
        .pipe(Effect.mapError(toFailure));
      return {
        name: snapshot.name,
        path,
        pageRevision: snapshot.pageRevision,
        stateRevision: snapshot.stateRevision,
      };
    }),
  ),
  canvas_state: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("canvas_state");
      const canvases = yield* CanvasService.CanvasService;
      const { stateRevision } = yield* canvases
        .patchState({ ...input, threadId })
        .pipe(Effect.mapError(toFailure));
      return { stateRevision };
    }),
  ),
  canvas_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("canvas_close");
      const canvases = yield* CanvasService.CanvasService;
      yield* canvases.close({ ...input, threadId }).pipe(Effect.mapError(toFailure));
      return {};
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CanvasToolkit.tools>;

export const layer = McpToolAccess.toLayer(CanvasToolkit, handlers);
