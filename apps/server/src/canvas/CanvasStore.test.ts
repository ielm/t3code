import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CANVAS_MAX_PER_THREAD,
  CanvasName,
  CanvasRelativePath,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as CanvasStore from "./CanvasStore.ts";

const layerTest = CanvasStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-canvas-store-" })),
  Layer.provideMerge(NodeServices.layer),
);

const threadId = ThreadId.make("codex:thread/1%2F:a");
const target = { threadId, name: CanvasName.make("board") };
const file = (path: string) => ({ ...target, path: CanvasRelativePath.make(path) });

it.layer(layerTest)("CanvasStore", (it) => {
  it.effect("creates a canvas with a starter page and reuses it without overwriting", () =>
    Effect.gen(function* () {
      const store = yield* CanvasStore.CanvasStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig;

      const created = yield* store.ensure({ ...target, title: "  Sprint <board>  " });
      expect(created.manifest).toEqual({ title: "Sprint <board>" });
      expect(created.manifestIssue).toBeNull();
      expect(path.dirname(path.dirname(created.path))).toBe(path.join(stateDir, "canvases"));
      expect(path.basename(path.dirname(created.path))).toMatch(/^[0-9a-f]+$/);
      const page = yield* fs.readFileString(path.join(created.path, "index.html"));
      expect(page).toContain("<h1>Sprint &lt;board&gt;</h1>");

      yield* fs.writeFileString(path.join(created.path, "index.html"), "edited");
      const reused = yield* store.ensure({ ...target, title: "Other" });
      expect(reused).toEqual(created);
      expect(yield* fs.readFileString(path.join(created.path, "index.html"))).toBe("edited");
      expect(yield* store.get(target)).toEqual(created);
      expect(yield* store.list(threadId)).toEqual(["board"]);

      yield* store.remove(target);
    }),
  );

  it.effect("fails get with not-found for a canvas that was never created", () =>
    Effect.gen(function* () {
      const store = yield* CanvasStore.CanvasStore;
      const error = yield* store
        .get({ ...target, name: CanvasName.make("absent") })
        .pipe(Effect.flip);
      expect(error.reason).toBe("not-found");
    }),
  );

  it.effect("reports a missing or invalid manifest as data", () =>
    Effect.gen(function* () {
      const store = yield* CanvasStore.CanvasStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* store.ensure(target);
      const manifestPath = path.join(folder.path, "canvas.json");

      yield* fs.writeFileString(manifestPath, "{ not json");
      const unparsable = yield* store.get(target);
      expect(unparsable.manifest).toBeNull();
      expect(unparsable.manifestIssue).toMatch(/^canvas\.json is invalid: /);

      yield* fs.writeFileString(
        manifestPath,
        JSON.stringify({
          title: "Board",
          functions: { "bad-name": { command: ["ls"], kind: "read" } },
        }),
      );
      const invalid = yield* store.get(target);
      expect(invalid.manifest).toBeNull();
      expect(invalid.manifestIssue).toMatch(/^canvas\.json is invalid: /);
      expect(invalid.manifestIssue?.length).toBeLessThanOrEqual(200);

      yield* fs.remove(manifestPath);
      const missing = yield* store.get(target);
      expect(missing.manifest).toBeNull();
      expect(missing.manifestIssue).toBe("canvas.json is missing.");

      yield* store.remove(target);
    }),
  );

  it.effect("refuses a canvas beyond the per-thread limit", () =>
    Effect.gen(function* () {
      const store = yield* CanvasStore.CanvasStore;
      const crowded = ThreadId.make("crowded");
      const names = Array.from({ length: CANVAS_MAX_PER_THREAD }, (_, index) =>
        CanvasName.make(`canvas-${index}`),
      );
      yield* Effect.forEach(names, (name) => store.ensure({ threadId: crowded, name }), {
        concurrency: "unbounded",
      });

      const error = yield* store
        .ensure({ threadId: crowded, name: CanvasName.make("one-more") })
        .pipe(Effect.flip);
      expect(error.reason).toBe("too-many-canvases");
      expect(yield* store.list(crowded)).toEqual(names);
      yield* store.ensure({ threadId: crowded, name: names[0]! });

      yield* store.removeThread(crowded);
    }),
  );

  it.effect("round-trips state beside the folder and keeps it out of the canvas list", () =>
    Effect.gen(function* () {
      const store = yield* CanvasStore.CanvasStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* store.ensure(target);

      expect(yield* store.readState(target)).toBeNull();
      yield* store.writeState({ ...target, state: { count: 1 }, stateRevision: 1 });
      yield* store.writeState({
        ...target,
        state: { count: 2, nested: { a: [1] } },
        stateRevision: 2,
      });
      expect(yield* store.readState(target)).toEqual({
        state: { count: 2, nested: { a: [1] } },
        stateRevision: 2,
      });
      expect(yield* fs.readDirectory(folder.path)).not.toContain("board.state.json");
      expect(yield* fs.exists(path.join(path.dirname(folder.path), "board.state.json"))).toBe(true);
      expect(yield* store.list(threadId)).toEqual(["board"]);

      yield* fs.writeFileString(path.join(path.dirname(folder.path), "board.state.json"), "[]");
      expect((yield* store.readState(target).pipe(Effect.flip)).reason).toBe("storage-failed");

      yield* store.remove(target);
    }),
  );

  it.effect("resolves files inside the folder and refuses every escape", () =>
    Effect.gen(function* () {
      const store = yield* CanvasStore.CanvasStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* store.ensure(target);
      const realFolder = yield* fs.realPath(folder.path);
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-canvas-outside-" });
      yield* fs.writeFileString(path.join(outside, "secret.txt"), "secret");
      yield* fs.symlink(path.join(outside, "secret.txt"), path.join(folder.path, "leak.txt"));
      yield* fs.symlink(outside, path.join(folder.path, "linked"));
      yield* fs.symlink(path.join(outside, "not-yet"), path.join(folder.path, "dangling"));
      yield* fs.symlink(path.join(folder.path, "index.html"), path.join(folder.path, "alias.html"));

      expect(yield* store.resolveFile(file("index.html"))).toBe(
        path.join(realFolder, "index.html"),
      );
      expect(yield* store.resolveFile(file("alias.html"))).toBe(
        path.join(realFolder, "index.html"),
      );
      expect(yield* store.resolveFile(file("parts/new/chart.js"))).toBe(
        path.join(realFolder, "parts", "new", "chart.js"),
      );

      const escapes = [
        "../board.state.json",
        "parts/../../other/index.html",
        path.join(outside, "secret.txt"),
        "leak.txt",
        "linked/secret.txt",
        "linked/new.txt",
        "dangling",
      ];
      const reasons = yield* Effect.forEach(escapes, (escape) =>
        store.resolveFile({ ...target, path: escape as CanvasRelativePath }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        ),
      );
      expect(reasons).toEqual(escapes.map(() => "invalid-path"));

      const missing = yield* store
        .resolveFile({ ...file("index.html"), name: CanvasName.make("absent") })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("not-found");

      yield* store.remove(target);
    }),
  );

  it.effect("removes one canvas with its state, then a whole thread", () =>
    Effect.gen(function* () {
      const store = yield* CanvasStore.CanvasStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const other = { threadId, name: CanvasName.make("notes") };
      const folder = yield* store.ensure(target);
      yield* store.ensure(other);
      yield* store.writeState({ ...target, state: { a: 1 }, stateRevision: 1 });
      yield* store.writeState({ ...other, state: { b: 1 }, stateRevision: 1 });

      yield* store.remove(target);
      yield* store.remove(target);
      expect(yield* store.list(threadId)).toEqual(["notes"]);
      expect(yield* store.readState(target)).toBeNull();
      expect((yield* store.get(target).pipe(Effect.flip)).reason).toBe("not-found");
      expect(yield* store.readState(other)).toEqual({ state: { b: 1 }, stateRevision: 1 });

      yield* store.removeThread(threadId);
      yield* store.removeThread(threadId);
      expect(yield* store.list(threadId)).toEqual([]);
      expect(yield* fs.exists(path.dirname(folder.path))).toBe(false);
    }),
  );
});

