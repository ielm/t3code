import {
  CANVAS_DEFAULT_ENTRY,
  CANVAS_MANIFEST_FILE,
  CANVAS_MAX_PER_THREAD,
  CanvasError,
  CanvasManifest,
  CanvasName,
  CanvasState,
  NonNegativeInt,
  type CanvasRelativePath,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";

export interface CanvasTarget {
  readonly threadId: ThreadId;
  readonly name: CanvasName;
}

export interface CanvasFolder extends CanvasTarget {
  /** Absolute path of the folder the agent edits. */
  readonly path: string;
  /** `null` when `canvas.json` is missing or invalid; `manifestIssue` then says why. */
  readonly manifest: CanvasManifest | null;
  readonly manifestIssue: string | null;
}

export interface CanvasPersistedState {
  readonly state: CanvasState;
  readonly stateRevision: number;
  /** Kept so a server restart does not look like a new request to show the canvas. */
  readonly revealId?: string | undefined;
  /** Set on a canvas copied from the project library, until the user enables its functions. */
  readonly functionsBlocked?: boolean | undefined;
}

/**
 * Canvas folders on disk. A thread canvas lives under the server state directory, in a folder this
 * fork owns. Its state file sits beside the folder, not inside it, so copying the folder to a
 * library never carries state along.
 */
export class CanvasStore extends Context.Service<
  CanvasStore,
  {
    /** Creates the folder with a starter page and manifest when it does not exist yet. */
    readonly ensure: (
      input: CanvasTarget & { readonly title?: string },
    ) => Effect.Effect<CanvasFolder, CanvasError>;
    /** Fails with `not-found` when the folder does not exist. */
    readonly get: (target: CanvasTarget) => Effect.Effect<CanvasFolder, CanvasError>;
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CanvasName>, CanvasError>;
    /** Emits the reloaded folder after its files change, debounced. Never emits on state writes. */
    readonly changes: (target: CanvasTarget) => Stream.Stream<CanvasFolder, CanvasError>;
    /** Absolute path of a file inside the folder. Fails with `invalid-path` on any escape. */
    readonly resolveFile: (
      input: CanvasTarget & { readonly path: CanvasRelativePath },
    ) => Effect.Effect<string, CanvasError>;
    /** `null` when no state was ever written. */
    readonly readState: (
      target: CanvasTarget,
    ) => Effect.Effect<CanvasPersistedState | null, CanvasError>;
    readonly writeState: (
      input: CanvasTarget & CanvasPersistedState,
    ) => Effect.Effect<void, CanvasError>;
    /** Deletes the folder and its state. Succeeds when it is already gone. */
    readonly remove: (target: CanvasTarget) => Effect.Effect<void, CanvasError>;
    readonly removeThread: (threadId: ThreadId) => Effect.Effect<void, CanvasError>;
  }
>()("t3/canvas/CanvasStore") {}

const CHANGE_DEBOUNCE = Duration.millis(100);
const STARTER_TITLE_MAX_LENGTH = 120;
const MANIFEST_ISSUE_MAX_LENGTH = 200;
// writeFileStringAtomically stages in a sibling directory with this prefix; a crash can leave one behind.
const ATOMIC_WRITE_TEMP_PREFIX = "t3-write-";

const isCanvasName = Schema.is(CanvasName);

const PersistedStateJson = Schema.fromJsonString(
  Schema.Struct({
    state: CanvasState,
    stateRevision: NonNegativeInt,
    revealId: Schema.optional(Schema.String),
    functionsBlocked: Schema.optional(Schema.Boolean),
  }),
);
const decodePersistedState = Schema.decodeUnknownEffect(PersistedStateJson);
const encodePersistedState = Schema.encodeEffect(PersistedStateJson);
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(CanvasManifest));

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const starterManifest = (title: string) => `${JSON.stringify({ title }, null, 2)}\n`;

