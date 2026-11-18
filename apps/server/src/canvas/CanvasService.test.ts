import { expect, it } from "@effect/vitest";
import {
  CANVAS_EVENT_PAYLOAD_MAX_BYTES,
  CANVAS_EVENTS_PER_MINUTE,
  CANVAS_STATE_MAX_BYTES,
  CanvasError,
  ThreadId,
  type CanvasManifest,
  type CanvasName,
  type CanvasStreamItem,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

const threadId = ThreadId.make("thread-1");
const board = { threadId, name: "board" };
const notes = { threadId, name: "notes" };

const keyOf = (target: CanvasStore.CanvasTarget) => `${target.threadId}/${target.name}`;

const makeHarness = Effect.sync(() => {
  const folders = new Map<string, CanvasStore.CanvasFolder>();
  const states = new Map<string, CanvasStore.CanvasPersistedState>();
  const changeQueues = new Map<string, Queue.Queue<CanvasStore.CanvasFolder>>();
  const delivered: Array<string> = [];
  let ids = 0;

  const changesOf = Effect.fnUntraced(function* (target: CanvasStore.CanvasTarget) {
    const created = yield* Queue.unbounded<CanvasStore.CanvasFolder>();
    const existing = changeQueues.get(keyOf(target));
    if (existing !== undefined) return existing;
    changeQueues.set(keyOf(target), created);
    return created;
  });

  const notFound = (target: CanvasStore.CanvasTarget) =>
    new CanvasError({ reason: "not-found", canvas: target.name });

  const store = CanvasStore.CanvasStore.of({
    ensure: (input) =>
      Effect.sync(() => {
        const existing = folders.get(keyOf(input));
        if (existing !== undefined) return existing;
        const folder: CanvasStore.CanvasFolder = {
          threadId: input.threadId,
          name: input.name,
          path: `/canvases/${keyOf(input)}`,
          manifest: null,
          manifestIssue: "canvas.json is missing.",
        };
        folders.set(keyOf(input), folder);
        return folder;
      }),
    get: (target) => {
      const folder = folders.get(keyOf(target));
      return folder === undefined ? Effect.fail(notFound(target)) : Effect.succeed(folder);
    },
    list: (thread) =>
      Effect.sync(() =>
        Array.from(folders.values())
          .filter((folder) => folder.threadId === thread)
          .map((folder) => folder.name),
      ),
    changes: (target) => Stream.unwrap(Effect.map(changesOf(target), Stream.fromQueue)),
    resolveFile: (input) => Effect.succeed(`/canvases/${keyOf(input)}/${input.path}`),
    readState: (target) => Effect.sync(() => states.get(keyOf(target)) ?? null),
    writeState: ({ state, stateRevision, revealId, ...target }) =>
      Effect.sync(() => {
        states.set(keyOf(target), {
          state,
          stateRevision,
          ...(revealId === undefined ? {} : { revealId }),
        });
      }),
    remove: (target) =>
      Effect.sync(() => {
        folders.delete(keyOf(target));
        states.delete(keyOf(target));
      }),
    removeThread: () => Effect.void,
  });

  const port = CanvasThreadPort.CanvasThreadPort.of({
    deliver: ({ text }) =>
      Effect.sync(() => {
        delivered.push(text);
      }),
    workspaceRoot: () => Effect.succeed("/workspace"),
  });

  const random = SecureRandom.make((size) => {
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, ++ids);
    return bytes;
  });

  const layer = CanvasService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CanvasStore.CanvasStore, store),
        Layer.succeed(CanvasThreadPort.CanvasThreadPort, port),
        Layer.succeed(SecureRandom.SecureRandom, random),
      ),
    ),
  );

  const writeManifest = Effect.fnUntraced(function* (
    target: CanvasStore.CanvasTarget,
    manifest: CanvasManifest,
  ) {
    const folder = { ...folders.get(keyOf(target))!, manifest, manifestIssue: null };
    folders.set(keyOf(target), folder);
    yield* Queue.offer(yield* changesOf(target), folder);
  });

  return { layer, folders, states, delivered, writeManifest };
});

const follow = Effect.fnUntraced(function* (thread: ThreadId) {
  const canvases = yield* CanvasService.CanvasService;
  const items = yield* Queue.unbounded<CanvasStreamItem>();
  yield* canvases.stream(thread).pipe(
    Stream.runForEach((item) => Queue.offer(items, item)),
    Effect.forkScoped,
  );
  return items;
});

