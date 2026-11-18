import { expect, it } from "@effect/vitest";
import {
  CanvasError,
  type CanvasEvent,
  type CanvasSnapshot,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CanvasDiagnostics from "../../../canvas/CanvasDiagnostics.ts";
import * as CanvasLibrary from "../../../canvas/CanvasLibrary.ts";
import * as CanvasScreenshot from "../../../canvas/CanvasScreenshot.ts";
import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CanvasHandlers from "./handlers.ts";
import { CanvasReadToolkit, CanvasToolkit } from "./tools.ts";

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

const pickedForAgent = {
  name: "plan",
  event: "picked",
  payload: { id: 3 },
  pageRevision: 3,
  stateRevision: 5,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const picked: CanvasEvent = { id: "event:1", threadId, ...pickedForAgent };

const savedEntry = (scope: "project" | "personal", name: string) => ({
  scope,
  name,
  title: `Saved ${name}`,
  description: null,
  path: `/library/${scope}/${name}`,
});

const setup = (invocation: McpInvocationContext.McpInvocationScope = scope) => {
  const calls: Array<readonly [method: string, input: unknown]> = [];
  const nextEvent = Deferred.makeUnsafe<CanvasEvent>();
  const failing = (name: string | undefined) =>
    name === "full"
      ? Effect.fail(new CanvasError({ reason: "too-many-canvases" }))
      : name === "broken"
        ? Effect.fail(new CanvasError({ reason: "storage-failed" }))
        : name === "missing"
          ? Effect.fail(new CanvasError({ reason: "not-found" }))
          : Effect.void;
  const called = <A>(method: string, input: { readonly name?: string }, result: A) =>
    Effect.as(
      Effect.andThen(
        Effect.sync(() => calls.push([method, input])),
        failing(input.name),
      ),
      result,
    );
  const services = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
    }),
    Layer.mock(CanvasService.CanvasService)({
      open: (input) =>
        called("open", input, {
          snapshot: snapshotOf(input.name, 5),
          path: `/state/canvas/${input.name}`,
        }),
      patchState: (input) => called("patchState", input, snapshotOf(input.name, 6)),
      close: (input) => called("close", input, undefined),
      get: (input) =>
        called("get", input, {
          snapshot: {
            ...snapshotOf(input.name, 5),
            state: { step: 1 },
            functions: [{ name: "listFiles", kind: "read" as const }],
            manifestIssue: "canvas.json is not valid JSON.",
          },
          path: `/state/canvas/${input.name}`,
        }),
      recentEvents: () => Effect.succeed([picked]),
      stream: () =>
        Stream.make({
          _tag: "snapshot" as const,
          canvases: [snapshotOf("plan", 5), { ...snapshotOf("board", 2), title: "Board" }],
        }),
      waitForEvent: (input) =>
        Effect.andThen(
          called("waitForEvent", input, undefined),
          Deferred.await(nextEvent).pipe(Effect.timeoutOption(input.timeout)),
        ),
    }),
    Layer.mock(CanvasLibrary.CanvasLibrary)({
      list: () => Effect.succeed([savedEntry("project", "review"), savedEntry("personal", "kit")]),
      save: (input) =>
        input.as === "taken"
          ? Effect.fail(
              new CanvasLibrary.CanvasAlreadyExistsError({ scope: input.to, canvas: input.as }),
            )
          : called("save", input, savedEntry(input.to, input.as ?? input.name)),
      instantiate: (input) =>
        input.as === "open"
          ? Effect.fail(
              new CanvasLibrary.CanvasAlreadyExistsError({ scope: "thread", canvas: input.as }),
            )
          : called(
              "instantiate",
              { ...input, name: input.from.name },
              {
                threadId: input.threadId,
                name: input.as ?? input.from.name,
                path: "/state/canvas/copied",
                manifest: null,
                manifestIssue: null,
              },
            ),
    }),
    Layer.mock(CanvasDiagnostics.CanvasDiagnostics)({
      recent: (input) =>
        Effect.succeed({
          pageRevision: input.name === "reloaded" ? 2 : 3,
          entries: [{ level: "error" as const, text: "boom", at: picked.createdAt, count: 2 }],
        }),
    }),
    Layer.mock(CanvasScreenshot.CanvasScreenshot)({
      capture: (input) =>
        input.name === "unrenderable"
          ? Effect.fail(
              new CanvasError({
                reason: "storage-failed",
                detail: "The canvas entry page could not be read.",
              }),
            )
          : called("capture", input, {
              mimeType: "image/png" as const,
              data: "cG5n",
              width: 720,
              height: 900,
              consoleMessages: [],
            }),
    }),
  );
  return {
    calls,
    nextEvent,
    layer: McpToolAccess.HandlersLayer.layer(CanvasHandlers.layer).pipe(
      Layer.provideMerge(services),
    ),
    layerRead: McpToolAccess.HandlersLayer.layer(CanvasHandlers.layerRead).pipe(
      Layer.provideMerge(services),
    ),
  };
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