const starterPage = (title: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <pre id="state"></pre>
    </main>
    <script>
      canvas.onState((state) => {
        document.getElementById("state").textContent = JSON.stringify(state, null, 2);
      });
    </script>
  </body>
</html>
`;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const canvasesDir = path.join(stateDir, "canvases");
  const ensureLock = yield* Semaphore.make(1);

  // Lowercase hex of the id's UTF-8 bytes: injective, and safe on case-insensitive filesystems.
  const threadDir = (threadId: ThreadId) =>
    path.join(canvasesDir, Buffer.from(threadId, "utf8").toString("hex"));
  const folderPath = (target: CanvasTarget) => path.join(threadDir(target.threadId), target.name);
  const statePath = (target: CanvasTarget) =>
    path.join(threadDir(target.threadId), `${target.name}.state.json`);

  const storageFailed = (canvas?: string) => (cause: unknown) =>
    new CanvasError({
      reason: "storage-failed",
      ...(canvas === undefined ? {} : { canvas }),
      cause,
    });
  const notFoundOrStorageFailed = (canvas: string) => (cause: PlatformError.PlatformError) =>
    isNotFound(cause)
      ? new CanvasError({ reason: "not-found", canvas })
      : storageFailed(canvas)(cause);

  const isWithin = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  // lstat, not stat: a link is reported as a link and never followed.
  const entryType = (target: string) =>
    fs.lstat(target).pipe(
      Effect.map((info) => Option.some(info.type)),
      Effect.catchIf(isNotFound, () => Effect.succeedNone),
    );

  // The thread's directory is checked too: a link there would make every folder under it foreign.
  const hasRealRoot = Effect.fnUntraced(function* (target: CanvasTarget) {
    for (const directory of [threadDir(target.threadId), folderPath(target)]) {
      const type = yield* entryType(directory);
      if (Option.isNone(type) || type.value !== "Directory") return false;
    }
    return true;
  });

  const loadManifest = Effect.fn("CanvasStore.loadManifest")(function* (target: CanvasTarget) {
    const manifestPath = path.join(folderPath(target), CANVAS_MANIFEST_FILE);
    const type = yield* entryType(manifestPath).pipe(Effect.mapError(storageFailed(target.name)));
    // A linked manifest would hand the function runner commands from outside the folder.
    if (Option.isSome(type) && type.value !== "File") {
      return { manifest: null, manifestIssue: `${CANVAS_MANIFEST_FILE} is not a regular file.` };
    }
    const raw = yield* fs.readFileString(manifestPath).pipe(
      Effect.asSome,
      Effect.catchIf(isNotFound, () => Effect.succeedNone),
      Effect.mapError(storageFailed(target.name)),
    );
    if (Option.isNone(raw)) {
      return { manifest: null, manifestIssue: `${CANVAS_MANIFEST_FILE} is missing.` };
    }
    return yield* decodeManifest(raw.value).pipe(
      Effect.map((manifest) => ({ manifest, manifestIssue: null })),
      Effect.catchTags({
        SchemaError: (error) =>
          Effect.succeed({
            manifest: null,
            manifestIssue: `${CANVAS_MANIFEST_FILE} is invalid: ${error.message}`
              .replaceAll(/\s+/g, " ")
              .slice(0, MANIFEST_ISSUE_MAX_LENGTH),
          }),
      }),
    );
  });

  const get: CanvasStore["Service"]["get"] = Effect.fn("CanvasStore.get")(function* (target) {
    if (!(yield* hasRealRoot(target).pipe(Effect.mapError(storageFailed(target.name))))) {
      return yield* new CanvasError({ reason: "not-found", canvas: target.name });
    }
    return {
      threadId: target.threadId,
      name: target.name,
      path: folderPath(target),
      ...(yield* loadManifest(target)),
    };
  });

  const list: CanvasStore["Service"]["list"] = Effect.fn("CanvasStore.list")(function* (threadId) {
    const directory = threadDir(threadId);
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(storageFailed()),
    );
    const names = entries
      .filter(isCanvasName)
      .filter((name) => !name.startsWith(ATOMIC_WRITE_TEMP_PREFIX))
      .toSorted();
    // The same test `get` applies, so a restore never lists a canvas it then cannot load.
    const real = yield* Effect.forEach(names, (name) =>
      hasRealRoot({ threadId, name }).pipe(Effect.mapError(storageFailed(name))),
    );
    return names.filter((_, index) => real[index]);
  });

  const writeIfAbsent = (filePath: string, contents: string) =>
    fs.writeFileString(filePath, contents, { flag: "wx" }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );

  const ensure: CanvasStore["Service"]["ensure"] = Effect.fn("CanvasStore.ensure")(
    function* (input) {
      const folder = folderPath(input);
      const [thread, inPlace] = yield* Effect.all([
        entryType(threadDir(input.threadId)),
        entryType(folder),
      ]).pipe(Effect.mapError(storageFailed(input.name)));
      // Creating under a linked thread directory would write outside the state directory.
      const linkedThread = Option.isSome(thread) && thread.value !== "Directory";
      if (Option.isNone(inPlace) && !linkedThread) {
        const existing = yield* list(input.threadId);
        if (existing.length >= CANVAS_MAX_PER_THREAD) {
          return yield* new CanvasError({ reason: "too-many-canvases", canvas: input.name });
        }
        const title =
          (input.title ?? "").trim().slice(0, STARTER_TITLE_MAX_LENGTH).trim() || input.name;
        yield* fs
          .makeDirectory(folder, { recursive: true })
          .pipe(
            Effect.andThen(
              writeIfAbsent(path.join(folder, CANVAS_MANIFEST_FILE), starterManifest(title)),
            ),
            Effect.andThen(
              writeIfAbsent(path.join(folder, CANVAS_DEFAULT_ENTRY), starterPage(title)),
            ),
            Effect.mapError(storageFailed(input.name)),
          );
      }
      return yield* get(input);
    },
    (effect) => ensureLock.withPermits(1)(effect),
  );

  const changes: CanvasStore["Service"]["changes"] = (target) =>
    fs.watch(folderPath(target), { recursive: true }).pipe(
      Stream.mapError(notFoundOrStorageFailed(target.name)),
      // A save emits several events, and fs.watch can fire before content is flushed.
      Stream.debounce(CHANGE_DEBOUNCE),
      Stream.mapEffect(() =>
        get(target).pipe(
          Effect.asSome,
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.succeedNone,
          ),
        ),
      ),
      Stream.takeWhile(Option.isSome),
      Stream.map((folder) => folder.value),
    );

  const resolveFile: CanvasStore["Service"]["resolveFile"] = Effect.fn("CanvasStore.resolveFile")(
    function* (input) {
      const folder = folderPath(input);
      const invalidPath = new CanvasError({ reason: "invalid-path", canvas: input.name });
      const requested = path.resolve(folder, input.path);
      if (requested === folder || !isWithin(folder, requested)) {
        return yield* invalidPath;
      }
      // Without this a linked folder's target would become the root every check below trusts.
      if (!(yield* hasRealRoot(input).pipe(Effect.mapError(storageFailed(input.name))))) {
        return yield* new CanvasError({ reason: "not-found", canvas: input.name });
      }
      const realFolder = yield* fs
        .realPath(folder)
        .pipe(Effect.mapError(notFoundOrStorageFailed(input.name)));

      let existing = requested;
      const missing: Array<string> = [];
      while (true) {
        const real = yield* fs.realPath(existing).pipe(
          Effect.asSome,
          Effect.catchIf(isNotFound, () => Effect.succeedNone),
          Effect.mapError(storageFailed(input.name)),
        );
        if (Option.isSome(real)) {
          if (!isWithin(realFolder, real.value)) {
            return yield* invalidPath;
          }
          return path.join(real.value, ...missing);
        }
        // A dangling link would send a later write wherever it points.
        const isLink = yield* fs.readLink(existing).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (isLink) {
          return yield* invalidPath;
        }
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    },
  );

  const readState: CanvasStore["Service"]["readState"] = Effect.fn("CanvasStore.readState")(
    function* (target) {
      const raw = yield* fs.readFileString(statePath(target)).pipe(
        Effect.asSome,
        Effect.catchIf(isNotFound, () => Effect.succeedNone),
        Effect.mapError(storageFailed(target.name)),
      );
      if (Option.isNone(raw)) {
        return null;
      }
      return yield* decodePersistedState(raw.value).pipe(
        Effect.mapError(storageFailed(target.name)),
      );
    },
  );

  const writeState: CanvasStore["Service"]["writeState"] = Effect.fn("CanvasStore.writeState")(
    function* (input) {
      const contents = yield* encodePersistedState({
        state: input.state,
        stateRevision: input.stateRevision,
        ...(input.revealId === undefined ? {} : { revealId: input.revealId }),
        ...(input.functionsBlocked === true ? { functionsBlocked: true } : {}),
      }).pipe(Effect.mapError(storageFailed(input.name)));
      yield* writeFileStringAtomically({ filePath: statePath(input), contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(storageFailed(input.name)),
      );
    },
  );

  const remove: CanvasStore["Service"]["remove"] = Effect.fn("CanvasStore.remove")(
    function* (target) {
      yield* fs
        .remove(folderPath(target), { recursive: true, force: true })
        .pipe(
          Effect.andThen(fs.remove(statePath(target), { force: true })),
          Effect.mapError(storageFailed(target.name)),
        );
    },
  );

  const removeThread: CanvasStore["Service"]["removeThread"] = Effect.fn(
    "CanvasStore.removeThread",
  )(function* (threadId) {
    yield* fs
      .remove(threadDir(threadId), { recursive: true, force: true })
      .pipe(Effect.mapError(storageFailed()));
  });

  return CanvasStore.of({
    ensure,
    get,
    list,
    changes,
    resolveFile,
    readState,
    writeState,
    remove,
    removeThread,
  });
});

export const layer = Layer.effect(CanvasStore, make);
