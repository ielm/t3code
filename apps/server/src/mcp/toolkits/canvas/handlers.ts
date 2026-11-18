import {
  type CanvasError,
  type CanvasEvent,
  type CanvasName,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CanvasDiagnostics from "../../../canvas/CanvasDiagnostics.ts";
import * as CanvasLibrary from "../../../canvas/CanvasLibrary.ts";
import * as CanvasScreenshot from "../../../canvas/CanvasScreenshot.ts";
import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  CANVAS_FUNCTIONS_BLOCKED_NOTE,
  CANVAS_WAIT_DEFAULT_SECONDS,
  CANVAS_WAIT_MAX_SECONDS,
  CanvasReadToolkit,
  CanvasStandardToolkit,
  CanvasToolkit,
} from "./tools.ts";

const CALLER_ERRORS: ReadonlySet<CanvasError["reason"]> = new Set([
  "not-found",
  "too-many-canvases",
  "invalid-path",
  "state-too-large",
]);

const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const toFailure = (error: CanvasError | CanvasLibrary.CanvasAlreadyExistsError) =>
  error._tag === "CanvasAlreadyExistsError"
    ? invalidRequest(
        error.scope === "thread"
          ? `${error.message} Omit \`from\` to reopen it.`
          : `${error.message} Pass \`overwrite: true\` to replace it.`,
      )
    : new OrchestratorMcpFailure({
        code: CALLER_ERRORS.has(error.reason) ? "invalid_request" : "orchestration_error",
        message: error.message,
      });

const callerThreadId = Effect.fn("CanvasToolkit.callerThreadId")(function* (operation: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
  return thread.threadId;
});

const toUserEvent = ({ id: _id, threadId: _threadId, ...event }: CanvasEvent) => event;

type Capture = CanvasScreenshot.CanvasScreenshot["Service"]["capture"];

/**
 * `capture` is given only where the result's `screenshot` is sent as MCP image content. A
 * registration that serializes results as JSON text would hand the model the PNG as base64.
 */
const canvasRead = (capture: Capture | undefined) =>
  McpToolAccess.readsAsCaller((input: { readonly name?: CanvasName }) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("canvas_read");
      const canvases = yield* CanvasService.CanvasService;
      if (input.name === undefined) {
        const library = yield* CanvasLibrary.CanvasLibrary;
        // The stream opens with every open canvas; nothing else lists them.
        const first = yield* canvases
          .stream(threadId)
          .pipe(Stream.runHead, Effect.mapError(toFailure));
        const open = Option.getOrUndefined(first);
        const saved = yield* library.list({ threadId }).pipe(Effect.mapError(toFailure));
        return {
          canvases: (open?._tag === "snapshot" ? open.canvases : []).map((canvas) => ({
            name: canvas.name,
            title: canvas.title,
            pageRevision: canvas.pageRevision,
            stateRevision: canvas.stateRevision,
          })),
          saved: saved.map(({ path: _path, ...entry }) => entry),
        };
      }
      const target = { threadId, name: input.name };
      const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
      const { snapshot, path } = yield* canvases.get(target).pipe(Effect.mapError(toFailure));
      const events = yield* canvases.recentEvents(target).pipe(Effect.mapError(toFailure));
      const logged = yield* diagnostics.recent(target);
      const screenshot =
        capture === undefined
          ? { screenshotError: "Screenshots are not available here." }
          : yield* capture(target).pipe(
              Effect.map(({ consoleMessages: _consoleMessages, ...image }) => ({
                screenshot: image,
              })),
              Effect.catch((error) =>
                Effect.succeed({ screenshotError: error.detail ?? error.message }),
              ),
            );
      return {
        name: snapshot.name,
        title: snapshot.title,
        path,
        pageRevision: snapshot.pageRevision,
        stateRevision: snapshot.stateRevision,
        state: snapshot.state,
        functions: snapshot.functions,
        ...(snapshot.manifestIssue === undefined ? {} : { manifestIssue: snapshot.manifestIssue }),
        events: events.map(toUserEvent),
        // Entries outlive the page that logged them until a newer page logs something.
        errors: logged.pageRevision === snapshot.pageRevision ? logged.entries : [],
        ...screenshot,
      };
    }),
  );

const standardHandlers = {
  canvas_open: McpToolAccess.actsAsCaller(({ from, ...input }) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("canvas_open");
      const canvases = yield* CanvasService.CanvasService;
      const { snapshot, path } = yield* from === undefined
        ? canvases.open({ ...input, threadId }).pipe(Effect.mapError(toFailure))
        : canvases
            .openFrom({ ...input, threadId, scope: from.scope, name: from.name, as: input.name })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "CanvasError" && error.reason === "not-found"
                  ? invalidRequest(
                      `The ${from.scope} library has no canvas named ${from.name}. \`canvas_read\` lists the saved ones.`,
                    )
                  : toFailure(error),
              ),
            );
      return {
        name: snapshot.name,
        path,
        pageRevision: snapshot.pageRevision,
        stateRevision: snapshot.stateRevision,
        ...(snapshot.functionsBlocked === true
          ? { functionsBlocked: CANVAS_FUNCTIONS_BLOCKED_NOTE }
          : {}),
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
  canvas_wait: McpToolAccess.readsAsCaller(({ timeoutSeconds, ...input }) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("canvas_wait");
      const canvases = yield* CanvasService.CanvasService;
      const seconds = Math.min(
        CANVAS_WAIT_MAX_SECONDS,
        Math.max(0, timeoutSeconds ?? CANVAS_WAIT_DEFAULT_SECONDS),
      );
      const event = yield* canvases
        .waitForEvent({ ...input, threadId, timeout: Duration.seconds(seconds) })
        .pipe(Effect.mapError(toFailure));
      return Option.match(event, {
        onNone: () => ({ timedOut: true }),
        onSome: (taken) => ({ timedOut: false, event: toUserEvent(taken) }),
      });
    }),
  ),
  canvas_save: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("canvas_save");
      const library = yield* CanvasLibrary.CanvasLibrary;
      return yield* library.save({ ...input, threadId }).pipe(Effect.mapError(toFailure));
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
} satisfies McpToolAccess.Handlers<typeof CanvasStandardToolkit.tools>;

export const layer = McpToolAccess.toLayer(CanvasToolkit, {
  ...standardHandlers,
  canvas_read: canvasRead(undefined),
});

export const layerStandard = McpToolAccess.toLayer(CanvasStandardToolkit, standardHandlers);

/** `canvas_read` with its screenshot, for a registration that sends it as MCP image content. */
export const layerRead = McpToolAccess.toLayer(
  CanvasReadToolkit,
  Effect.map(CanvasScreenshot.CanvasScreenshot, ({ capture }) => ({
    canvas_read: canvasRead(capture),
  })),
);