it.effect("creates a canvas from a saved one before opening it", () => {
  const { calls, layer } = setup();
  return Effect.gen(function* () {
    const toolkit = yield* CanvasToolkit;
    const from = { scope: "project" as const, name: "review" };

    expect(
      yield* resultOf(toolkit.handle("canvas_open", { name: "pr-12", title: "PR 12", from })),
    ).toEqual({ name: "pr-12", path: "/state/canvas/pr-12", pageRevision: 3, stateRevision: 5 });
    expect(calls).toEqual([
      ["instantiate", { threadId, from, as: "pr-12", name: "review" }],
      ["open", { threadId, name: "pr-12", title: "PR 12" }],
    ]);

    calls.length = 0;
    expect(yield* resultOf(toolkit.handle("canvas_open", { name: "open", from }))).toEqual(
      expect.objectContaining({
        code: "invalid_request",
        message: "This thread already has a canvas with that name. Omit `from` to reopen it.",
      }),
    );
    expect(
      yield* resultOf(
        toolkit.handle("canvas_open", {
          name: "plan",
          from: { scope: "personal", name: "missing" },
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        code: "invalid_request",
        message:
          "The personal library has no canvas named missing. `canvas_read` lists the saved ones.",
      }),
    );
    expect(calls.filter(([method]) => method === "open")).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("reads one canvas, and without a name lists the open and the saved ones", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const toolkit = yield* CanvasToolkit;

    expect(yield* resultOf(toolkit.handle("canvas_read", { name: "plan" }))).toEqual({
      name: "plan",
      title: "plan",
      path: "/state/canvas/plan",
      pageRevision: 3,
      stateRevision: 5,
      state: { step: 1 },
      functions: [{ name: "listFiles", kind: "read" }],
      manifestIssue: "canvas.json is not valid JSON.",
      events: [pickedForAgent],
      errors: [{ level: "error", text: "boom", at: picked.createdAt, count: 2 }],
      screenshotError: "Screenshots are not available here.",
    });
    // What the previous page logged says nothing about the one now showing.
    expect(yield* resultOf(toolkit.handle("canvas_read", { name: "reloaded" }))).toMatchObject({
      pageRevision: 3,
      errors: [],
    });
    expect(yield* resultOf(toolkit.handle("canvas_read", {}))).toEqual({
      canvases: [
        { name: "plan", title: "plan", pageRevision: 3, stateRevision: 5 },
        { name: "board", title: "Board", pageRevision: 3, stateRevision: 2 },
      ],
      saved: [
        { scope: "project", name: "review", title: "Saved review", description: null },
        { scope: "personal", name: "kit", title: "Saved kit", description: null },
      ],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("adds a screenshot where it is sent as an image, and reports one that failed", () => {
  const { calls, layerRead } = setup();
  return Effect.gen(function* () {
    const toolkit = yield* CanvasReadToolkit;

    expect(yield* resultOf(toolkit.handle("canvas_read", { name: "plan" }))).toMatchObject({
      stateRevision: 5,
      screenshot: { mimeType: "image/png", data: "cG5n", width: 720, height: 900 },
    });
    expect(calls.at(-1)).toEqual(["capture", { threadId, name: "plan" }]);

    const failed = yield* resultOf(toolkit.handle("canvas_read", { name: "unrenderable" }));
    expect(failed).toMatchObject({
      name: "unrenderable",
      state: { step: 1 },
      screenshotError: "The canvas entry page could not be read.",
    });
    expect(failed).not.toHaveProperty("screenshot");

    calls.length = 0;
    expect(yield* resultOf(toolkit.handle("canvas_read", {}))).toHaveProperty("saved");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(layerRead));
});

it.effect("waits for the user's next action, and times out as a success", () => {
  const { calls, nextEvent, layer } = setup();
  return Effect.gen(function* () {
    const toolkit = yield* CanvasToolkit;
    const wait = (input: { readonly name?: string; readonly timeoutSeconds?: number }) =>
      resultOf(toolkit.handle("canvas_wait", input)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

    const unanswered = yield* wait({});
    yield* TestClock.adjust("29 seconds");
    expect(unanswered.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(unanswered)).toEqual({ timedOut: true });

    const tooLong = yield* wait({ name: "plan", timeoutSeconds: 600 });
    yield* TestClock.adjust("45 seconds");
    expect(yield* Fiber.join(tooLong)).toEqual({ timedOut: true });

    const answered = yield* wait({ name: "plan", timeoutSeconds: 5 });
    yield* Deferred.succeed(nextEvent, picked);
    expect(yield* Fiber.join(answered)).toEqual({ timedOut: false, event: pickedForAgent });

    expect(calls).toEqual([
      ["waitForEvent", { threadId, timeout: Duration.seconds(30) }],
      ["waitForEvent", { threadId, name: "plan", timeout: Duration.seconds(45) }],
      ["waitForEvent", { threadId, name: "plan", timeout: Duration.seconds(5) }],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("saves a canvas to a library, and says how to replace one that is there", () => {
  const { calls, layer } = setup();
  return Effect.gen(function* () {
    const toolkit = yield* CanvasToolkit;

    expect(
      yield* resultOf(toolkit.handle("canvas_save", { name: "plan", to: "project", as: "review" })),
    ).toEqual(savedEntry("project", "review"));
    expect(calls).toEqual([["save", { threadId, name: "plan", to: "project", as: "review" }]]);

    expect(
      yield* resultOf(toolkit.handle("canvas_save", { name: "plan", to: "personal", as: "taken" })),
    ).toEqual(
      expect.objectContaining({
        code: "invalid_request",
        message:
          "The personal library already has a canvas with that name. Pass `overwrite: true` to replace it.",
      }),
    );
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
    for (const result of [
      yield* resultOf(toolkit.handle("canvas_state", { name: "missing", patch: { a: 1 } })),
      yield* Effect.flip(resultOf(toolkit.handle("canvas_read", { name: "missing" }))),
      yield* resultOf(toolkit.handle("canvas_wait", { name: "missing" })),
      yield* resultOf(toolkit.handle("canvas_save", { name: "missing", to: "project" })),
    ]) {
      expect(result).toEqual(
        expect.objectContaining({
          code: "invalid_request",
          message: "No canvas with that name is open in this thread.",
        }),
      );
    }
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
      yield* Effect.flip(resultOf(toolkit.handle("canvas_read", { name: "plan" }))),
      yield* Effect.flip(resultOf(toolkit.handle("canvas_read", {}))),
      yield* resultOf(toolkit.handle("canvas_wait", {})),
      yield* resultOf(toolkit.handle("canvas_save", { name: "plan", to: "personal" })),
      yield* resultOf(toolkit.handle("canvas_close", { name: "plan" })),
    ]) {
      expect(result).toMatchObject({ code: "thread_credential_required" });
    }
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(layer));
});
