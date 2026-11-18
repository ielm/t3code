import { expect, it } from "@effect/vitest";
import {
  CanvasError,
  type CanvasSnapshot,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CanvasHandlers from "./handlers.ts";
import { CanvasToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:canvas");

const scope = {
  environmentId: EnvironmentId.make("environment:canvas"),
  requestNamespace: "provider:canvas",
  thread: {
    threadId,
    providerSessionId: "provider:canvas",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
} satisfies McpInvocationContext.McpInvocationScope;

const snapshotOf = (name: string, stateRevision: number): CanvasSnapshot => ({
  threadId,
  name,
  title: name,
  pageRevision: 3,
  stateRevision,
  state: {},
  functions: [],
  revealId: "reveal:1",
});

const setup = (invocation: McpInvocationContext.McpInvocationScope = scope) => {
  const calls: Array<readonly [method: string, input: unknown]> = [];
  const failing = (name: string) =>
    name === "full"
      ? Effect.fail(new CanvasError({ reason: "too-many-canvases" }))
      : name === "broken"
        ? Effect.fail(new CanvasError({ reason: "storage-failed" }))
        : name === "missing"
          ? Effect.fail(new CanvasError({ reason: "not-found" }))
          : Effect.void;
  const layer = McpToolAccess.HandlersLayer.layer(CanvasHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(CanvasService.CanvasService)({
          open: (input) =>
            Effect.as(
              Effect.andThen(
                Effect.sync(() => calls.push(["open", input])),
                failing(input.name),
              ),
              { snapshot: snapshotOf(input.name, 5), path: `/state/canvas/${input.name}` },
            ),
          patchState: (input) =>
            Effect.as(
              Effect.andThen(
                Effect.sync(() => calls.push(["patchState", input])),
                failing(input.name),
              ),
              snapshotOf(input.name, 6),
            ),
          close: (input) =>
            Effect.andThen(
              Effect.sync(() => calls.push(["close", input])),
              failing(input.name),
            ),
        }),
      ),
    ),
  );
  return { calls, layer };
};

const resultOf = <A, E, R, E2, R2>(
  handled: Effect.Effect<Stream.Stream<{ readonly result: A }, E, R>, E2, R2>,
) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((parts) => parts.at(-1)?.result),
  );

it.effect("opens, patches and closes the calling thread's canvas through the service", () => {
  const { calls, layer } = setup();
  return Effect.gen(function* () {
    const toolkit = yield* CanvasToolkit;

    expect(
      yield* resultOf(
        toolkit.handle("canvas_open", { name: "plan", title: "Plan", state: { step: 1 } }),
      ),
    ).toEqual({ name: "plan", path: "/state/canvas/plan", pageRevision: 3, stateRevision: 5 });
    expect(yield* resultOf(toolkit.handle("canvas_open", { name: "plan" }))).toMatchObject({
      name: "plan",
    });
    expect(
      yield* resultOf(toolkit.handle("canvas_state", { name: "plan", patch: { step: null } })),
    ).toEqual({ stateRevision: 6 });
    expect(yield* resultOf(toolkit.handle("canvas_close", { name: "plan" }))).toEqual({});

    expect(calls).toEqual([
      ["open", { threadId, name: "plan", title: "Plan", state: { step: 1 } }],
      ["open", { threadId, name: "plan" }],
      ["patchState", { threadId, name: "plan", patch: { step: null } }],
      ["close", { threadId, name: "plan" }],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("returns a canvas error as a tool failure with its message", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const toolkit = yield* CanvasToolkit;

    expect(yield* resultOf(toolkit.handle("canvas_open", { name: "full" }))).toEqual(
      expect.objectContaining({
        code: "invalid_request",
        message: "A thread can have at most 8 canvases. Close one first.",
      }),
    );
    expect(
      yield* resultOf(toolkit.handle("canvas_state", { name: "missing", patch: { a: 1 } })),
    ).toEqual(
      expect.objectContaining({
        code: "invalid_request",
        message: "No canvas with that name is open in this thread.",
      }),
    );
    expect(yield* resultOf(toolkit.handle("canvas_close", { name: "broken" }))).toEqual(
      expect.objectContaining({
        code: "orchestration_error",
        message: "The canvas files could not be read or written.",
      }),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a caller that is not a thread before reaching the service", () => {
  const { calls, layer } = setup({ ...scope, thread: undefined });
  return Effect.gen(function* () {
    const toolkit = yield* CanvasToolkit;

    for (const result of [
      yield* resultOf(toolkit.handle("canvas_open", { name: "plan" })),
      yield* resultOf(toolkit.handle("canvas_state", { name: "plan", patch: {} })),
      yield* resultOf(toolkit.handle("canvas_close", { name: "plan" })),
    ]) {
      expect(result).toMatchObject({ code: "thread_credential_required" });
    }
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(layer));
});
