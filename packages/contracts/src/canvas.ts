import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CANVAS_MAX_PER_THREAD = 8;
export const CANVAS_STATE_MAX_BYTES = 64 * 1024;
export const CANVAS_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
export const CANVAS_EVENTS_PER_MINUTE = 30;
export const CANVAS_FUNCTION_ARGS_MAX_BYTES = 64 * 1024;
export const CANVAS_FUNCTION_OUTPUT_MAX_BYTES = 1024 * 1024;
export const CANVAS_FUNCTION_CONCURRENCY = 4;
export const CANVAS_FUNCTION_DEFAULT_TIMEOUT_SECONDS = 30;
export const CANVAS_FUNCTION_MAX_TIMEOUT_SECONDS = 300;
export const CANVAS_MANIFEST_FILE = "canvas.json";
export const CANVAS_DEFAULT_ENTRY = "index.html";
export const CANVAS_PARTS_DIRECTORY = "parts";

/** A folder name, so it must be safe as one path segment on every platform. */
export const CanvasName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
).annotate({
  description: "Lowercase letters, digits and hyphens; starts with a letter or digit; at most 64.",
});
export type CanvasName = typeof CanvasName.Type;

/** A file inside a canvas folder: forward slashes, no leading slash, no `..`, no dot segments. */
export const CanvasRelativePath = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/).+$/u),
);
export type CanvasRelativePath = typeof CanvasRelativePath.Type;

export const CanvasScope = Schema.Literals(["thread", "project", "personal"]);
export type CanvasScope = typeof CanvasScope.Type;

/** `read` may run without a user gesture, for example on a timer. `change` needs one. */
export const CanvasFunctionKind = Schema.Literals(["read", "change"]);
export type CanvasFunctionKind = typeof CanvasFunctionKind.Type;

const CANVAS_FUNCTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const CanvasFunctionName = Schema.String.check(
  Schema.isPattern(CANVAS_FUNCTION_NAME_PATTERN),
);
export type CanvasFunctionName = typeof CanvasFunctionName.Type;

// A record keyed by a pattern drops keys that miss it; a misnamed function must fail loudly.
const functionNamesAreValid = Schema.makeFilter(
  (functions: Readonly<Record<string, unknown>>) =>
    Object.keys(functions).every((name) => CANVAS_FUNCTION_NAME_PATTERN.test(name)) ||
    "Function names start with a letter and use only letters, digits and underscores.",
);

/**
 * Runs with the thread's workspace as the working directory and `T3_CANVAS_DIR` set to the canvas
 * folder. Arguments arrive as JSON on stdin; stdout is the result, parsed as JSON when it parses.
 */
export const CanvasFunctionDeclaration = Schema.Struct({
  command: Schema.NonEmptyArray(Schema.String.check(Schema.isMinLength(1))),
  kind: CanvasFunctionKind,
  timeoutSeconds: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: CANVAS_FUNCTION_MAX_TIMEOUT_SECONDS }),
    ),
  ),
});
export type CanvasFunctionDeclaration = typeof CanvasFunctionDeclaration.Type;

/** The contents of `canvas.json`. */
export const CanvasManifest = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  entry: Schema.optional(CanvasRelativePath),
  functions: Schema.optional(
    Schema.Record(Schema.String, CanvasFunctionDeclaration).check(functionNamesAreValid),
  ),
});
export type CanvasManifest = typeof CanvasManifest.Type;

/** Any JSON object. Arrays and scalars are not a valid canvas state root. */
export const CanvasState = Schema.Record(Schema.String, Schema.Unknown);
export type CanvasState = typeof CanvasState.Type;

/** A JSON Merge Patch (RFC 7386): objects merge key by key, `null` deletes a key, arrays replace. */
export const CanvasStatePatch = Schema.Record(Schema.String, Schema.Unknown);
export type CanvasStatePatch = typeof CanvasStatePatch.Type;

export const CanvasFunctionSummary = Schema.Struct({
  name: CanvasFunctionName,
  kind: CanvasFunctionKind,
});
export type CanvasFunctionSummary = typeof CanvasFunctionSummary.Type;

export const CanvasSnapshot = Schema.Struct({
  threadId: ThreadId,
  name: CanvasName,
  title: Schema.String,
  /** Bumps when a file in the folder changes; the page reloads. */
  pageRevision: NonNegativeInt,
  /** Bumps on every state write; the page updates in place. */
  stateRevision: NonNegativeInt,
  state: CanvasState,
  functions: Schema.Array(CanvasFunctionSummary),
  /** Changes only when the agent asks for the canvas to be shown. */
  revealId: Schema.String,
  /** Why `canvas.json` could not be used. The page still renders. */
  manifestIssue: Schema.optional(Schema.String),
});
export type CanvasSnapshot = typeof CanvasSnapshot.Type;

/** The stream opens with `snapshot`, then sends one item per change. */
export const CanvasStreamItem = Schema.Union([
  Schema.TaggedStruct("snapshot", { canvases: Schema.Array(CanvasSnapshot) }),
  Schema.TaggedStruct("upsert", { canvas: CanvasSnapshot }),
  Schema.TaggedStruct("removed", { threadId: ThreadId, name: CanvasName }),
]);
export type CanvasStreamItem = typeof CanvasStreamItem.Type;

