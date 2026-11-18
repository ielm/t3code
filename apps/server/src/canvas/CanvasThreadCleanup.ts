import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const canvases = yield* CanvasService.CanvasService;
  const store = yield* CanvasStore.CanvasStore;

  const removeThread = Effect.fn("CanvasThreadCleanup.removeThread")(
    function* (threadId: ThreadId) {
      // Closing through the service first drops the live canvases and tells clients that show them.
      const names = yield* store.list(threadId);
      yield* Effect.forEach(
        names,
        (name) => canvases.close({ threadId, name }).pipe(Effect.ignore),
        { discard: true },
      );
      yield* store.removeThread(threadId);
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to remove a deleted thread's canvases", { threadId, cause }),
        ),
      ),
  );

  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      event.type === "thread.deleted" ? removeThread(event.threadId) : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Canvas thread cleanup event stream failed", { cause }),
      ),
    ),
  );
});

/** Removes a thread's canvases when the thread is deleted. */
export const layer = Layer.effectDiscard(make);
