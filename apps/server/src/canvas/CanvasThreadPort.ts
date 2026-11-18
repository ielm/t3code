import { CanvasError, CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

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

const deliveryFailed = (cause: unknown) => new CanvasError({ reason: "delivery-failed", cause });
const threadReadFailed = (cause: unknown) => new CanvasError({ reason: "storage-failed", cause });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;

  const deliver: CanvasThreadPort["Service"]["deliver"] = Effect.fn("CanvasThreadPort.deliver")(
    function* (input) {
      const thread = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(deliveryFailed));
      if (thread === null) {
        return yield* new CanvasError({ reason: "delivery-failed" });
      }
      const id = yield* random.uuidV4().pipe(Effect.mapError(deliveryFailed));
      yield* threads
        .sendToThread({
          projectId: thread.projectId,
          commandId: CommandId.make(`server:canvas-event:${id}`),
          threadId: input.threadId,
          messageId: MessageId.make(`message:canvas-event:${id}`),
          text: input.text,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(deliveryFailed));
    },
  );

  const workspaceRoot: CanvasThreadPort["Service"]["workspaceRoot"] = Effect.fn(
    "CanvasThreadPort.workspaceRoot",
  )(function* (threadId) {
    const thread = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(threadReadFailed));
    if (thread === null) {
      return yield* new CanvasError({ reason: "not-found" });
    }
    if (thread.worktreePath !== null) {
      return thread.worktreePath;
    }
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(threadReadFailed));
    if (Option.isNone(project)) {
      return yield* new CanvasError({ reason: "not-found" });
    }
    return project.value.workspaceRoot;
  });

  return CanvasThreadPort.of({ deliver, workspaceRoot });
});

export const layer = Layer.effect(CanvasThreadPort, make);
