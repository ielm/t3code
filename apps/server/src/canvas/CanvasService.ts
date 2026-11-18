import type {
  CanvasError,
  CanvasEvent,
  CanvasEventDelivery,
  CanvasEventName,
  CanvasName,
  CanvasSnapshot,
  CanvasState,
  CanvasStatePatch,
  CanvasStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { CanvasTarget } from "./CanvasStore.ts";

export interface CanvasOpened {
  readonly snapshot: CanvasSnapshot;
  /** Absolute path of the folder the agent edits. */
  readonly path: string;
}

/**
 * The live canvases of each thread: the shared state document, the snapshot stream clients follow,
 * and the user's events on their way to the agent.
 */
export class CanvasService extends Context.Service<
  CanvasService,
  {
    /**
     * Creates the canvas or reuses the open one, and asks clients to show it. `state` replaces
     * the stored state when given; otherwise stored state is kept.
     */
    readonly open: (
      input: CanvasTarget & { readonly title?: string; readonly state?: CanvasState },
    ) => Effect.Effect<CanvasOpened, CanvasError>;
    /** Removes the canvas from every client and deletes its folder and state. */
    readonly close: (target: CanvasTarget) => Effect.Effect<void, CanvasError>;
    readonly get: (target: CanvasTarget) => Effect.Effect<CanvasOpened, CanvasError>;
    /** Merges a JSON Merge Patch into the state. Agent and page writes share this path. */
    readonly patchState: (
      input: CanvasTarget & { readonly patch: CanvasStatePatch },
    ) => Effect.Effect<CanvasSnapshot, CanvasError>;
    /** Opens with a `snapshot` of every open canvas, including ones restored from disk. */
    readonly stream: (threadId: ThreadId) => Stream.Stream<CanvasStreamItem, CanvasError>;
    /**
     * Records a user action. An agent blocked in `waitForEvent` takes it; otherwise it goes to the
     * thread as a message. Rejects an event from a page older than the current one.
     */
    readonly submitEvent: (
      input: CanvasTarget & {
        readonly event: CanvasEventName;
        readonly payload?: unknown;
        readonly pageRevision: number;
      },
    ) => Effect.Effect<
      { readonly eventId: string; readonly delivery: CanvasEventDelivery },
      CanvasError
    >;
    /** Waits for the next user action on one canvas, or on any of the thread's when unnamed. */
    readonly waitForEvent: (input: {
      readonly threadId: ThreadId;
      readonly name?: CanvasName;
      readonly timeout: Duration.Duration;
    }) => Effect.Effect<Option.Option<CanvasEvent>, CanvasError>;
    /** The most recent user actions, newest last, however they were delivered. */
    readonly recentEvents: (
      target: CanvasTarget,
    ) => Effect.Effect<ReadonlyArray<CanvasEvent>, CanvasError>;
  }
>()("t3/canvas/CanvasService") {}
