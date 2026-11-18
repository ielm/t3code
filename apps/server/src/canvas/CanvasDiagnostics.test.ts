import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { CANVAS_LOG_ENTRY_MAX_LENGTH, CANVAS_LOG_MAX_ENTRIES } from "@t3tools/shared/canvas";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as CanvasDiagnostics from "./CanvasDiagnostics.ts";

const threadId = ThreadId.make("thread-1");
const board = { threadId, name: "board" };
const notes = { threadId, name: "notes" };
const elsewhere = { threadId: ThreadId.make("thread-2"), name: "board" };

const error = (text: string, pageRevision = 0, target = board) => ({
  ...target,
  pageRevision,
  level: "error" as const,
  text,
});

it.effect("keeps entries oldest first, stamped from the clock", () =>
  Effect.gen(function* () {
    const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
    expect(yield* diagnostics.recent(board)).toEqual({ pageRevision: 0, entries: [] });
    yield* diagnostics.record(error("first", 3));
    yield* TestClock.adjust("5 seconds");
    yield* diagnostics.record({ ...board, pageRevision: 3, level: "warning", text: "second" });

    expect(yield* diagnostics.recent(board)).toEqual({
      pageRevision: 3,
      entries: [
        { level: "error", text: "first", at: "1970-01-01T00:00:00.000Z" },
        { level: "warning", text: "second", at: "1970-01-01T00:00:05.000Z" },
      ],
    });
  }).pipe(Effect.provide(CanvasDiagnostics.layer)),
);

it.effect("keeps only the newest page revision's entries", () =>
  Effect.gen(function* () {
    const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
    yield* diagnostics.record(error("old page", 1));
    yield* diagnostics.record(error("new page", 2));
    yield* diagnostics.record(error("late from the old page", 1));

    const report = yield* diagnostics.recent(board);
    expect(report.pageRevision).toBe(2);
    expect(report.entries.map((entry) => entry.text)).toEqual(["new page"]);
  }).pipe(Effect.provide(CanvasDiagnostics.layer)),
);

it.effect("truncates long text", () =>
  Effect.gen(function* () {
    const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
    yield* diagnostics.record(error("x".repeat(CANVAS_LOG_ENTRY_MAX_LENGTH + 10)));

    const { entries } = yield* diagnostics.recent(board);
    expect(entries[0]?.text).toBe("x".repeat(CANVAS_LOG_ENTRY_MAX_LENGTH));
  }).pipe(Effect.provide(CanvasDiagnostics.layer)),
);

it.effect("drops the oldest entries past the cap", () =>
  Effect.gen(function* () {
    const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
    const total = CANVAS_LOG_MAX_ENTRIES + 3;
    yield* Effect.forEach(
      Array.from({ length: total }, (_, index) => index),
      (index) => diagnostics.record(error(`entry ${index}`)),
    );

    const { entries } = yield* diagnostics.recent(board);
    expect(entries).toHaveLength(CANVAS_LOG_MAX_ENTRIES);
    expect(entries[0]?.text).toBe("entry 3");
    expect(entries.at(-1)?.text).toBe(`entry ${total - 1}`);
  }).pipe(Effect.provide(CanvasDiagnostics.layer)),
);

it.effect("collapses consecutive identical entries into one with a count", () =>
  Effect.gen(function* () {
    const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
    yield* diagnostics.record(error("boom"));
    yield* TestClock.adjust("1 second");
    yield* diagnostics.record(error("boom"));
    yield* TestClock.adjust("1 second");
    yield* diagnostics.record(error("boom"));
    yield* diagnostics.record({ ...board, pageRevision: 0, level: "warning", text: "boom" });
    yield* diagnostics.record(error("boom"));

    expect((yield* diagnostics.recent(board)).entries).toEqual([
      { level: "error", text: "boom", at: "1970-01-01T00:00:02.000Z", count: 3 },
      { level: "warning", text: "boom", at: "1970-01-01T00:00:02.000Z" },
      { level: "error", text: "boom", at: "1970-01-01T00:00:02.000Z" },
    ]);
  }).pipe(Effect.provide(CanvasDiagnostics.layer)),
);

it.effect("collapses entries that are identical once truncated, without using the cap", () =>
  Effect.gen(function* () {
    const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
    yield* diagnostics.record(error("first"));
    yield* Effect.forEach(
      Array.from({ length: CANVAS_LOG_MAX_ENTRIES + 5 }, (_, index) => index),
      (index) => diagnostics.record(error("y".repeat(CANVAS_LOG_ENTRY_MAX_LENGTH) + index)),
    );

    const { entries } = yield* diagnostics.recent(board);
    expect(entries.map((entry) => entry.count)).toEqual([undefined, CANVAS_LOG_MAX_ENTRIES + 5]);
  }).pipe(Effect.provide(CanvasDiagnostics.layer)),
);

it.effect("clears one canvas, forgetting its page revision", () =>
  Effect.gen(function* () {
    const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
    yield* diagnostics.record(error("board", 4));
    yield* diagnostics.record(error("notes", 0, notes));
    yield* diagnostics.clear(board);

    expect(yield* diagnostics.recent(board)).toEqual({ pageRevision: 0, entries: [] });
    expect((yield* diagnostics.recent(notes)).entries).toHaveLength(1);

    yield* diagnostics.record(error("reopened", 1));
    expect((yield* diagnostics.recent(board)).entries.map((entry) => entry.text)).toEqual([
      "reopened",
    ]);
  }).pipe(Effect.provide(CanvasDiagnostics.layer)),
);

it.effect("clears every canvas of one thread and leaves other threads alone", () =>
  Effect.gen(function* () {
    const diagnostics = yield* CanvasDiagnostics.CanvasDiagnostics;
    yield* diagnostics.record(error("board"));
    yield* diagnostics.record(error("notes", 0, notes));
    yield* diagnostics.record(error("other thread", 0, elsewhere));
    yield* diagnostics.clearThread(threadId);

    expect((yield* diagnostics.recent(board)).entries).toEqual([]);
    expect((yield* diagnostics.recent(notes)).entries).toEqual([]);
    expect((yield* diagnostics.recent(elsewhere)).entries).toHaveLength(1);
  }).pipe(Effect.provide(CanvasDiagnostics.layer)),
);
