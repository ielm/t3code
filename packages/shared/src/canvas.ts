import {
  CanvasEventName,
  CanvasFunctionName,
  CanvasFunctionSummary,
  CanvasState,
  CanvasStatePatch,
  type CanvasEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Marks a `postMessage` payload as canvas traffic. Bump when a message shape changes. */
export const CANVAS_BRIDGE_VERSION = 1;
/** The global the injected runtime defines inside the page. */
export const CANVAS_PAGE_GLOBAL = "canvas";
export const CANVAS_LOG_MAX_ENTRIES = 50;
export const CANVAS_LOG_ENTRY_MAX_LENGTH = 2000;

const bridge = { t3canvas: Schema.Literal(CANVAS_BRIDGE_VERSION) };

const CanvasCallId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** Sent by the page runtime to the panel. The panel trusts none of it. */
export const CanvasPageMessage = Schema.Union([
  /** The runtime is listening; the panel answers with `init`. */
  Schema.Struct({ ...bridge, type: Schema.Literal("ready") }),
  Schema.Struct({ ...bridge, type: Schema.Literal("setState"), patch: CanvasStatePatch }),
  Schema.Struct({
    ...bridge,
    type: Schema.Literal("event"),
    event: CanvasEventName,
    payload: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    ...bridge,
    type: Schema.Literal("call"),
    id: CanvasCallId,
    function: CanvasFunctionName,
    args: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    ...bridge,
    type: Schema.Literal("log"),
    level: Schema.Literals(["error", "warning"]),
    text: Schema.String.check(Schema.isMaxLength(CANVAS_LOG_ENTRY_MAX_LENGTH)),
  }),
]);
export type CanvasPageMessage = typeof CanvasPageMessage.Type;

export const decodeCanvasPageMessage = Schema.decodeUnknownOption(CanvasPageMessage);

/** Sent by the panel to the page runtime. */
export type CanvasHostMessage =
  | {
      readonly t3canvas: typeof CANVAS_BRIDGE_VERSION;
      readonly type: "init";
      readonly name: string;
      readonly title: string;
      readonly state: CanvasState;
      readonly stateRevision: number;
      readonly functions: ReadonlyArray<CanvasFunctionSummary>;
    }
  | {
      readonly t3canvas: typeof CANVAS_BRIDGE_VERSION;
      readonly type: "state";
      readonly state: CanvasState;
      readonly stateRevision: number;
    }
  | {
      readonly t3canvas: typeof CANVAS_BRIDGE_VERSION;
      readonly type: "callResult";
      readonly id: string;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly t3canvas: typeof CANVAS_BRIDGE_VERSION;
      readonly type: "callResult";
      readonly id: string;
      readonly ok: false;
      readonly reason: string;
      readonly message: string;
    };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON Merge Patch (RFC 7386). Returns a new object; neither argument is mutated. */
export function applyCanvasStatePatch(state: CanvasState, patch: CanvasStatePatch): CanvasState {
  const next: Record<string, unknown> = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else if (isPlainObject(value)) {
      const current = next[key];
      next[key] = applyCanvasStatePatch(isPlainObject(current) ? current : {}, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** UTF-8 size of a value as JSON, or `null` when it cannot be serialised. */
export function canvasJsonByteLength(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : new TextEncoder().encode(json).byteLength;
  } catch {
    return null;
  }
}

/** The thread message an agent reads when the user acts in a canvas and nothing is waiting. */
export function formatCanvasEventMessage(event: CanvasEvent): string {
  const payload = event.payload === undefined ? "" : `\n${JSON.stringify(event.payload, null, 2)}`;
  return `[canvas ${event.name}] ${event.event}${payload}`;
}
