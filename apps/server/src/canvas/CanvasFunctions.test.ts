// @effect-diagnostics nodeBuiltinImport:off - a socket is how a held function reports that it started and that it died.
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CANVAS_FUNCTION_ARGS_MAX_BYTES,
  CANVAS_FUNCTION_CONCURRENCY,
  CANVAS_FUNCTION_OUTPUT_MAX_BYTES,
  CanvasError,
  type CanvasManifest,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandResolutionCache, SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CanvasFunctions from "./CanvasFunctions.ts";
import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

const threadId = ThreadId.make("thread:canvas-functions");
const name = "board";
const node = process.execPath;
const unused = () => Effect.die("unused by CanvasFunctions");

const REPORT_SCRIPT = `
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () =>
  console.log(
    JSON.stringify({
      args: JSON.parse(input),
      cwd: process.cwd(),
      canvasDir: process.env.T3_CANVAS_DIR,
      canvasName: process.env.T3_CANVAS_NAME,
      threadId: process.env.T3_THREAD_ID,
      inherited: process.env.PATH !== undefined,
    }),
  ),
);
`;

// The connection belongs to a grandchild, so it closes only when the whole process tree is gone.
const HOLD_SCRIPT = `
import { spawn } from "node:child_process";
spawn(
  process.execPath,
  ["-e", 'require("node:net").connect(process.argv[1]).on("error", () => process.exit(1))', process.argv[2]],
  { stdio: "ignore" },
);
setInterval(() => {}, 1000);
`;

/** Yields, per function that started holding, an effect that completes when its processes die. */
const holdServer = Effect.fn("holdServer")(function* (socketPath: string) {
  const held = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => {
        const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
        socket.on("error", () => {});
        socket.resume();
        Queue.offerUnsafe(
          held,
          Effect.promise(() => closed),
        );
      });
      server.listen(socketPath, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.sync(() => server.close()),
  );
  return held;
});

