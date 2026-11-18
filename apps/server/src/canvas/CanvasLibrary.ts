import {
  CANVAS_MANIFEST_FILE,
  CanvasError,
  CanvasManifest,
  CanvasName,
  CanvasScope,
  type ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

export type CanvasLibraryScope = Exclude<CanvasScope, "thread">;

export interface CanvasLibraryEntry {
  readonly scope: CanvasLibraryScope;
  readonly name: CanvasName;
  /** The manifest title, or the folder name when `canvas.json` is missing or invalid. */
  readonly title: string;
  readonly description: string | null;
  /** Absolute path of the saved folder. */
  readonly path: string;
}

export class CanvasAlreadyExistsError extends Schema.TaggedError<CanvasAlreadyExistsError>()(
  "CanvasAlreadyExistsError",
  {
    scope: CanvasScope,
    canvas: CanvasName,
  },
) {
  override get message(): string {
    return this.scope === "thread"
      ? "This thread already has a canvas with that name."
      : `The ${this.scope} library already has a canvas with that name.`;
  }
}

/** A client has no use for the server's path. */
export const toWireEntry = ({ path: _, ...entry }: CanvasLibraryEntry) => entry;

/** `CanvasError` is the only canvas failure on the wire, so a transport folds this one into it. */
export const toCanvasError = (error: CanvasError | CanvasAlreadyExistsError) =>
  error._tag === "CanvasAlreadyExistsError"
    ? new CanvasError({ reason: "already-exists", canvas: error.canvas })
    : error;

/**
 * Saved canvases. `project` is `.canvases/` in the thread's workspace, versioned with the repo;
 * `personal` is `canvases/` in the T3 home, or `T3CODE_CANVAS_LIBRARY_DIR`.
 */
export class CanvasLibrary extends Context.Service<
  CanvasLibrary,
  {
    /** Project entries, then personal ones, each sorted by name. */
    readonly list: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<CanvasLibraryEntry>, CanvasError>;
    /** Absolute path of a saved folder. Fails with `not-found` when it does not exist. */
    readonly resolve: (input: {
      readonly threadId: ThreadId;
      readonly scope: CanvasLibraryScope;
      readonly name: CanvasName;
    }) => Effect.Effect<string, CanvasError>;
    /** Copies a thread canvas's files, never its state, into a library. */
    readonly save: (input: {
      readonly threadId: ThreadId;
      readonly name: CanvasName;
      readonly to: CanvasLibraryScope;
      readonly as?: CanvasName | undefined;
      readonly overwrite?: boolean | undefined;
    }) => Effect.Effect<CanvasLibraryEntry, CanvasError | CanvasAlreadyExistsError>;
    /** Creates a thread canvas from a saved one. Never replaces an existing thread canvas. */
    readonly instantiate: (input: {
      readonly threadId: ThreadId;
      readonly from: { readonly scope: CanvasLibraryScope; readonly name: CanvasName };
      readonly as?: CanvasName | undefined;
    }) => Effect.Effect<CanvasStore.CanvasFolder, CanvasError | CanvasAlreadyExistsError>;
    /** Deletes a saved canvas. Succeeds when it is already gone. */
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly scope: CanvasLibraryScope;
      readonly name: CanvasName;
    }) => Effect.Effect<void, CanvasError>;
  }
>()("t3/canvas/CanvasLibrary") {}

const PROJECT_LIBRARY_DIRECTORY = ".canvases";
const PERSONAL_LIBRARY_DIRECTORY = "canvases";
// Starts with a dot so a directory left behind by a crash is never a valid canvas name.
const STAGING_PREFIX = ".canvas-copy-";

const personalLibraryDirOverride = Config.String("T3CODE_CANVAS_LIBRARY_DIR").pipe(
  Config.option,
  Effect.orDie,
);

