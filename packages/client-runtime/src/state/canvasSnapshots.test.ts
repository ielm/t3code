import { type CanvasSnapshot, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type CanvasSnapshotsState,
  EMPTY_CANVAS_SNAPSHOTS,
  reduceCanvasSnapshots,
} from "./canvasSnapshots.ts";

const threadId = ThreadId.make("thread-1");

const canvas = (name: string, overrides: Partial<CanvasSnapshot> = {}): CanvasSnapshot => ({
  threadId,
  name,
  title: name,
  pageRevision: 0,
  stateRevision: 0,
  state: { filters: { open: true }, rows: [1, 2] },
  functions: [{ name: "refresh", kind: "read" }],
  revealId: "reveal-1",
  ...overrides,
});

const snapshot = (state: CanvasSnapshotsState, ...canvases: ReadonlyArray<CanvasSnapshot>) =>
  reduceCanvasSnapshots(state, { _tag: "snapshot", canvases });

describe("reduceCanvasSnapshots", () => {
  it("replaces everything on snapshot, in the server's order", () => {
    const first = snapshot(EMPTY_CANVAS_SNAPSHOTS, canvas("plan"), canvas("board"));
    const second = snapshot(first, canvas("report"), canvas("board"));

    expect([...second.keys()]).toEqual(["report", "board"]);
    expect(second.get("board")).toBe(first.get("board"));
  });

  it("inserts and replaces one canvas on upsert", () => {
    const first = snapshot(EMPTY_CANVAS_SNAPSHOTS, canvas("plan"), canvas("board"));
    const inserted = reduceCanvasSnapshots(first, { _tag: "upsert", canvas: canvas("123") });
    const replaced = reduceCanvasSnapshots(inserted, {
      _tag: "upsert",
      canvas: canvas("plan", { stateRevision: 1, state: { rows: [1, 2, 3] } }),
    });

    expect([...replaced.keys()]).toEqual(["plan", "board", "123"]);
    expect(replaced.get("plan")?.state).toEqual({ rows: [1, 2, 3] });
    expect(replaced.get("board")).toBe(first.get("board"));
    expect(first.get("plan")?.stateRevision).toBe(0);
  });

  it("deletes one canvas on removed", () => {
    const first = snapshot(EMPTY_CANVAS_SNAPSHOTS, canvas("plan"), canvas("board"));
    const next = reduceCanvasSnapshots(first, { _tag: "removed", threadId, name: "plan" });

    expect([...next.keys()]).toEqual(["board"]);
    expect(first.has("plan")).toBe(true);
  });

  it("returns the same reference when an item changes nothing", () => {
    const first = snapshot(EMPTY_CANVAS_SNAPSHOTS, canvas("plan"), canvas("board"));

    expect(snapshot(first, canvas("plan"), canvas("board"))).toBe(first);
    expect(reduceCanvasSnapshots(first, { _tag: "upsert", canvas: canvas("plan") })).toBe(first);
    expect(reduceCanvasSnapshots(first, { _tag: "removed", threadId, name: "gone" })).toBe(first);
    expect(snapshot(EMPTY_CANVAS_SNAPSHOTS)).toBe(EMPTY_CANVAS_SNAPSHOTS);
  });

  it.each<[string, Partial<CanvasSnapshot>]>([
    ["nested state", { state: { filters: { open: false }, rows: [1, 2] } }],
    ["array length", { state: { filters: { open: true }, rows: [1, 2, 3] } }],
    ["a removed state key", { state: { filters: { open: true } } }],
    ["functions", { functions: [{ name: "refresh", kind: "change" }] }],
    ["revealId", { revealId: "reveal-2" }],
    ["manifestIssue", { manifestIssue: "canvas.json is not valid JSON" }],
  ])("returns a new reference when %s changes", (_label, overrides) => {
    const first = snapshot(EMPTY_CANVAS_SNAPSHOTS, canvas("plan"));

    const upserted = reduceCanvasSnapshots(first, {
      _tag: "upsert",
      canvas: canvas("plan", overrides),
    });
    expect(upserted).not.toBe(first);
    expect(upserted.get("plan")).toEqual(canvas("plan", overrides));
    expect(snapshot(first, canvas("plan", overrides))).not.toBe(first);
  });

  it("returns a new reference when a snapshot only reorders", () => {
    const first = snapshot(EMPTY_CANVAS_SNAPSHOTS, canvas("plan"), canvas("board"));
    const reordered = snapshot(first, canvas("board"), canvas("plan"));

    expect(reordered).not.toBe(first);
    expect([...reordered.keys()]).toEqual(["board", "plan"]);
  });
});
