import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CanvasName, type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadCleanup from "./CanvasThreadCleanup.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

// The reactor reads only the type and the thread id.
const event = (type: OrchestrationV2DomainEvent["type"], threadId: ThreadId) =>
  ({ type, threadId }) as unknown as OrchestrationV2DomainEvent;

const layerTest = (
  events: Queue.Queue<OrchestrationV2DomainEvent>,
  removed: Deferred.Deferred<ThreadId>,
) =>
  CanvasThreadCleanup.layer.pipe(
    Layer.provideMerge(CanvasService.layer),
    Layer.provideMerge(
      Layer.effect(
        CanvasStore.CanvasStore,
        Effect.gen(function* () {
          const store = yield* CanvasStore.CanvasStore;
          return CanvasStore.CanvasStore.of({
            ...store,
            removeThread: (threadId) =>
              store
                .removeThread(threadId)
                .pipe(Effect.ensuring(Deferred.succeed(removed, threadId))),
          });
        }),
      ).pipe(Layer.provide(CanvasStore.layer)),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CanvasThreadPort.CanvasThreadPort)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          streamDomainEvents: Stream.fromQueue(events),
        }),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-canvas-cleanup-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("removes a deleted thread's canvases and leaves other threads alone", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const removed = yield* Deferred.make<ThreadId>();
    const deleted = ThreadId.make("thread-deleted");
    const kept = ThreadId.make("thread-kept");
    const name = CanvasName.make("board");

    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      const store = yield* CanvasStore.CanvasStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const opened = yield* canvases.open({ threadId: deleted, name });
      yield* canvases.open({ threadId: kept, name });

      yield* Queue.offerAll(events, [
        event("thread.archived", kept),
        event("thread.deleted", deleted),
      ]);
      expect(yield* Deferred.await(removed)).toBe(deleted);

      expect(yield* fs.exists(path.dirname(opened.path))).toBe(false);
      const reopened = yield* canvases.get({ threadId: deleted, name }).pipe(Effect.flip);
      expect(reopened.reason).toBe("not-found");
      expect(yield* store.list(kept)).toEqual([name]);
    }).pipe(Effect.provide(layerTest(events, removed)));
  }),
);
