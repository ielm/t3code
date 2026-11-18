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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as CanvasLibrary from "./CanvasLibrary.ts";
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
    /**
     * Creates a thread canvas from a saved one and asks clients to show it. Its state is `state`,
     * or empty. `as` names the new canvas; it takes the saved name otherwise. Never replaces a
     * canvas. One from the project library starts with its functions blocked, because its commands
     * came with the repository.
     */
    readonly openFrom: (input: {
      readonly threadId: ThreadId;
      readonly scope: CanvasLibrary.CanvasLibraryScope;
      readonly name: CanvasName;
      readonly as?: CanvasName | undefined;
      readonly title?: string | undefined;
      readonly state?: CanvasState | undefined;
    }) => Effect.Effect<CanvasOpened, CanvasError | CanvasLibrary.CanvasAlreadyExistsError>;
    /** Lets a canvas from the project library run its functions. The user's decision alone. */
    readonly trustFunctions: (target: CanvasTarget) => Effect.Effect<CanvasSnapshot, CanvasError>;
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
  /** What the folder held when `pageRevision` was last settled. `null` when it could not be read. */
  readonly fingerprint: string | null;
  readonly pageRevision: number;
  readonly stateRevision: number;
  readonly state: CanvasState;
  readonly revealId: string;
  readonly functionsBlocked: boolean;
  readonly events: ReadonlyArray<CanvasEvent>;
  readonly eventTimes: ReadonlyArray<number>;
  readonly watcher: Fiber.Fiber<void>;
}

interface EventWaiter {
  readonly name: CanvasName | undefined;
  /** `None` when the canvas it names was closed. */
  readonly event: Deferred.Deferred<Option.Option<CanvasEvent>>;
}

interface ThreadCanvases {
  readonly lock: Semaphore.Semaphore;
  readonly items: PubSub.PubSub<CanvasStreamItem>;
  readonly canvases: Map<CanvasName, LiveCanvas>;
  readonly waiters: Set<EventWaiter>;
  /** Where each closed canvas's pages stopped, so one recreated under the name starts past it. */
  readonly closedPageRevisions: Map<CanvasName, number>;
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
  ...(live.functionsBlocked ? { functionsBlocked: true } : {}),
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
  const library = yield* CanvasLibrary.CanvasLibrary;
  const port = yield* CanvasThreadPort.CanvasThreadPort;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
      closedPageRevisions: new Map(),
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

  // The one place state is written, so no write can drop the functions block.
  const persist = (live: Omit<LiveCanvas, "watcher">) =>
    store.writeState({
      threadId: live.folder.threadId,
      name: live.folder.name,
      state: live.state,
      stateRevision: live.stateRevision,
      revealId: live.revealId,
      functionsBlocked: live.functionsBlocked,
    });