const harness = Effect.fn("harness")(function* (options?: { readonly manifest?: null }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  const canvasDir = path.join(root, "canvas");
  const workspace = path.join(root, "workspace");
  const socketPath = path.join(root, "hold.sock");
  const reportScript = path.join(root, "report.mjs");
  const holdScript = path.join(root, "hold.mjs");
  yield* fileSystem.makeDirectory(canvasDir);
  yield* fileSystem.makeDirectory(workspace);
  yield* fileSystem.writeFileString(reportScript, REPORT_SCRIPT);
  yield* fileSystem.writeFileString(holdScript, HOLD_SCRIPT);

  const manifest: CanvasManifest = {
    title: "Board",
    functions: {
      report: { command: [node, reportScript], kind: "read" },
      text: { command: [node, "-e", "console.log('  plain text  ')"], kind: "read" },
      save: { command: [node, reportScript], kind: "change" },
      fail: {
        command: [node, "-e", "console.error('boom: ' + 'e'.repeat(3000)); process.exit(3)"],
        kind: "read",
      },
      silentFail: { command: [node, "-e", "process.exit(4)"], kind: "read" },
      missing: { command: [path.join(root, "no-such-binary")], kind: "read" },
      flood: {
        command: [
          node,
          "-e",
          `process.stdout.write("x".repeat(${CANVAS_FUNCTION_OUTPUT_MAX_BYTES + 1})); setInterval(() => {}, 1000)`,
        ],
        kind: "read",
      },
      hold: { command: [node, holdScript, socketPath], kind: "read" },
      slow: { command: [node, holdScript, socketPath], kind: "read", timeoutSeconds: 1 },
      batch: { command: ["build", "--fast"], kind: "read" },
    },
  };
  const folder = (target: CanvasStore.CanvasTarget): CanvasStore.CanvasFolder => ({
    ...target,
    path: canvasDir,
    manifest: options?.manifest === null ? null : manifest,
    manifestIssue: options?.manifest === null ? "canvas.json is missing." : null,
  });

  const known = (target: CanvasStore.CanvasTarget) =>
    target.name === name || target.name === "other" || target.name === "from-project";
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let spawned = 0;
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          spawned += 1;
          return spawner.spawn(command);
        }),
      ),
    ),
    Layer.mock(CanvasService.CanvasService)({
      get: (target) =>
        known(target)
          ? Effect.succeed({
              snapshot: {
                ...target,
                title: "Board",
                pageRevision: 0,
                stateRevision: 0,
                state: {},
                functions: [],
                revealId: "reveal-1",
                ...(target.name === "from-project" ? { functionsBlocked: true } : {}),
              },
              path: canvasDir,
            })
          : Effect.fail(new CanvasError({ reason: "not-found", canvas: target.name })),
    }),
    Layer.succeed(
      CanvasStore.CanvasStore,
      CanvasStore.CanvasStore.of({
        get: (target) =>
          known(target)
            ? Effect.succeed(folder(target))
            : Effect.fail(new CanvasError({ reason: "not-found", canvas: target.name })),
        ensure: unused,
        list: unused,
        changes: () => Stream.die("unused by CanvasFunctions"),
        resolveFile: unused,
        readState: unused,
        writeState: unused,
        remove: unused,
        removeThread: unused,
      }),
    ),
    Layer.succeed(
      CanvasThreadPort.CanvasThreadPort,
      CanvasThreadPort.CanvasThreadPort.of({
        deliver: unused,
        workspaceRoot: () => Effect.succeed(workspace),
      }),
    ),
  );
  const context = yield* Layer.build(CanvasFunctions.layer.pipe(Layer.provide(dependencies)));
  const functions = Context.get(context, CanvasFunctions.CanvasFunctions);

  return {
    canvasDir,
    workspace,
    held: yield* holdServer(socketPath),
    spawned: () => spawned,
    call: (
      fn: string,
      input?: { readonly args?: unknown; readonly gesture?: boolean; readonly name?: string },
    ) =>
      functions.call({
        threadId,
        name: input?.name ?? name,
        function: fn,
        gesture: input?.gesture ?? false,
        ...(input?.args === undefined ? {} : { args: input.args }),
      }),
  };
});

