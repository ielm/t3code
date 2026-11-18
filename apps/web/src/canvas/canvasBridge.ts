import type { CanvasSnapshot, CanvasStatePatch } from "@t3tools/contracts";
import {
  CANVAS_BRIDGE_VERSION,
  type CanvasHostMessage,
  type CanvasPageMessage,
  decodeCanvasPageMessage,
} from "@t3tools/shared/canvas";
import * as Option from "effect/Option";

export const CANVAS_PAGE_REVISION_PARAM = "pageRevision";

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
export function createCanvasBridge(pageRevision: number) {
  let page = 0;
  let postedStateRevision: number | undefined;

  return {
    receive(
      message: CanvasPageMessage,
      context: { readonly snapshot: CanvasSnapshot; readonly gesture: boolean },
    ): CanvasBridgeAction {
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
        case "event":
          return {
            type: "event",
            input: {
              event: message.event,
              ...(message.payload === undefined ? {} : { payload: message.payload }),
              pageRevision,
            },
          };
        case "call": {
          const caller = page;
          const { id } = message;
          return {
            type: "call",
            input: {
              function: message.function,
              ...(message.args === undefined ? {} : { args: message.args }),
              gesture: context.gesture,
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
