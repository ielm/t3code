import type { CanvasError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What the canvas services need from a thread. Kept as a port so they do not depend on
 * orchestration; the server wiring provides the real implementation.
 */
export class CanvasThreadPort extends Context.Service<
  CanvasThreadPort,
  {
    /** Sends text as a user message: starts a turn when idle, queues behind a running one. */
    readonly deliver: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<void, CanvasError>;
    /** The directory the thread's agent works in. Functions run here. */
    readonly workspaceRoot: (threadId: ThreadId) => Effect.Effect<string, CanvasError>;
  }
>()("t3/canvas/CanvasThreadPort") {}