const live = <A, E>(test: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  test.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const failure = (call: Effect.Effect<unknown, CanvasError>) =>
  call.pipe(Effect.andThen(Effect.die("expected the call to fail")), Effect.flip);

describe("CanvasFunctions", () => {
  it.live("runs a declared function in the workspace with its arguments and canvas env", () =>
    live(
      Effect.gen(function* () {
        const { call, canvasDir, workspace } = yield* harness();

        expect(yield* call("report", { args: { id: 7, tags: ["a"] } })).toEqual({
          args: { id: 7, tags: ["a"] },
          cwd: workspace,
          canvasDir,
          canvasName: name,
          threadId,
          inherited: true,
        });
        expect(yield* call("report")).toMatchObject({ args: null });
        expect(yield* call("text")).toBe("plain text");
      }),
    ),
  );

  it.live("runs nothing that the manifest does not declare", () =>
    live(
      Effect.gen(function* () {
        const declared = yield* harness();
        const noManifest = yield* harness({ manifest: null });

        expect((yield* failure(declared.call("toString"))).reason).toBe("function-not-declared");
        expect((yield* failure(noManifest.call("report"))).reason).toBe("function-not-declared");
        expect((yield* failure(declared.call("report", { name: "gone" }))).reason).toBe(
          "not-found",
        );
      }),
    ),
  );

  it.live("runs a change function only with a user gesture", () =>
    live(
      Effect.gen(function* () {
        const { call } = yield* harness();

        expect((yield* failure(call("save", { args: 1 }))).reason).toBe("function-needs-gesture");
        expect(yield* call("save", { args: 1, gesture: true })).toMatchObject({ args: 1 });
      }),
    ),
  );

  it.live("runs nothing for a canvas whose functions are blocked", () =>
    live(
      Effect.gen(function* () {
        const { call, spawned } = yield* harness();
        const blocked = { name: "from-project", gesture: true };

        expect((yield* failure(call("report", blocked))).reason).toBe("functions-blocked");
        expect((yield* failure(call("save", blocked))).reason).toBe("functions-blocked");
        expect(spawned()).toBe(0);
      }),
    ),
  );

  it.live("refuses a Windows batch file, which only a shell can run", () =>
    live(
      Effect.gen(function* () {
        const { call, spawned } = yield* harness();

        const refused = yield* failure(call("batch")).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(CommandResolutionCache, new Map()),
          Effect.provideService(SpawnExecutableResolution, () => "C:\\tools\\build.cmd"),
        );
        expect(refused).toMatchObject({
          reason: "function-failed",
          detail: "Batch files (.cmd and .bat) are not supported: a function runs without a shell.",
        });
        expect(spawned()).toBe(0);
      }),
    ),
  );

  it.live("rejects arguments over the size limit", () =>
    live(
      Effect.gen(function* () {
        const { call } = yield* harness();

        const error = yield* failure(
          call("report", { args: "x".repeat(CANVAS_FUNCTION_ARGS_MAX_BYTES) }),
        );
        expect(error.reason).toBe("function-args-too-large");
      }),
    ),
  );

  it.live("reports a failed function with the end of its stderr", () =>
    live(
      Effect.gen(function* () {
        const { call } = yield* harness();

        const failed = yield* failure(call("fail"));
        expect(failed.reason).toBe("function-failed");
        expect(failed.detail).toHaveLength(2000);
        expect(failed.detail?.trim().endsWith("eee")).toBe(true);
        expect(failed.detail).not.toContain("boom");

        expect(yield* failure(call("silentFail"))).toMatchObject({
          reason: "function-failed",
          detail: "exit code 4",
        });

        const missing = yield* failure(call("missing"));
        expect(missing).toMatchObject({ reason: "function-failed", detail: "NotFound" });
        expect(missing.cause).toBeDefined();
      }),
    ),
  );

  it.live("kills a function whose output passes the limit", () =>
    live(
      Effect.gen(function* () {
        const { call } = yield* harness();

        expect((yield* failure(call("flood"))).reason).toBe("function-output-too-large");
      }),
    ),
  );

  it.live("kills the process tree of a function that times out", () =>
    live(
      Effect.gen(function* () {
        const { call, held } = yield* harness();

        const fiber = yield* Effect.forkChild(failure(call("slow")));
        const died = yield* Queue.take(held);
        expect((yield* Fiber.join(fiber)).reason).toBe("function-timeout");
        yield* died;
      }),
    ),
  );

  it.live("kills the process tree when the call is interrupted", () =>
    live(
      Effect.gen(function* () {
        const { call, held } = yield* harness();

        const fiber = yield* Effect.forkChild(call("hold"));
        const died = yield* Queue.take(held);
        yield* Fiber.interrupt(fiber);
        yield* died;
      }),
    ),
  );

  it.live("fails an extra call at once while a canvas is at its concurrency limit", () =>
    live(
      Effect.gen(function* () {
        const { call, held } = yield* harness();

        const fibers = yield* Effect.forEach(
          Array.from({ length: CANVAS_FUNCTION_CONCURRENCY }),
          () => Effect.forkChild(call("hold")),
        );
        yield* Queue.takeN(held, CANVAS_FUNCTION_CONCURRENCY);

        expect((yield* failure(call("text"))).reason).toBe("function-busy");
        expect(yield* call("text", { name: "other" })).toBe("plain text");

        yield* Fiber.interruptAll(fibers);
        expect(yield* call("text")).toBe("plain text");
      }),
    ),
  );
});
