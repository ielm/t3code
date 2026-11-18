import {
  CANVAS_FUNCTION_ARGS_MAX_BYTES,
  CANVAS_FUNCTION_CONCURRENCY,
  CANVAS_FUNCTION_DEFAULT_TIMEOUT_SECONDS,
  CANVAS_FUNCTION_OUTPUT_MAX_BYTES,
  CanvasError,
  type CanvasFunctionDeclaration,
  type CanvasFunctionName,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CanvasService from "./CanvasService.ts";
import * as CanvasStore from "./CanvasStore.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

/**
 * Runs the functions a canvas declares in `canvas.json`. Nothing undeclared ever runs, and nothing
 * at all while the canvas's functions are blocked.
 */
export class CanvasFunctions extends Context.Service<
  CanvasFunctions,
  {
    /**
     * Resolves with the function's stdout, parsed as JSON when it parses and returned as a string
     * otherwise. A `change` function fails with `function-needs-gesture` unless `gesture` is true,
     * and every function fails with `functions-blocked` until the user trusts the canvas.
     */
    readonly call: (
      input: CanvasStore.CanvasTarget & {
        readonly function: CanvasFunctionName;
        readonly args?: unknown;
        readonly gesture: boolean;
      },
    ) => Effect.Effect<unknown, CanvasError>;
  }
>()("t3/canvas/CanvasFunctions") {}

const STDERR_DETAIL_MAX_CHARS = 2000;
// Keep a function that ignores SIGTERM from holding its concurrency slot.
const FORCE_KILL_AFTER = "1 second";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const encodeArgs = Schema.encodeEffect(UnknownJson);
const decodeOutput = Schema.decodeUnknownOption(UnknownJson);

const runFunction = Effect.fn("CanvasFunctions.runFunction")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: {
    readonly canvas: string;
    readonly declaration: CanvasFunctionDeclaration;
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly stdin: string;
  },
): Effect.fn.Return<unknown, CanvasError, Scope.Scope> {
  const failed = (detail: string, cause?: unknown) =>
    new CanvasError({
      reason: "function-failed",
      canvas: input.canvas,
      detail: detail.slice(-STDERR_DETAIL_MAX_CHARS),
      ...(cause === undefined ? {} : { cause }),
    });
  const platformFailed = (cause: PlatformError.PlatformError) => failed(cause.reason._tag, cause);

  const [command, ...args] = input.declaration.command;
  const resolved = yield* resolveSpawnCommand(command, args, { env: input.env, extendEnv: true });
  // The resolver can run a Windows batch file only through cmd.exe, and a function gets no shell.
  if (resolved.shell) {
    return yield* failed(
      "Batch files (.cmd and .bat) are not supported: a function runs without a shell.",
    );
  }
  const child = yield* spawner
    .spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: input.cwd,
        env: input.env,
        extendEnv: true,
        shell: false,
        forceKillAfter: FORCE_KILL_AFTER,
      }),
    )
    .pipe(
      Effect.mapError(platformFailed),
      // A synchronous spawn throw arrives as a defect.
      Effect.catchDefect((cause) => Effect.fail(failed("Unknown", cause))),
    );

  const stdout = child.stdout.pipe(
    Stream.mapError(platformFailed),
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }),
      (state, chunk) => {
        const bytes = state.bytes + chunk.byteLength;
        if (bytes > CANVAS_FUNCTION_OUTPUT_MAX_BYTES) {
          return Effect.fail(
            new CanvasError({ reason: "function-output-too-large", canvas: input.canvas }),
          );
        }
        state.chunks.push(chunk);
        return Effect.succeed({ chunks: state.chunks, bytes });
      },
    ),
    Effect.map((state) => Buffer.concat(state.chunks, state.bytes).toString("utf8")),
  );
  const stderr = child.stderr.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (tail, text) => (tail + text).slice(-STDERR_DETAIL_MAX_CHARS),
    ),
    Effect.mapError(platformFailed),
  );
  // A function that exits without reading its arguments breaks the pipe; its exit code decides.
  const stdin = Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
    Effect.ignore,
  );

  const [output, errorTail] = yield* Effect.all([stdout, stderr, stdin], {
    concurrency: "unbounded",
  });
  const exitCode = yield* child.exitCode.pipe(Effect.mapError(platformFailed));
  if (exitCode !== 0) {
    return yield* failed(errorTail.trim() === "" ? `exit code ${exitCode}` : errorTail);
  }
  return Option.getOrElse(decodeOutput(output), () => output.trim());
});

