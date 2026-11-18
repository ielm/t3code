import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as CanvasLibrary from "./CanvasLibrary.ts";
import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

const threadId = ThreadId.make("thread:canvas-library");

const threadPortLayer = Layer.effect(
  CanvasThreadPort.CanvasThreadPort,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3code-canvas-library-workspace-" }),
    );
    return CanvasThreadPort.CanvasThreadPort.of({
      deliver: () => Effect.die("unused by CanvasLibrary"),
      workspaceRoot: () => Effect.succeed(workspace),
    });
  }),
);

const layerWith = (env: Record<string, string>) =>
  CanvasLibrary.layer.pipe(
    Layer.provideMerge(CanvasStore.layer),
    Layer.provideMerge(threadPortLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-canvas-library-" })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Layer.provideMerge(NodeServices.layer),
  );

const services = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* CanvasThreadPort.CanvasThreadPort;
  const { baseDir } = yield* ServerConfig;
  return {
    library: yield* CanvasLibrary.CanvasLibrary,
    store: yield* CanvasStore.CanvasStore,
    fs,
    path,
    projectDir: path.join(yield* threads.workspaceRoot(threadId), ".canvases"),
    personalDir: path.join(baseDir, "canvases"),
  };
});

const writeFiles = Effect.fn("test.writeFiles")(function* (
  folder: string,
  files: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(folder, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, contents);
  }
});

it.effect("lists both libraries, tolerating bad manifests and missing directories", () =>
  Effect.gen(function* () {
    const { library, fs, path, projectDir, personalDir } = yield* services;
    expect(yield* library.list({ threadId })).toEqual([]);

    yield* writeFiles(projectDir, {
      "burndown/canvas.json": JSON.stringify({ title: "Burndown", description: "Sprint chart" }),
      "no-manifest/index.html": "<p>bare</p>",
      "Not A Canvas/canvas.json": JSON.stringify({ title: "Ignored" }),
      "a-file": "not a folder",
    });
    yield* writeFiles(personalDir, {
      "broken/canvas.json": "{ not json",
      "notes/canvas.json": JSON.stringify({ title: "Notes" }),
    });
    yield* fs.symlink(path.join(personalDir, "notes"), path.join(personalDir, "linked"));

    expect(yield* library.list({ threadId })).toEqual([
      {
        scope: "project",
        name: "burndown",
        title: "Burndown",
        description: "Sprint chart",
        path: path.join(projectDir, "burndown"),
      },
      {
        scope: "project",
        name: "no-manifest",
        title: "no-manifest",
        description: null,
        path: path.join(projectDir, "no-manifest"),
      },
      {
        scope: "personal",
        name: "broken",
        title: "broken",
        description: null,
        path: path.join(personalDir, "broken"),
      },
      {
        scope: "personal",
        name: "notes",
        title: "Notes",
        description: null,
        path: path.join(personalDir, "notes"),
      },
    ]);
    expect(yield* library.resolve({ threadId, scope: "personal", name: "notes" })).toBe(
      path.join(personalDir, "notes"),
    );
    const linked = yield* library
      .resolve({ threadId, scope: "personal", name: "linked" })
      .pipe(Effect.flip);
    expect(linked.reason).toBe("not-found");
  }).pipe(Effect.provide(layerWith({}))),
);

it.effect(
  "saves a thread canvas without its state or symlinks, and overwrites only on request",
  () =>
    Effect.gen(function* () {
      const { library, store, fs, path, projectDir } = yield* services;
      const target = { threadId, name: "board" };
      const folder = yield* store.ensure({ ...target, title: "Board" });
      yield* writeFiles(folder.path, {
        "index.html": "first",
        "parts/card.html": "<article></article>",
        "functions/stale.js": "old",
      });
      yield* fs.symlink(path.join(folder.path, "index.html"), path.join(folder.path, "link.html"));
      yield* fs.symlink(path.join(folder.path, "parts"), path.join(folder.path, "linked-parts"));
      yield* store.writeState({ ...target, state: { column: "done" }, stateRevision: 3 });

      const saved = yield* library.save({ ...target, to: "project" });
      const savedDir = path.join(projectDir, "board");
      expect(saved).toEqual({
        scope: "project",
        name: "board",
        title: "Board",
        description: null,
        path: savedDir,
      });
      expect(yield* library.list({ threadId })).toEqual([saved]);
      expect(yield* fs.readDirectory(projectDir)).toEqual(["board"]);
      expect((yield* fs.readDirectory(savedDir, { recursive: true })).toSorted()).toEqual([
        "canvas.json",
        "functions",
        "functions/stale.js",
        "index.html",
        "parts",
        "parts/card.html",
      ]);

      yield* fs.remove(path.join(folder.path, "functions"), { recursive: true });
      yield* fs.writeFileString(path.join(folder.path, "index.html"), "second");
      const refused = yield* library.save({ ...target, to: "project" }).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(CanvasLibrary.CanvasAlreadyExistsError);
      expect(refused).toMatchObject({ scope: "project", canvas: "board" });
      expect(yield* fs.readFileString(path.join(savedDir, "index.html"))).toBe("first");

      yield* library.save({ ...target, to: "project", overwrite: true });
      expect(yield* fs.readFileString(path.join(savedDir, "index.html"))).toBe("second");
      expect(yield* fs.exists(path.join(savedDir, "functions"))).toBe(false);
      expect(yield* fs.readDirectory(projectDir)).toEqual(["board"]);

      yield* library.save({ ...target, to: "personal", as: "kanban" });
      expect((yield* library.list({ threadId })).map((entry) => entry.name)).toEqual([
        "board",
        "kanban",
      ]);
    }).pipe(Effect.provide(layerWith({}))),
);

