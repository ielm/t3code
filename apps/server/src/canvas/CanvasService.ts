import {
  CANVAS_EVENT_PAYLOAD_MAX_BYTES,
  CANVAS_EVENTS_PER_MINUTE,
  CANVAS_MAX_PER_THREAD,
  CANVAS_STATE_MAX_BYTES,
  CanvasError,
  type CanvasEvent,
  type CanvasEventDelivery,
  type CanvasEventName,
  type CanvasName,
  type CanvasSnapshot,
  type CanvasState,
  type CanvasStatePatch,
  type CanvasStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applyCanvasStatePatch,
  canvasJsonByteLength,
  formatCanvasEventMessage,
} from "@t3tools/shared/canvas";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

type CanvasTarget = CanvasStore.CanvasTarget;

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

const RECENT_EVENTS_KEPT = 20;
const EVENT_RATE_WINDOW_MILLIS = 60_000;

interface LiveCanvas {
  readonly folder: CanvasStore.CanvasFolder;
  readonly openTitle: string | undefined;
  readonly pageRevision: number;
  readonly stateRevision: number;
  readonly state: CanvasState;
  readonly revealId: string;
  readonly events: ReadonlyArray<CanvasEvent>;
  readonly eventTimes: ReadonlyArray<number>;
  readonly watcher: Fiber.Fiber<void>;
}

interface EventWaiter {
  readonly name: CanvasName | undefined;
  readonly event: Deferred.Deferred<CanvasEvent>;
}

interface ThreadCanvases {
  readonly lock: Semaphore.Semaphore;
  readonly items: PubSub.PubSub<CanvasStreamItem>;
  readonly canvases: Map<CanvasName, LiveCanvas>;
  readonly waiters: Set<EventWaiter>;
  restored: boolean;
}

const toSnapshot = (live: LiveCanvas): CanvasSnapshot => ({
  threadId: live.folder.threadId,
  name: live.folder.name,
  title: live.folder.manifest?.title ?? live.openTitle ?? live.folder.name,
  pageRevision: live.pageRevision,
  stateRevision: live.stateRevision,
  state: live.state,
  functions: Object.entries(live.folder.manifest?.functions ?? {}).map(([name, declaration]) => ({
    name,
    kind: declaration.kind,
  })),
  revealId: live.revealId,
  ...(live.folder.manifestIssue === null ? {} : { manifestIssue: live.folder.manifestIssue }),
});

const checkStateSize = (name: CanvasName, state: CanvasState) => {
  const size = canvasJsonByteLength(state);
  return size === null || size > CANVAS_STATE_MAX_BYTES
    ? Effect.fail(new CanvasError({ reason: "state-too-large", canvas: name }))
    : Effect.void;
};

const requireLive = (thread: ThreadCanvases, target: CanvasTarget) => {
  const live = thread.canvases.get(target.name);
  return live === undefined
    ? Effect.fail(new CanvasError({ reason: "not-found", canvas: target.name }))
    : Effect.succeed(live);
};