const make = Effect.gen(function* () {
  const store = yield* CanvasStore.CanvasStore;
  const canvases = yield* CanvasService.CanvasService;
  const threads = yield* CanvasThreadPort.CanvasThreadPort;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const running = new Map<string, number>();

  const call: CanvasFunctions["Service"]["call"] = Effect.fn("CanvasFunctions.call")(
    function* (input) {
      const target = { threadId: input.threadId, name: input.name };
      const folder = yield* store.get(target);
      // Asked after the manifest is read: a canvas replaced in between is then seen as blocked.
      const { snapshot } = yield* canvases.get(target);
      if (snapshot.functionsBlocked === true) {
        return yield* new CanvasError({ reason: "functions-blocked", canvas: input.name });
      }
      const functions = folder.manifest?.functions ?? {};
      const declaration = Object.hasOwn(functions, input.function)
        ? functions[input.function]
        : undefined;
      if (declaration === undefined) {
        return yield* new CanvasError({ reason: "function-not-declared", canvas: input.name });
      }
      if (declaration.kind === "change" && !input.gesture) {
        return yield* new CanvasError({ reason: "function-needs-gesture", canvas: input.name });
      }
      const stdin = yield* encodeArgs(input.args ?? null).pipe(
        Effect.mapError(
          (cause) =>
            new CanvasError({
              reason: "function-failed",
              canvas: input.name,
              detail: "The arguments are not JSON.",
              cause,
            }),
        ),
      );
      if (Buffer.byteLength(stdin) > CANVAS_FUNCTION_ARGS_MAX_BYTES) {
        return yield* new CanvasError({ reason: "function-args-too-large", canvas: input.name });
      }

      const slot = `${input.name}/${input.threadId}`;
      const acquire = Effect.suspend(() => {
        const count = running.get(slot) ?? 0;
        if (count >= CANVAS_FUNCTION_CONCURRENCY) {
          return Effect.fail(new CanvasError({ reason: "function-busy", canvas: input.name }));
        }
        running.set(slot, count + 1);
        return Effect.void;
      });
      const release = Effect.sync(() => {
        const count = (running.get(slot) ?? 1) - 1;
        if (count > 0) running.set(slot, count);
        else running.delete(slot);
      });

      return yield* Effect.acquireUseRelease(
        acquire,
        () =>
          threads.workspaceRoot(input.threadId).pipe(
            Effect.flatMap((cwd) =>
              runFunction(spawner, {
                canvas: input.name,
                declaration,
                cwd,
                env: {
                  T3_CANVAS_DIR: folder.path,
                  T3_CANVAS_NAME: input.name,
                  T3_THREAD_ID: input.threadId,
                },
                stdin,
              }).pipe(
                Effect.scoped,
                Effect.timeoutOrElse({
                  duration: Duration.seconds(
                    declaration.timeoutSeconds ?? CANVAS_FUNCTION_DEFAULT_TIMEOUT_SECONDS,
                  ),
                  orElse: () =>
                    Effect.fail(
                      new CanvasError({ reason: "function-timeout", canvas: input.name }),
                    ),
                }),
              ),
            ),
          ),
        () => release,
      );
    },
  );

  return CanvasFunctions.of({ call });
});

export const layer = Layer.effect(CanvasFunctions, make);