it.effect("refuses names and library directories that lead outside the library", () =>
  Effect.gen(function* () {
    const { library, store, fs, path, projectDir, personalDir } = yield* services;
    yield* store.ensure({ threadId, name: "board" });

    const escaped = yield* library
      .save({ threadId, name: "board", to: "personal", as: "../escaped" })
      .pipe(Effect.flip);
    expect(escaped).toMatchObject({ _tag: "CanvasError", reason: "invalid-path" });
    expect(yield* fs.exists(path.join(path.dirname(personalDir), "escaped"))).toBe(false);
    const removed = yield* library
      .remove({ threadId, scope: "personal", name: ".." })
      .pipe(Effect.flip);
    expect(removed.reason).toBe("invalid-path");

    const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-canvas-elsewhere-" });
    yield* fs.symlink(elsewhere, projectDir);
    const linked = yield* library
      .save({ threadId, name: "board", to: "project" })
      .pipe(Effect.flip);
    expect(linked).toMatchObject({ _tag: "CanvasError", reason: "invalid-path" });
    expect(yield* fs.readDirectory(elsewhere)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layerWith({}))),
);

it.effect("instantiates a saved canvas as a thread canvas with empty state", () =>
  Effect.gen(function* () {
    const { library, store, fs, path, personalDir } = yield* services;
    yield* writeFiles(path.join(personalDir, "notes"), {
      "canvas.json": JSON.stringify({ title: "Notes" }),
      "index.html": "saved page",
      "parts/row.html": "<li></li>",
    });
    yield* fs.symlink(
      path.join(personalDir, "notes", "index.html"),
      path.join(personalDir, "notes", "link.html"),
    );

    const created = yield* library.instantiate({
      threadId,
      from: { scope: "personal", name: "notes" },
      as: "todo",
    });
    expect(created).toEqual(yield* store.get({ threadId, name: "todo" }));
    expect(created.manifest).toEqual({ title: "Notes" });
    expect((yield* fs.readDirectory(created.path, { recursive: true })).toSorted()).toEqual([
      "canvas.json",
      "index.html",
      "parts",
      "parts/row.html",
    ]);
    expect(yield* fs.readFileString(path.join(created.path, "index.html"))).toBe("saved page");
    expect(yield* store.readState({ threadId, name: "todo" })).toBeNull();
    expect(yield* store.list(threadId)).toEqual(["todo"]);

    yield* fs.writeFileString(path.join(created.path, "index.html"), "edited in thread");
    const refused = yield* library
      .instantiate({ threadId, from: { scope: "personal", name: "notes" }, as: "todo" })
      .pipe(Effect.flip);
    expect(refused).toBeInstanceOf(CanvasLibrary.CanvasAlreadyExistsError);
    expect(refused).toMatchObject({ scope: "thread", canvas: "todo" });
    expect(yield* fs.readFileString(path.join(created.path, "index.html"))).toBe(
      "edited in thread",
    );

    const missing = yield* library
      .instantiate({ threadId, from: { scope: "project", name: "absent" } })
      .pipe(Effect.flip);
    expect(missing).toMatchObject({ _tag: "CanvasError", reason: "not-found" });
    expect(yield* store.list(threadId)).toEqual(["todo"]);
  }).pipe(Effect.provide(layerWith({}))),
);

it.effect("removes a saved canvas and succeeds when it is already gone", () =>
  Effect.gen(function* () {
    const { library, path, personalDir } = yield* services;
    yield* writeFiles(path.join(personalDir, "notes"), { "index.html": "page" });
    const saved = { threadId, scope: "personal" as const, name: "notes" };

    yield* library.remove(saved);
    expect(yield* library.list({ threadId })).toEqual([]);
    expect((yield* library.resolve(saved).pipe(Effect.flip)).reason).toBe("not-found");
    yield* library.remove(saved);
  }).pipe(Effect.provide(layerWith({}))),
);

it.effect("keeps the personal library in T3CODE_CANVAS_LIBRARY_DIR when it is set", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const override = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3code-canvas-library-override-" }),
    );

    yield* Effect.gen(function* () {
      const { library, store, personalDir } = yield* services;
      yield* store.ensure({ threadId, name: "board" });
      const saved = yield* library.save({ threadId, name: "board", to: "personal" });
      expect(saved.path).toBe(path.join(override, "board"));
      expect(yield* library.list({ threadId })).toEqual([saved]);
      expect(yield* fs.exists(personalDir)).toBe(false);
    }).pipe(Effect.provide(layerWith({ T3CODE_CANVAS_LIBRARY_DIR: override })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