const CanvasTarget = {
  threadId: ThreadId,
  name: CanvasName,
};

export const CanvasSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type CanvasSubscribeInput = typeof CanvasSubscribeInput.Type;

export const CanvasUrlInput = Schema.Struct({
  ...CanvasTarget,
  /** Scheme, host and port the client loads the environment from. Signed into the page's CSP. */
  origin: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s/?#]+$/)),
});
export type CanvasUrlInput = typeof CanvasUrlInput.Type;

export const CanvasUrlResult = Schema.Struct({
  /** Path and query on the environment's HTTP origin. Append `pageRevision` to reload. */
  url: Schema.String,
  expiresAt: Schema.String,
});
export type CanvasUrlResult = typeof CanvasUrlResult.Type;

export const CanvasSetStateInput = Schema.Struct({
  ...CanvasTarget,
  patch: CanvasStatePatch,
});
export type CanvasSetStateInput = typeof CanvasSetStateInput.Type;

export const CanvasSetStateResult = Schema.Struct({ stateRevision: NonNegativeInt });
export type CanvasSetStateResult = typeof CanvasSetStateResult.Type;

export const CanvasEventName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type CanvasEventName = typeof CanvasEventName.Type;

export const CanvasSendEventInput = Schema.Struct({
  ...CanvasTarget,
  event: CanvasEventName,
  payload: Schema.optional(Schema.Unknown),
  /** The page the user acted on. An event from a replaced page is rejected. */
  pageRevision: NonNegativeInt,
});
export type CanvasSendEventInput = typeof CanvasSendEventInput.Type;

/** `waiter`: an agent blocked in `canvas_wait` took it. `thread`: sent as a queued message. */
export const CanvasEventDelivery = Schema.Literals(["waiter", "thread"]);
export type CanvasEventDelivery = typeof CanvasEventDelivery.Type;

export const CanvasEvent = Schema.Struct({
  id: Schema.String,
  ...CanvasTarget,
  event: CanvasEventName,
  payload: Schema.optional(Schema.Unknown),
  pageRevision: NonNegativeInt,
  stateRevision: NonNegativeInt,
  createdAt: Schema.String,
});
export type CanvasEvent = typeof CanvasEvent.Type;

export const CanvasSendEventResult = Schema.Struct({
  eventId: Schema.String,
  delivery: CanvasEventDelivery,
});
export type CanvasSendEventResult = typeof CanvasSendEventResult.Type;

export const CanvasCallInput = Schema.Struct({
  ...CanvasTarget,
  function: CanvasFunctionName,
  args: Schema.optional(Schema.Unknown),
  /** Set by the trusted panel from the browser's user activation, never by the page. */
  gesture: Schema.Boolean,
});
export type CanvasCallInput = typeof CanvasCallInput.Type;

export const CanvasCallResult = Schema.Struct({ value: Schema.Unknown });
export type CanvasCallResult = typeof CanvasCallResult.Type;

export const CanvasErrorReason = Schema.Literals([
  "not-found",
  "too-many-canvases",
  "invalid-path",
  "state-too-large",
  "event-too-large",
  "rate-limited",
  "stale-page",
  "function-not-declared",
  "function-needs-gesture",
  "function-busy",
  "function-args-too-large",
  "function-output-too-large",
  "function-timeout",
  "function-failed",
  "delivery-failed",
  "storage-failed",
]);
export type CanvasErrorReason = typeof CanvasErrorReason.Type;

export class CanvasError extends Schema.TaggedError<CanvasError>()("CanvasError", {
  reason: CanvasErrorReason,
  canvas: Schema.optional(Schema.String),
  // The owner debugs their own functions from the page, so a failed function carries its stderr.
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "No canvas with that name is open in this thread.";
      case "too-many-canvases":
        return `A thread can have at most ${CANVAS_MAX_PER_THREAD} canvases. Close one first.`;
      case "invalid-path":
        return "That path is outside the canvas folder.";
      case "state-too-large":
        return `Canvas state is limited to ${CANVAS_STATE_MAX_BYTES} bytes of JSON.`;
      case "event-too-large":
        return `A canvas event payload is limited to ${CANVAS_EVENT_PAYLOAD_MAX_BYTES} bytes of JSON.`;
      case "rate-limited":
        return "This canvas is sending events too quickly.";
      case "stale-page":
        return "That action came from an older version of the canvas page.";
      case "function-not-declared":
        return "canvas.json does not declare that function.";
      case "function-needs-gesture":
        return "That function changes things, so it only runs from a click or key press.";
      case "function-busy":
        return "Too many functions are already running for this canvas.";
      case "function-args-too-large":
        return `Function arguments are limited to ${CANVAS_FUNCTION_ARGS_MAX_BYTES} bytes of JSON.`;
      case "function-output-too-large":
        return `Function output is limited to ${CANVAS_FUNCTION_OUTPUT_MAX_BYTES} bytes.`;
      case "function-timeout":
        return "The function did not finish in time.";
      case "function-failed":
        return this.detail === undefined
          ? "The function exited with an error."
          : `The function exited with an error: ${this.detail}`;
      case "delivery-failed":
        return "The action could not be sent to the thread.";
      case "storage-failed":
        return "The canvas files could not be read or written.";
    }
  }
}
