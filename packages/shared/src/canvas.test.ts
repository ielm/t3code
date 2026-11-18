import { describe, expect, it } from "@effect/vitest";

import { applyCanvasStatePatch, decodeCanvasPageMessage } from "./canvas.ts";

describe("applyCanvasStatePatch", () => {
  it("merges objects, deletes on null, replaces arrays and leaves its inputs alone", () => {
    const state = { a: { b: 1, c: 2 }, list: [1, 2], gone: true };
    const next = applyCanvasStatePatch(state, {
      a: { c: 3, d: { e: 4 } },
      list: [9],
      gone: null,
      scalarToObject: { x: 1 },
    });
    expect(next).toEqual({
      a: { b: 1, c: 3, d: { e: 4 } },
      list: [9],
      scalarToObject: { x: 1 },
    });
    expect(state).toEqual({ a: { b: 1, c: 2 }, list: [1, 2], gone: true });
  });

  it("replaces a scalar with an object when the patch holds an object", () => {
    expect(applyCanvasStatePatch({ a: 1 }, { a: { b: null, c: 2 } })).toEqual({ a: { c: 2 } });
  });
});

describe("decodeCanvasPageMessage", () => {
  it("accepts well-formed page messages and drops everything else", () => {
    expect(decodeCanvasPageMessage({ t3canvas: 1, type: "ready" })._tag).toBe("Some");
    expect(
      decodeCanvasPageMessage({ t3canvas: 1, type: "call", id: "1", function: "list" })._tag,
    ).toBe("Some");
    for (const message of [
      null,
      "ready",
      { type: "ready" },
      { t3canvas: 2, type: "ready" },
      { t3canvas: 1, type: "call", id: "", function: "list" },
      { t3canvas: 1, type: "call", id: "1", function: "not a name" },
      { t3canvas: 1, type: "setState", patch: [1] },
      { t3canvas: 1, type: "event", event: "" },
    ]) {
      expect(decodeCanvasPageMessage(message)._tag, JSON.stringify(message)).toBe("None");
    }
  });
});
