import type { CanvasSnapshot, CanvasStatePatch } from "@t3tools/contracts";
import {
  CANVAS_BRIDGE_VERSION,
  type CanvasHostMessage,
  type CanvasPageMessage,
  decodeCanvasPageMessage,
} from "@t3tools/shared/canvas";
import { readHtmlRenderLinkRequest } from "@t3tools/shared/htmlRender";
import * as Option from "effect/Option";

const CANVAS_PAGE_REVISION_PARAM = "pageRevision";

export type CanvasCallOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export interface CanvasEventInput {
  readonly event: string;
  readonly payload?: unknown;
  readonly pageRevision: number;
}

export interface CanvasCallRequest {
  readonly function: string;
  readonly args?: unknown;
  readonly gesture: boolean;
}

export interface CanvasLogInput {
  readonly level: "error" | "warning";
  readonly text: string;
}

/** What the panel's own window reports as a page message arrives. The page supplies none of it. */
export interface CanvasGestureSample {
  /** `navigator.userActivation.isActive`: input somewhere in the app window in the last seconds. */
  readonly active: boolean;
  /** Focus is inside the canvas frame, so that input went to the canvas. */
  readonly focused: boolean;
  /** Monotonic milliseconds, as `performance.now()` gives. */
  readonly now: number;
}

/**
 * A deliberate trade. Transient activation lasts about five seconds, so only a wait longer than
 * that proves a new press. That would refuse a real second click for five seconds, so this allows
 * one privileged action per second and accepts that one press can pay for a few of them.
 */
export const CANVAS_GESTURE_REARM_MS = 1_000;

type CanvasGestureVerdict = "accepted" | "no-gesture" | "spent";

/**
 * Rate-limits privileged actions (an event, a `change` function call or a link) behind a click or
 * key press in a canvas. A window shows only whether it saw input recently, not which input, so
 * after an action is accepted the next waits until activation is seen to lapse or
 * `CANVAS_GESTURE_REARM_MS` has passed. A second press sooner than that is refused.
 */
export function createCanvasGestureGate() {
  let acceptedAt: number | undefined;
  const observe = (sample: CanvasGestureSample): void => {
    if (!sample.active) acceptedAt = undefined;
  };
  return {
    /** Every page message is a chance to see that the accepted press has lapsed. */
    observe,
    take(sample: CanvasGestureSample): CanvasGestureVerdict {
      observe(sample);
      if (!sample.active || !sample.focused) return "no-gesture";
      if (acceptedAt !== undefined && sample.now - acceptedAt < CANVAS_GESTURE_REARM_MS) {
        return "spent";
      }
      acceptedAt = sample.now;
      return "accepted";
    },
  };
}

const droppedEventText = (event: string, verdict: Exclude<CanvasGestureVerdict, "accepted">) =>
  verdict === "spent"
    ? `Event "${event}" was not sent: the same click or key press already sent an event, ran a change function or opened a link. One press does one of those.`
    : `Event "${event}" was not sent: canvas.send only works from the user's click or key press in the canvas.`;

export type CanvasBridgeAction =
  | { readonly type: "post"; readonly message: CanvasHostMessage }
  | { readonly type: "setState"; readonly patch: CanvasStatePatch }
  | { readonly type: "event"; readonly input: CanvasEventInput }
  | {
      readonly type: "call";
      readonly input: CanvasCallRequest;
      /** The message to post back, or `undefined` when the page that asked is gone. */
      readonly settle: (outcome: CanvasCallOutcome) => CanvasHostMessage | undefined;
    }
  | { readonly type: "log"; readonly input: CanvasLogInput };

/** The entry URL for one page revision. A fragment on `url` is replaced by `fragment`. */
export function canvasFrameSrc(url: string, pageRevision: number, fragment = ""): string {
  const base = url.split("#", 1)[0] ?? "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${CANVAS_PAGE_REVISION_PARAM}=${pageRevision}${fragment}`;
}