const make = Effect.gen(function* () {
  const store = yield* CanvasStore.CanvasStore;
  const port = yield* CanvasThreadPort.CanvasThreadPort;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Effect.scope;
  const threads = new Map<ThreadId, ThreadCanvases>();
  const nextId = random.uuidV4().pipe(Effect.orDie);

  const threadOf = Effect.fnUntraced(function* (threadId: ThreadId) {
    const created: ThreadCanvases = {
      lock: Semaphore.makeUnsafe(1),
      items: yield* PubSub.unbounded<CanvasStreamItem>(),
      canvases: new Map(),
      waiters: new Set(),
      restored: false,
    };
    const existing = threads.get(threadId);
    if (existing !== undefined) return existing;
    threads.set(threadId, created);
    return created;
  });

  const put = (thread: ThreadCanvases, live: LiveCanvas) =>
    Effect.suspend(() => {
      thread.canvases.set(live.folder.name, live);
      return PubSub.publish(thread.items, { _tag: "upsert", canvas: toSnapshot(live) });
    });

  const watch = (thread: ThreadCanvases, target: CanvasTarget) =>
    store.changes(target).pipe(
      Stream.runForEach((folder) =>
        thread.lock.withPermits(1)(
          Effect.suspend(() => {
            const live = thread.canvases.get(target.name);
            return live === undefined
              ? Effect.void
              : put(thread, { ...live, folder, pageRevision: live.pageRevision + 1 });
          }),
        ),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
    );

  const restore = Effect.fn("CanvasService.restore")(function* (
    threadId: ThreadId,
    thread: ThreadCanvases,
  ) {
    const names = yield* store.list(threadId);
    const stored = yield* Effect.forEach(names, (name) =>
      Effect.all({
        folder: store.get({ threadId, name }),
        persisted: store.readState({ threadId, name }),
        freshRevealId: nextId,
      }),
    );
    for (const { folder, persisted, freshRevealId } of stored) {
      const revealId = persisted?.revealId ?? freshRevealId;
      thread.canvases.set(folder.name, {
        folder,
        openTitle: undefined,
        pageRevision: 0,
        stateRevision: persisted?.stateRevision ?? 0,
        state: persisted?.state ?? {},
        revealId,
        events: [],
        eventTimes: [],
        watcher: yield* watch(thread, folder),
      });
    }
    thread.restored = true;
  });

  // Every read and write of a thread's canvases holds its lock, so stored state and published
  // items stay in the order the writes happened.
  const withThread = <A, E, R>(
    threadId: ThreadId,
    use: (thread: ThreadCanvases) => Effect.Effect<A, E, R>,
  ) =>
    threadOf(threadId).pipe(
      Effect.flatMap((thread) =>
        thread.lock.withPermits(1)(
          (thread.restored ? Effect.void : restore(threadId, thread)).pipe(
            Effect.andThen(Effect.suspend(() => use(thread))),
          ),
        ),
      ),
    );

  const open: CanvasService["Service"]["open"] = Effect.fn("CanvasService.open")(function* (input) {
    return yield* withThread(input.threadId, (thread) =>
      Effect.gen(function* () {
        const target = { threadId: input.threadId, name: input.name };
        const existing = thread.canvases.get(input.name);
        if (existing === undefined && thread.canvases.size >= CANVAS_MAX_PER_THREAD) {
          return yield* new CanvasError({ reason: "too-many-canvases", canvas: input.name });
        }
        if (input.state !== undefined) yield* checkStateSize(input.name, input.state);
        const folder = yield* store.ensure({
          ...target,
          ...(input.title === undefined ? {} : { title: input.title }),
        });
        const stored = existing ??
          (yield* store.readState(target)) ?? { state: {}, stateRevision: 0 };
        const persisted =
          input.state === undefined
            ? { state: stored.state, stateRevision: stored.stateRevision }
            : { state: input.state, stateRevision: stored.stateRevision + 1 };
        const revealId = yield* nextId;
        return yield* Effect.gen(function* () {
          yield* store.writeState({ ...target, ...persisted, revealId });
          const live: LiveCanvas = {
            folder,
            openTitle: input.title ?? existing?.openTitle,
            pageRevision: existing?.pageRevision ?? 0,
            ...persisted,
            revealId,
            events: existing?.events ?? [],
            eventTimes: existing?.eventTimes ?? [],
            watcher: existing?.watcher ?? (yield* watch(thread, target)),
          };
          yield* put(thread, live);
          return { snapshot: toSnapshot(live), path: folder.path };
        }).pipe(Effect.uninterruptible);
      }),
    );
  });

  const close: CanvasService["Service"]["close"] = Effect.fn("CanvasService.close")(
    function* (target) {
      yield* withThread(target.threadId, (thread) =>
        Effect.gen(function* () {
          const live = yield* requireLive(thread, target);
          yield* store.remove(target);
          yield* Fiber.interrupt(live.watcher);
          thread.canvases.delete(target.name);
          yield* PubSub.publish(thread.items, {
            _tag: "removed",
            threadId: target.threadId,
            name: target.name,
          });
        }).pipe(Effect.uninterruptible),
      );
    },
  );

  const get: CanvasService["Service"]["get"] = Effect.fn("CanvasService.get")(function* (target) {
    const live = yield* withThread(target.threadId, (thread) => requireLive(thread, target));
    return { snapshot: toSnapshot(live), path: live.folder.path };
  });

  const patchState: CanvasService["Service"]["patchState"] = Effect.fn("CanvasService.patchState")(
    function* (input) {
      return yield* withThread(input.threadId, (thread) =>
        Effect.gen(function* () {
          const live = yield* requireLive(thread, input);
          const state = applyCanvasStatePatch(live.state, input.patch);
          yield* checkStateSize(input.name, state);
          const next = { ...live, state, stateRevision: live.stateRevision + 1 };
          yield* store
            .writeState({
              threadId: input.threadId,
              name: input.name,
              state,
              stateRevision: next.stateRevision,
              revealId: next.revealId,
            })
            .pipe(Effect.andThen(put(thread, next)), Effect.uninterruptible);
          return toSnapshot(next);
        }),
      );
    },
  );

  const stream: CanvasService["Service"]["stream"] = (threadId) =>
    Stream.unwrap(
      // Subscribing under the lock every publish holds leaves no gap and no overlap between the
      // snapshot and the first update.
      withThread(threadId, (thread) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(thread.items);
          return Stream.concat(
            Stream.make<Array<CanvasStreamItem>>({
              _tag: "snapshot",
              canvases: Array.from(thread.canvases.values(), toSnapshot),
            }),
            Stream.fromSubscription(subscription),
          );
        }),
      ),
    ).pipe(Stream.scoped);

  const submitEvent: CanvasService["Service"]["submitEvent"] = Effect.fn(
    "CanvasService.submitEvent",
  )(function* (input) {
    const accepted = yield* withThread(input.threadId, (thread) =>
      Effect.gen(function* () {
        const live = yield* requireLive(thread, input);
        if (input.pageRevision !== live.pageRevision) {
          return yield* new CanvasError({ reason: "stale-page", canvas: input.name });
        }
        const size = canvasJsonByteLength(input.payload);
        if (size === null || size > CANVAS_EVENT_PAYLOAD_MAX_BYTES) {
          return yield* new CanvasError({ reason: "event-too-large", canvas: input.name });
        }
        const now = yield* Clock.currentTimeMillis;
        const eventTimes = live.eventTimes.filter((at) => at > now - EVENT_RATE_WINDOW_MILLIS);
        if (eventTimes.length >= CANVAS_EVENTS_PER_MINUTE) {
          return yield* new CanvasError({ reason: "rate-limited", canvas: input.name });
        }
        const event: CanvasEvent = {
          id: yield* nextId,
          threadId: input.threadId,
          name: input.name,
          event: input.event,
          ...(input.payload === undefined ? {} : { payload: input.payload }),
          pageRevision: live.pageRevision,
          stateRevision: live.stateRevision,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        };
        thread.canvases.set(input.name, {
          ...live,
          events: [...live.events, event].slice(-RECENT_EVENTS_KEPT),
          eventTimes: [...eventTimes, now],
        });
        // Taking the waiter and resolving it happen in one synchronous step, so a waiter that
        // finds itself taken can rely on its event having arrived.
        for (const waiter of thread.waiters) {
          if (waiter.name !== undefined && waiter.name !== input.name) continue;
          thread.waiters.delete(waiter);
          Deferred.doneUnsafe(waiter.event, Effect.succeed(event));
          return { event, delivery: "waiter" as const };
        }
        return { event, delivery: "thread" as const };
      }),
    );
    if (accepted.delivery === "thread") {
      yield* port.deliver({
        threadId: input.threadId,
        text: formatCanvasEventMessage(accepted.event),
      });
    }
    return { eventId: accepted.event.id, delivery: accepted.delivery };
  });

  const waitForEvent: CanvasService["Service"]["waitForEvent"] = Effect.fn(
    "CanvasService.waitForEvent",
  )(function* (input) {
    return yield* Effect.acquireUseRelease(
      withThread(input.threadId, (thread) =>
        Effect.gen(function* () {
          if (input.name !== undefined) {
            yield* requireLive(thread, { threadId: input.threadId, name: input.name });
          }
          const waiter: EventWaiter = {
            name: input.name,
            event: yield* Deferred.make<CanvasEvent>(),
          };
          thread.waiters.add(waiter);
          return { thread, waiter };
        }),
      ),
      ({ thread, waiter }) =>
        Deferred.await(waiter.event).pipe(
          Effect.timeoutOption(input.timeout),
          // A timeout that finds its waiter already taken lost the race to an event.
          Effect.filterOrElse(
            (event) => Option.isSome(event) || thread.waiters.delete(waiter),
            () => Effect.asSome(Deferred.await(waiter.event)),
          ),
        ),
      ({ thread, waiter }, exit) =>
        thread.waiters.delete(waiter) || Exit.isSuccess(exit)
          ? Effect.void
          : // The event was handed over while this wait was being interrupted.
            Deferred.await(waiter.event).pipe(
              Effect.flatMap((event) =>
                port.deliver({ threadId: input.threadId, text: formatCanvasEventMessage(event) }),
              ),
              Effect.ignoreCause({ log: true }),
            ),
    );
  });

  const recentEvents: CanvasService["Service"]["recentEvents"] = Effect.fn(
    "CanvasService.recentEvents",
  )(function* (target) {
    const live = yield* withThread(target.threadId, (thread) => requireLive(thread, target));
    return live.events;
  });

  return CanvasService.of({
    open,
    close,
    get,
    patchState,
    stream,
    submitEvent,
    waitForEvent,
    recentEvents,
  });
});

export const layer = Layer.effect(CanvasService, make);