describe("CanvasStore.changes", () => {
  const makeWatchReady = Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const fs = yield* FileSystem.FileSystem;
    const observed = FileSystem.FileSystem.of({
      ...fs,
      watch: (path, options) =>
        fs.watch(path, {
          ...options,
          onReady: () => {
            options?.onReady?.();
            Deferred.doneUnsafe(ready, Exit.void);
          },
        }),
    });
    return { ready, observed };
  });

  // The debounce runs on the wall clock because the events come from a real OS watcher.
  it.live("emits the reloaded folder after a burst of edits and stays quiet on state writes", () =>
    Effect.gen(function* () {
      const { ready, observed } = yield* makeWatchReady;
      yield* Effect.gen(function* () {
        const store = yield* CanvasStore.CanvasStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* store.ensure(target);
        const manifestPath = path.join(folder.path, "canvas.json");

        const emissions = yield* store.changes(target).pipe(
          Stream.takeUntil((changed) => changed.manifest?.title === "Edited"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        yield* store.writeState({ ...target, state: { quiet: true }, stateRevision: 1 });
        yield* fs.makeDirectory(path.join(folder.path, "parts"));
        yield* fs.writeFileString(path.join(folder.path, "parts", "chart.js"), "1");
        yield* fs.writeFileString(path.join(folder.path, "index.html"), "<p>edited</p>");
        yield* fs.writeFileString(manifestPath, JSON.stringify({ title: "Draft" }));
        yield* fs.writeFileString(manifestPath, JSON.stringify({ title: "Edited" }));

        // macOS can replay the folder's creation to a new watcher, so an emission may precede the burst.
        const titles = (yield* Fiber.join(emissions)).map((changed) => changed.manifest?.title);
        expect(titles.at(-1)).toBe("Edited");
        expect(titles).not.toContain("Draft");
        expect(titles.length).toBeLessThanOrEqual(2);
      }).pipe(
        // The outer layer memoizes the store built on the unobserved file system.
        Effect.provide(Layer.fresh(CanvasStore.layer)),
        Effect.provideService(FileSystem.FileSystem, observed),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