  // Path, size and modification time of every file. A new watcher can replay the folder's
  // creation, so an emission alone does not mean the page has anything new to load.
  const fingerprintOf = (folderPath: string) =>
    fs.readDirectory(folderPath, { recursive: true }).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries.toSorted(), (entry) =>
          fs.stat(path.join(folderPath, entry)).pipe(
            Effect.map((info) =>
              info.type === "File"
                ? [`${entry}\0${info.size}\0${Option.getOrUndefined(info.mtime)?.getTime()}`]
                : [],
            ),
            Effect.orElseSucceed(() => []),
          ),
        ),
      ),
      Effect.map((files) => files.flat().join("\n")),
      Effect.orElseSucceed(() => null),
    );

  const watch = (thread: ThreadCanvases, target: CanvasTarget) =>
    store.changes(target).pipe(
      Stream.runForEach((folder) =>
        fingerprintOf(folder.path).pipe(
          Effect.flatMap((fingerprint) =>
            thread.lock.withPermits(1)(
              Effect.suspend(() => {
                const live = thread.canvases.get(target.name);
                if (live === undefined) return Effect.void;
                const changed = fingerprint === null || fingerprint !== live.fingerprint;
                return put(thread, {
                  ...live,
                  folder,
                  fingerprint,
                  pageRevision: live.pageRevision + (changed ? 1 : 0),
                });
              }),
            ),
          ),
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
      }).pipe(Effect.bind("fingerprint", ({ folder }) => fingerprintOf(folder.path))),
    );
    for (const { folder, persisted, freshRevealId, fingerprint } of stored) {
      const revealId = persisted?.revealId ?? freshRevealId;
      thread.canvases.set(folder.name, {
        folder,
        openTitle: undefined,
        fingerprint,
        pageRevision: 0,
        stateRevision: persisted?.stateRevision ?? 0,
        state: persisted?.state ?? {},
        revealId,
        functionsBlocked: persisted?.functionsBlocked === true,
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

  const hasRoomFor = (thread: ThreadCanvases, name: CanvasName) =>
    thread.canvases.has(name) || thread.canvases.size < CANVAS_MAX_PER_THREAD
      ? Effect.void
      : Effect.fail(new CanvasError({ reason: "too-many-canvases", canvas: name }));

  // Runs under the thread's lock, inside the span of the operation that took it.
  const openLocked = Effect.fnUntraced(function* (
    thread: ThreadCanvases,
    input: Parameters<CanvasService["Service"]["open"]>[0] & {
      /** Decides the block for a new canvas. An open one keeps what it has when this is absent. */
      readonly functionsBlocked?: boolean;
    },
  ) {
    const target = { threadId: input.threadId, name: input.name };
    const existing = thread.canvases.get(input.name);
    yield* hasRoomFor(thread, input.name);
    if (input.state !== undefined) yield* checkStateSize(input.name, input.state);
    const folder = yield* store.ensure({
      ...target,
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    const stored = existing ?? (yield* store.readState(target)) ?? { state: {}, stateRevision: 0 };
    const persisted =
      input.state === undefined
        ? { state: stored.state, stateRevision: stored.stateRevision }
        : { state: input.state, stateRevision: stored.stateRevision + 1 };
    const next = {
      folder,
      openTitle: input.title ?? existing?.openTitle,
      fingerprint:
        existing === undefined ? yield* fingerprintOf(folder.path) : existing.fingerprint,
      pageRevision:
        existing?.pageRevision ?? (thread.closedPageRevisions.get(input.name) ?? -1) + 1,
      ...persisted,
      revealId: yield* nextId,
      functionsBlocked: input.functionsBlocked ?? stored.functionsBlocked === true,
      events: existing?.events ?? [],
      eventTimes: existing?.eventTimes ?? [],
    };
    return yield* Effect.gen(function* () {
      yield* persist(next);
      const live: LiveCanvas = {
        ...next,
        watcher: existing?.watcher ?? (yield* watch(thread, target)),
      };
      yield* put(thread, live);
      return { snapshot: toSnapshot(live), path: folder.path };
    }).pipe(Effect.uninterruptible);
  });

  const open: CanvasService["Service"]["open"] = Effect.fn("CanvasService.open")(function* (input) {
    return yield* withThread(input.threadId, (thread) => openLocked(thread, input));
  });

  const openFrom: CanvasService["Service"]["openFrom"] = Effect.fn("CanvasService.openFrom")(
    function* (input) {
      // Copying under the lock keeps a restore or an open from watching the half-copied folder.
      return yield* withThread(input.threadId, (thread) =>
        Effect.gen(function* () {
          const name = input.as ?? input.name;
          yield* hasRoomFor(thread, name);
          if (input.state !== undefined) yield* checkStateSize(name, input.state);
          const folder = yield* library.instantiate({
            threadId: input.threadId,
            from: { scope: input.scope, name: input.name },
            as: input.as,
          });
          const target = { threadId: input.threadId, name: folder.name };
          return yield* openLocked(thread, {
            ...target,
            ...(input.title === undefined ? {} : { title: input.title }),
            state: input.state ?? {},
            functionsBlocked: input.scope === "project",
          }).pipe(Effect.onError(() => Effect.ignore(store.remove(target))));
        }),
      );
    },
  );

  const close: CanvasService["Service"]["close"] = Effect.fn("CanvasService.close")(
    function* (target) {
      yield* withThread(target.threadId, (thread) =>
        Effect.gen(function* () {
          const live = yield* requireLive(thread, target);
          yield* store.remove(target);
          yield* Fiber.interrupt(live.watcher);
          thread.canvases.delete(target.name);
          thread.closedPageRevisions.set(target.name, live.pageRevision);
          // Left waiting, it would take the first event of a canvas recreated under this name.
          for (const waiter of thread.waiters) {
            if (waiter.name !== target.name) continue;
            thread.waiters.delete(waiter);
            Deferred.doneUnsafe(waiter.event, Effect.succeedNone);
          }
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
          yield* persist(next).pipe(Effect.andThen(put(thread, next)), Effect.uninterruptible);
          return toSnapshot(next);
        }),
      );
    },
  );

  const trustFunctions: CanvasService["Service"]["trustFunctions"] = Effect.fn(
    "CanvasService.trustFunctions",
  )(function* (target) {
    return yield* withThread(target.threadId, (thread) =>
      Effect.gen(function* () {
        const live = yield* requireLive(thread, target);
        if (!live.functionsBlocked) return toSnapshot(live);
        const next = { ...live, functionsBlocked: false };
        yield* persist(next).pipe(Effect.andThen(put(thread, next)), Effect.uninterruptible);
        return toSnapshot(next);
      }),
    );
  });

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
          Deferred.doneUnsafe(waiter.event, Effect.succeedSome(event));
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
            event: yield* Deferred.make<Option.Option<CanvasEvent>>(),
          };
          thread.waiters.add(waiter);
          return { thread, waiter };
        }),
      ),
      ({ thread, waiter }) =>
        Deferred.await(waiter.event).pipe(
          Effect.timeoutOption(input.timeout),
          Effect.map(Option.flatten),
          // A timeout that finds its waiter already taken lost the race to an event or a close.
          Effect.filterOrElse(
            (event) => Option.isSome(event) || thread.waiters.delete(waiter),
            () => Deferred.await(waiter.event),
          ),
        ),
      ({ thread, waiter }, exit) =>
        thread.waiters.delete(waiter) || Exit.isSuccess(exit)
          ? Effect.void
          : // The event was handed over while this wait was being interrupted.
            Deferred.await(waiter.event).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (event) =>
                    port.deliver({
                      threadId: input.threadId,
                      text: formatCanvasEventMessage(event),
                    }),
                }),
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
    openFrom,
    close,
    get,
    patchState,
    trustFunctions,
    stream,
    submitEvent,
    waitForEvent,
    recentEvents,
  });
});

export const layer = Layer.effect(CanvasService, make);