const isCanvasName = Schema.is(CanvasName);
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(CanvasManifest));
const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CanvasStore.CanvasStore;
  const threads = yield* CanvasThreadPort.CanvasThreadPort;
  const { baseDir } = yield* ServerConfig;
  const personalDir = Option.match(
    Option.filter(yield* personalLibraryDirOverride, (directory) => directory.trim() !== ""),
    {
      onNone: () => path.join(baseDir, PERSONAL_LIBRARY_DIRECTORY),
      onSome: (directory) => path.resolve(directory),
    },
  );
  const writeLock = yield* Semaphore.make(1);

  const storageFailed = (canvas?: string) => (cause: unknown) =>
    new CanvasError({
      reason: "storage-failed",
      ...(canvas === undefined ? {} : { canvas }),
      cause,
    });

  // lstat, not stat: a link is reported as a link and never followed.
  const entryType = (target: string) =>
    fs.lstat(target).pipe(
      Effect.map((info) => Option.some(info.type)),
      Effect.catchIf(isNotFound, () => Effect.succeedNone),
    );

  // The helpers below run inside one service operation and share its span.
  const libraryDir = Effect.fnUntraced(function* (threadId: ThreadId, scope: CanvasLibraryScope) {
    if (scope === "personal") {
      return personalDir;
    }
    const directory = path.join(yield* threads.workspaceRoot(threadId), PROJECT_LIBRARY_DIRECTORY);
    // A cloned repository can ship `.canvases` as a link to anywhere on the machine.
    const type = yield* entryType(directory).pipe(Effect.mapError(storageFailed()));
    if (Option.isSome(type) && type.value !== "Directory") {
      return yield* new CanvasError({ reason: "invalid-path" });
    }
    return directory;
  });

  const locate = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly scope: CanvasLibraryScope;
    readonly name: string;
  }) {
    if (!isCanvasName(input.name)) {
      return yield* new CanvasError({ reason: "invalid-path" });
    }
    return path.join(yield* libraryDir(input.threadId, input.scope), input.name);
  });

  const describe = Effect.fnUntraced(function* (
    scope: CanvasLibraryScope,
    folder: string,
    name: CanvasName,
  ) {
    const manifestPath = path.join(folder, CANVAS_MANIFEST_FILE);
    const manifest = yield* Effect.gen(function* () {
      const info = yield* fs.lstat(manifestPath);
      if (info.type !== "File") {
        return undefined;
      }
      return yield* decodeManifest(yield* fs.readFileString(manifestPath));
    }).pipe(Effect.orElseSucceed(() => undefined));
    return {
      scope,
      name,
      title: manifest?.title ?? name,
      description: manifest?.description ?? null,
      path: folder,
    } satisfies CanvasLibraryEntry;
  });

  const listScope = Effect.fnUntraced(function* (threadId: ThreadId, scope: CanvasLibraryScope) {
    const directory = yield* libraryDir(threadId, scope);
    const names = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(storageFailed()),
    );
    const entries = yield* Effect.forEach(names.filter(isCanvasName).toSorted(), (name) => {
      const folder = path.join(directory, name);
      return entryType(folder).pipe(
        Effect.mapError(storageFailed(name)),
        Effect.flatMap((type) =>
          Option.isSome(type) && type.value === "Directory"
            ? Effect.asSome(describe(scope, folder, name))
            : Effect.succeedNone,
        ),
      );
    });
    return entries.flatMap(Option.toArray);
  });

  const copyTree: (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError> =
    Effect.fnUntraced(function* (from, to) {
      yield* fs.makeDirectory(to, { recursive: true });
      for (const entry of yield* fs.readDirectory(from)) {
        const source = path.join(from, entry);
        const info = yield* fs.lstat(source);
        if (info.type === "Directory") {
          yield* copyTree(source, path.join(to, entry));
        } else if (info.type === "File") {
          yield* fs.copyFile(source, path.join(to, entry));
        }
      }
    });

  const copyIntoPlace = Effect.fnUntraced(function* (source: string, target: string) {
    const parent = path.dirname(target);
    yield* fs.makeDirectory(parent, { recursive: true });
    const staged = yield* fs.makeTempDirectory({ directory: parent, prefix: STAGING_PREFIX });
    const replaced = `${staged}-replaced`;
    yield* Effect.gen(function* () {
      yield* copyTree(source, staged);
      const hadTarget = Option.isSome(yield* entryType(target));
      if (hadTarget) {
        yield* fs.rename(target, replaced);
      }
      yield* fs
        .rename(staged, target)
        .pipe(
          Effect.tapError(() =>
            hadTarget ? Effect.ignore(fs.rename(replaced, target)) : Effect.void,
          ),
        );
      yield* Effect.ignore(fs.remove(replaced, { recursive: true, force: true }));
    }).pipe(Effect.ensuring(Effect.ignore(fs.remove(staged, { recursive: true, force: true }))));
  });

  const list: CanvasLibrary["Service"]["list"] = Effect.fn("CanvasLibrary.list")(function* (input) {
    return [
      ...(yield* listScope(input.threadId, "project")),
      ...(yield* listScope(input.threadId, "personal")),
    ];
  });

  const resolve: CanvasLibrary["Service"]["resolve"] = Effect.fn("CanvasLibrary.resolve")(
    function* (input) {
      const folder = yield* locate(input);
      const type = yield* entryType(folder).pipe(Effect.mapError(storageFailed(input.name)));
      if (Option.isNone(type) || type.value !== "Directory") {
        return yield* new CanvasError({ reason: "not-found", canvas: input.name });
      }
      return folder;
    },
  );

  const save: CanvasLibrary["Service"]["save"] = Effect.fn("CanvasLibrary.save")(
    function* (input) {
      const name = input.as ?? input.name;
      const target = yield* locate({ threadId: input.threadId, scope: input.to, name });
      const source = yield* store.get({ threadId: input.threadId, name: input.name });
      if (input.overwrite !== true) {
        const existing = yield* entryType(target).pipe(Effect.mapError(storageFailed(name)));
        if (Option.isSome(existing)) {
          return yield* new CanvasAlreadyExistsError({ scope: input.to, canvas: name });
        }
      }
      yield* copyIntoPlace(source.path, target).pipe(Effect.mapError(storageFailed(name)));
      return yield* describe(input.to, target, name);
    },
    (effect) => writeLock.withPermits(1)(effect),
  );

  const instantiate: CanvasLibrary["Service"]["instantiate"] = Effect.fn(
    "CanvasLibrary.instantiate",
  )(
    function* (input) {
      const name = input.as ?? input.from.name;
      if (!isCanvasName(name)) {
        return yield* new CanvasError({ reason: "invalid-path" });
      }
      const source = yield* resolve({ threadId: input.threadId, ...input.from });
      const target = { threadId: input.threadId, name };
      const existing = yield* store.get(target).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeedNone,
        ),
      );
      if (Option.isSome(existing)) {
        return yield* new CanvasAlreadyExistsError({ scope: "thread", canvas: name });
      }
      const created = yield* store.ensure(target);
      yield* copyIntoPlace(source, created.path).pipe(
        Effect.mapError(storageFailed(name)),
        Effect.onError(() => Effect.ignore(store.remove(target))),
      );
      return yield* store.get(target);
    },
    (effect) => writeLock.withPermits(1)(effect),
  );

  const remove: CanvasLibrary["Service"]["remove"] = Effect.fn("CanvasLibrary.remove")(
    function* (input) {
      const folder = yield* locate(input);
      yield* fs
        .remove(folder, { recursive: true, force: true })
        .pipe(Effect.mapError(storageFailed(input.name)));
    },
    (effect) => writeLock.withPermits(1)(effect),
  );

  return CanvasLibrary.of({ list, resolve, save, instantiate, remove });
});

export const layer = Layer.effect(CanvasLibrary, make);
