import type { CanvasName, ThreadId } from "@t3tools/contracts";
import { CANVAS_LOG_ENTRY_MAX_LENGTH, CANVAS_LOG_MAX_ENTRIES } from "@t3tools/shared/canvas";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface CanvasTarget {
  readonly threadId: ThreadId;
  readonly name: CanvasName;
}

export type CanvasDiagnosticLevel = "error" | "warning";

export interface CanvasDiagnosticEntry {
  readonly level: CanvasDiagnosticLevel;
  readonly text: string;
  /** When the entry last happened. */
  readonly at: string;
  /** How many times in a row it happened, when more than once. */
  readonly count?: number;
}

export interface CanvasDiagnosticsReport {
  /** The page the entries came from; 0 when nothing was recorded. */
  readonly pageRevision: number;
  readonly entries: ReadonlyArray<CanvasDiagnosticEntry>;
}

/**
 * What a canvas page logged as errors and warnings, kept in memory so the agent can read them and
 * fix its own page. Only the newest page revision's entries are kept.
 */
export class CanvasDiagnostics extends Context.Service<
  CanvasDiagnostics,
  {
    /** An entry from a page older than the newest one seen is dropped. */
    readonly record: (
      input: CanvasTarget & {
        readonly pageRevision: number;
        readonly level: CanvasDiagnosticLevel;
        readonly text: string;
      },
    ) => Effect.Effect<void>;
    /** Oldest first. */
    readonly recent: (target: CanvasTarget) => Effect.Effect<CanvasDiagnosticsReport>;
    readonly clear: (target: CanvasTarget) => Effect.Effect<void>;
    readonly clearThread: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/canvas/CanvasDiagnostics") {}

const make = () => {
  const threads = new Map<ThreadId, Map<CanvasName, CanvasDiagnosticsReport>>();

  const record: CanvasDiagnostics["Service"]["record"] = Effect.fn("CanvasDiagnostics.record")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const canvases =
        threads.get(input.threadId) ?? new Map<CanvasName, CanvasDiagnosticsReport>();
      const current = canvases.get(input.name);
      if (current !== undefined && input.pageRevision < current.pageRevision) return;
      const kept = current?.pageRevision === input.pageRevision ? current.entries : [];
      const last = kept.at(-1);
      const entry = {
        level: input.level,
        text: input.text.slice(0, CANVAS_LOG_ENTRY_MAX_LENGTH),
        at: DateTime.formatIso(DateTime.makeUnsafe(now)),
      };
      const repeats = last !== undefined && last.level === entry.level && last.text === entry.text;
      canvases.set(input.name, {
        pageRevision: input.pageRevision,
        entries: repeats
          ? [...kept.slice(0, -1), { ...entry, count: (last.count ?? 1) + 1 }]
          : [...kept, entry].slice(-CANVAS_LOG_MAX_ENTRIES),
      });
      threads.set(input.threadId, canvases);
    },
  );

  const recent: CanvasDiagnostics["Service"]["recent"] = (target) =>
    Effect.sync(
      () => threads.get(target.threadId)?.get(target.name) ?? { pageRevision: 0, entries: [] },
    );

  const clear: CanvasDiagnostics["Service"]["clear"] = (target) =>
    Effect.sync(() => {
      const canvases = threads.get(target.threadId);
      if (canvases === undefined) return;
      canvases.delete(target.name);
      if (canvases.size === 0) threads.delete(target.threadId);
    });

  const clearThread: CanvasDiagnostics["Service"]["clearThread"] = (threadId) =>
    Effect.sync(() => {
      threads.delete(threadId);
    });

  return CanvasDiagnostics.of({ record, recent, clear, clearThread });
};

export const layer = Layer.sync(CanvasDiagnostics, make);