/** A message counts only when it comes from the canvas frame's own window and decodes. */
export function acceptCanvasPageMessage(
  event: { readonly source: unknown; readonly data: unknown },
  frameWindow: unknown,
): CanvasPageMessage | undefined {
  if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) {
    return undefined;
  }
  return Option.getOrUndefined(decodeCanvasPageMessage(event.data));
}

export interface CanvasLinkRequest {
  readonly url: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * A link the page asks the panel to open, in the message html_render pages send. A link into the
 * canvas's own folder is refused: its signed address is only good inside the frame.
 */
export function acceptCanvasLinkRequest(
  event: { readonly source: unknown; readonly data: unknown },
  frameWindow: unknown,
  frameUrl: string,
): CanvasLinkRequest | undefined {
  if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) {
    return undefined;
  }
  const request = readHtmlRenderLinkRequest(event.data);
  if (request === undefined || !URL.canParse(request.url)) return undefined;
  const link = new URL(request.url);
  const frame = URL.canParse(frameUrl) ? new URL(frameUrl) : null;
  const folder = frame?.pathname.slice(0, frame.pathname.lastIndexOf("/") + 1);
  if (link.origin === frame?.origin && folder !== undefined && link.pathname.startsWith(folder)) {
    return undefined;
  }
  return { url: request.url, metaKey: request.metaKey, ctrlKey: request.ctrlKey };
}

const stateMessage = (snapshot: CanvasSnapshot): CanvasHostMessage => ({
  t3canvas: CANVAS_BRIDGE_VERSION,
  type: "state",
  state: snapshot.state,
  stateRevision: snapshot.stateRevision,
});

/**
 * The host side of one mounted canvas frame. Each `ready` starts a new page: a page can reload
 * itself without a revision change, and its call ids then start over.
 */
export function createCanvasBridge(pageRevision: number, gate = createCanvasGestureGate()) {
  let page = 0;
  let postedStateRevision: number | undefined;

  return {
    receive(
      message: CanvasPageMessage,
      context: { readonly snapshot: CanvasSnapshot; readonly gesture: CanvasGestureSample },
    ): CanvasBridgeAction {
      gate.observe(context.gesture);
      switch (message.type) {
        case "ready": {
          page += 1;
          const { snapshot } = context;
          postedStateRevision = snapshot.stateRevision;
          return {
            type: "post",
            message: {
              t3canvas: CANVAS_BRIDGE_VERSION,
              type: "init",
              name: snapshot.name,
              title: snapshot.title,
              state: snapshot.state,
              stateRevision: snapshot.stateRevision,
              functions: snapshot.functions,
            },
          };
        }
        case "setState":
          return { type: "setState", patch: message.patch };
        case "event": {
          const verdict = gate.take(context.gesture);
          if (verdict !== "accepted") {
            return {
              type: "log",
              input: { level: "warning", text: droppedEventText(message.event, verdict) },
            };
          }
          return {
            type: "event",
            input: {
              event: message.event,
              ...(message.payload === undefined ? {} : { payload: message.payload }),
              pageRevision,
            },
          };
        }
        case "call": {
          const caller = page;
          const { id } = message;
          // Only a function this snapshot lists as `read` skips the gate; the server decides again.
          const read = context.snapshot.functions.some(
            (declared) => declared.name === message.function && declared.kind === "read",
          );
          return {
            type: "call",
            input: {
              function: message.function,
              ...(message.args === undefined ? {} : { args: message.args }),
              gesture: !read && gate.take(context.gesture) === "accepted",
            },
            settle: (outcome) =>
              caller === page
                ? { t3canvas: CANVAS_BRIDGE_VERSION, type: "callResult", id, ...outcome }
                : undefined,
          };
        }
        case "log":
          return { type: "log", input: { level: message.level, text: message.text } };
      }
    },

    /** The `state` message for a revision the ready page has not been sent yet. */
    stateUpdate(snapshot: CanvasSnapshot): CanvasHostMessage | undefined {
      if (postedStateRevision === undefined || postedStateRevision === snapshot.stateRevision) {
        return undefined;
      }
      postedStateRevision = snapshot.stateRevision;
      return stateMessage(snapshot);
    },
  };
}

export type CanvasBridge = ReturnType<typeof createCanvasBridge>;