const reasonOf = <A, R>(effect: Effect.Effect<A, CanvasError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const click = (target: { readonly threadId: ThreadId; readonly name: CanvasName }, event: string) =>
  Effect.gen(function* () {
    const canvases = yield* CanvasService.CanvasService;
    const { snapshot } = yield* canvases.get(target);
    return yield* canvases.submitEvent({
      ...target,
      event,
      pageRevision: snapshot.pageRevision,
    });
  });

it.effect("merges patches into the state, bumping and persisting the revision", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      const opened = yield* canvases.open({
        ...board,
        title: "Board",
        state: { count: 1, filter: { owner: "me", done: false } },
      });
      expect(opened.snapshot).toMatchObject({
        title: "Board",
        pageRevision: 0,
        stateRevision: 1,
        functions: [],
        manifestIssue: "canvas.json is missing.",
      });
      expect(opened.path).toBe(harness.folders.get(keyOf(board))?.path);

      const patched = yield* canvases.patchState({
        ...board,
        patch: { filter: { owner: null, tags: ["a"] }, count: 2 },
      });
      expect(patched.stateRevision).toBe(2);
      expect(patched.state).toEqual({ count: 2, filter: { done: false, tags: ["a"] } });
      expect(harness.states.get(keyOf(board))).toEqual({
        state: patched.state,
        stateRevision: 2,
        revealId: patched.revealId,
      });

      const reopened = yield* canvases.open(board);
      expect(reopened.snapshot.revealId).not.toBe(opened.snapshot.revealId);
      expect(reopened.snapshot).toEqual({ ...patched, revealId: reopened.snapshot.revealId });
      expect((yield* canvases.get(board)).snapshot).toEqual(reopened.snapshot);

      expect((yield* canvases.open(notes)).snapshot).toMatchObject({
        title: "notes",
        state: {},
        stateRevision: 0,
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("rejects state over the size limit and keeps what was stored", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      const tooLarge = { blob: "x".repeat(CANVAS_STATE_MAX_BYTES) };
      yield* canvases.open({ ...board, state: { count: 1 } });

      expect(yield* reasonOf(canvases.patchState({ ...board, patch: tooLarge }))).toBe(
        "state-too-large",
      );
      expect(yield* reasonOf(canvases.open({ ...board, state: tooLarge }))).toBe("state-too-large");

      expect((yield* canvases.get(board)).snapshot).toMatchObject({
        state: { count: 1 },
        stateRevision: 1,
      });
      expect(harness.states.get(keyOf(board))).toMatchObject({
        state: { count: 1 },
        stateRevision: 1,
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("streams a snapshot and then every later change, losing none while subscribing", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      yield* canvases.open(board);
      const items = yield* follow(threadId);
      yield* Effect.forEach(
        [1, 2, 3],
        (count) => canvases.patchState({ ...board, patch: { count } }),
        { concurrency: "unbounded" },
      );

      const first = yield* Queue.take(items);
      if (first._tag !== "snapshot") throw new Error(`Expected a snapshot, got ${first._tag}.`);
      expect(first.canvases.map((canvas) => canvas.name)).toEqual(["board"]);
      const seen = first.canvases[0]!.stateRevision;

      yield* canvases.patchState({ ...board, patch: { count: 4 } });
      const updates = yield* Queue.takeN(items, 4 - seen);
      expect(
        updates.map((item) => (item._tag === "upsert" ? item.canvas.stateRevision : item._tag)),
      ).toEqual([1, 2, 3, 4].slice(seen));

      yield* canvases.close(board);
      expect(yield* Queue.take(items)).toEqual({ _tag: "removed", threadId, name: "board" });
      expect(yield* reasonOf(canvases.get(board))).toBe("not-found");
      expect(harness.folders.has(keyOf(board))).toBe(false);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("restores a thread's canvases from the store after a restart", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const shown = yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      yield* canvases.open({ ...board, state: { count: 1 } });
      yield* canvases.patchState({ ...board, patch: { count: 2 } });
      const openedNotes = yield* canvases.open(notes);
      return {
        board: (yield* canvases.get(board)).snapshot.revealId,
        notes: openedNotes.snapshot.revealId,
      };
    }).pipe(Effect.provide(harness.layer));

    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      const first = yield* Queue.take(yield* follow(threadId));
      expect(first).toMatchObject({
        _tag: "snapshot",
        canvases: [
          {
            name: "board",
            state: { count: 2 },
            stateRevision: 2,
            pageRevision: 0,
            revealId: shown.board,
          },
          { name: "notes", state: {}, stateRevision: 0, pageRevision: 0, revealId: shown.notes },
        ],
      });
      const patched = yield* canvases.patchState({ ...board, patch: { count: 3 } });
      expect(patched.stateRevision).toBe(3);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("bumps the page revision and rereads the manifest when the folder changes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      const opened = yield* canvases.open({ ...board, title: "Board", state: { count: 1 } });
      const items = yield* follow(threadId);
      yield* Queue.take(items);

      yield* harness.writeManifest(board, {
        title: "Deploys",
        functions: {
          refresh: { command: ["./functions/refresh"], kind: "read" },
          restart: { command: ["./functions/restart"], kind: "change" },
        },
      });

      const { manifestIssue: _, ...before } = opened.snapshot;
      expect(yield* Queue.take(items)).toEqual({
        _tag: "upsert",
        canvas: {
          ...before,
          title: "Deploys",
          pageRevision: 1,
          functions: [
            { name: "refresh", kind: "read" },
            { name: "restart", kind: "change" },
          ],
        },
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("rejects an event from a replaced page or with an oversized payload", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      yield* canvases.open(board);
      const items = yield* follow(threadId);
      yield* Queue.take(items);
      yield* harness.writeManifest(board, { title: "Board" });
      yield* Queue.take(items);

      expect(
        yield* reasonOf(canvases.submitEvent({ ...board, event: "save", pageRevision: 0 })),
      ).toBe("stale-page");
      expect(
        yield* reasonOf(
          canvases.submitEvent({
            ...board,
            event: "save",
            pageRevision: 1,
            payload: "x".repeat(CANVAS_EVENT_PAYLOAD_MAX_BYTES),
          }),
        ),
      ).toBe("event-too-large");
      expect(harness.delivered).toEqual([]);
      expect(yield* canvases.recentEvents(board)).toEqual([]);

      expect(
        yield* canvases.submitEvent({ ...board, event: "save", pageRevision: 1 }),
      ).toMatchObject({ delivery: "thread" });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("hands each event to a matching waiter or to the thread, exactly once", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      yield* canvases.open(board);
      yield* canvases.open(notes);

      const boardWait = yield* canvases
        .waitForEvent({ threadId, name: "board", timeout: Duration.minutes(1) })
        .pipe(Effect.forkChild({ startImmediately: true }));

      expect((yield* click(notes, "pin")).delivery).toBe("thread");
      expect(harness.delivered).toEqual(["[canvas notes] pin"]);

      const taken = yield* canvases.submitEvent({
        ...board,
        event: "save",
        payload: { id: 7 },
        pageRevision: 0,
      });
      expect(taken.delivery).toBe("waiter");
      const received = yield* Fiber.join(boardWait);
      expect(Option.getOrThrow(received)).toMatchObject({
        id: taken.eventId,
        name: "board",
        event: "save",
        payload: { id: 7 },
        pageRevision: 0,
        stateRevision: 0,
      });
      expect(harness.delivered).toHaveLength(1);

      const next = yield* click(board, "archive");
      expect(next.delivery).toBe("thread");
      expect(next.eventId).not.toBe(taken.eventId);
      expect(harness.delivered).toEqual(["[canvas notes] pin", "[canvas board] archive"]);

      const anyWait = yield* canvases
        .waitForEvent({ threadId, timeout: Duration.minutes(1) })
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect((yield* click(notes, "unpin")).delivery).toBe("waiter");
      expect(Option.getOrThrow(yield* Fiber.join(anyWait))).toMatchObject({ event: "unpin" });
      expect(harness.delivered).toHaveLength(2);

      expect((yield* canvases.recentEvents(board)).map((event) => event.event)).toEqual([
        "save",
        "archive",
      ]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("limits events per minute for each canvas and keeps the last 20", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      yield* canvases.open(board);
      yield* canvases.open(notes);

      yield* Effect.forEach(
        Array.from({ length: CANVAS_EVENTS_PER_MINUTE }, (_, index) => `click-${index}`),
        (event) => click(board, event),
      );
      expect(yield* reasonOf(click(board, "one-too-many"))).toBe("rate-limited");
      expect((yield* click(notes, "other-canvas")).delivery).toBe("thread");
      expect(harness.delivered).toHaveLength(CANVAS_EVENTS_PER_MINUTE + 1);

      const recent = yield* canvases.recentEvents(board);
      expect(recent.map((event) => event.event)).toEqual(
        Array.from({ length: 20 }, (_, index) => `click-${index + 10}`),
      );

      yield* TestClock.adjust("1 minute");
      expect((yield* click(board, "after-the-window")).delivery).toBe("thread");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a wait that times out or is interrupted leaves no waiter behind", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const canvases = yield* CanvasService.CanvasService;
      yield* canvases.open(board);
      const wait = canvases.waitForEvent({ threadId, name: "board", timeout: Duration.seconds(5) });

      const timedOut = yield* wait.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("5 seconds");
      expect(Option.isNone(yield* Fiber.join(timedOut))).toBe(true);
      expect((yield* click(board, "after-timeout")).delivery).toBe("thread");

      const interrupted = yield* wait.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(interrupted);
      expect((yield* click(board, "after-interrupt")).delivery).toBe("thread");

      expect(harness.delivered).toEqual([
        "[canvas board] after-timeout",
        "[canvas board] after-interrupt",
      ]);
      expect(
        yield* reasonOf(
          canvases.waitForEvent({ threadId, name: "gone", timeout: Duration.seconds(5) }),
        ),
      ).toBe("not-found");
    }).pipe(Effect.provide(harness.layer));
  }),
);
