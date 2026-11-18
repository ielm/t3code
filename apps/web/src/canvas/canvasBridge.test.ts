import { type CanvasSnapshot, CanvasName, ThreadId } from "@t3tools/contracts";
import { CANVAS_BRIDGE_VERSION, type CanvasPageMessage } from "@t3tools/shared/canvas";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptCanvasLinkRequest,
  acceptCanvasPageMessage,
  CANVAS_GESTURE_REARM_MS,
  type CanvasBridge,
  type CanvasGestureSample,
  canvasFrameSrc,
  createCanvasBridge,
  createCanvasGestureGate,
} from "./canvasBridge";

const v = CANVAS_BRIDGE_VERSION;

const snapshot = (overrides: Partial<CanvasSnapshot> = {}): CanvasSnapshot => ({
  threadId: ThreadId.make("thread-1"),
  name: CanvasName.make("board"),
  title: "Board",
  pageRevision: 4,
  stateRevision: 7,
  state: { count: 1 },
  functions: [{ name: "refresh", kind: "read" }],
  revealId: "reveal-1",
  ...overrides,
});

const call = (id: string, name = "refresh"): CanvasPageMessage => ({
  t3canvas: v,
  type: "call",
  id,
  function: name,
});

/** No recent input anywhere in the app window. */
const idle = (now = 0): CanvasGestureSample => ({ active: false, focused: true, now });
/** Input in the canvas frame that the browser still counts as recent at `now`. */
const pressed = (now = 0): CanvasGestureSample => ({ active: true, focused: true, now });
/** Recent input in the app while focus is outside the canvas frame. */
const pressedElsewhere = (now = 0): CanvasGestureSample => ({ active: true, focused: false, now });

const approve: CanvasPageMessage = { t3canvas: v, type: "event", event: "approve" };
const withChange = () =>
  snapshot({
    functions: [
      { name: "refresh", kind: "read" },
      { name: "restart", kind: "change" },
    ],
  });
const callGesture = (
  bridge: CanvasBridge,
  name: string,
  gesture: CanvasGestureSample,
  from = withChange(),
) => {
  const action = bridge.receive(call("c", name), { snapshot: from, gesture });
  if (action.type !== "call") throw new Error(`expected a call, got ${action.type}`);
  return action.input.gesture;
};

describe("canvasFrameSrc", () => {
  it.each([
    [
      "https://host/canvas/board/index.html",
      3,
      "",
      "https://host/canvas/board/index.html?pageRevision=3",
    ],
    ["https://host/c?token=abc", 0, "", "https://host/c?token=abc&pageRevision=0"],
    [
      "https://host/c?token=abc#old",
      12,
      "#theme",
      "https://host/c?token=abc&pageRevision=12#theme",
    ],
  ])("appends the revision to %s", (url, revision, fragment, expected) => {
    expect(canvasFrameSrc(url, revision, fragment)).toBe(expected);
  });
});

describe("acceptCanvasPageMessage", () => {
  const frameWindow = {};
  const ready = { t3canvas: v, type: "ready" };

  it("decodes a canvas message from the frame's own window", () => {
    expect(acceptCanvasPageMessage({ source: frameWindow, data: ready }, frameWindow)).toEqual(
      ready,
    );
  });

  it.each([
    ["another window", { source: {}, data: ready }, frameWindow],
    ["no source while the frame has no window", { source: null, data: ready }, null],
    [
      "another bridge version",
      { source: frameWindow, data: { ...ready, t3canvas: 2 } },
      frameWindow,
    ],
    [
      "an unknown type",
      { source: frameWindow, data: { t3canvas: v, type: "navigate" } },
      frameWindow,
    ],
    [
      "a call without a valid function name",
      { source: frameWindow, data: { t3canvas: v, type: "call", id: "1", function: "rm -rf" } },
      frameWindow,
    ],
    ["a non-object payload", { source: frameWindow, data: "ready" }, frameWindow],
  ])("drops %s", (_name, event, frame) => {
    expect(acceptCanvasPageMessage(event, frame)).toBeUndefined();
  });
});

describe("acceptCanvasLinkRequest", () => {
  const frameWindow = {};
  const frameUrl = "https://env.test/api/canvas/token.sig/__wrap";
  const request = (url: unknown, extra: object = {}) => ({
    source: frameWindow,
    data: { jsonrpc: "2.0", id: "t3-link-1", method: "ui/open-link", params: { url, ...extra } },
  });

  it("takes an outside link and its modifier keys from the frame's own window", () => {
    expect(
      acceptCanvasLinkRequest(
        request("https://example.com/a?b#c", { metaKey: true }),
        frameWindow,
        frameUrl,
      ),
    ).toEqual({ url: "https://example.com/a?b#c", metaKey: true, ctrlKey: false });
    expect(
      acceptCanvasLinkRequest(request("https://env.test/settings"), frameWindow, frameUrl),
    ).toEqual({ url: "https://env.test/settings", metaKey: false, ctrlKey: false });
  });

  it.each([
    ["another window", { ...request("https://example.com/"), source: {} }, frameWindow],
    ["no frame window", { ...request("https://example.com/"), source: null }, null],
    [
      "a file in the canvas folder",
      request("https://env.test/api/canvas/token.sig/parts/a.html"),
      frameWindow,
    ],
    ["a scheme other than http", request("javascript:alert(1)"), frameWindow],
    ["an address that does not parse", request("https://["), frameWindow],
    [
      "a canvas message",
      { source: frameWindow, data: { t3canvas: v, type: "ready" } },
      frameWindow,
    ],
  ])("drops %s", (_name, event, frame) => {
    expect(acceptCanvasLinkRequest(event, frame, frameUrl)).toBeUndefined();
  });
});

describe("createCanvasBridge", () => {
  it("answers ready with init built from the snapshot", () => {
    const bridge = createCanvasBridge(4);
    expect(
      bridge.receive({ t3canvas: v, type: "ready" }, { snapshot: snapshot(), gesture: idle() }),
    ).toEqual({
      type: "post",
      message: {
        t3canvas: v,
        type: "init",
        name: "board",
        title: "Board",
        state: { count: 1 },
        stateRevision: 7,
        functions: [{ name: "refresh", kind: "read" }],
      },
    });
  });

  it("routes setState, a pressed event and log to their handlers", () => {
    const bridge = createCanvasBridge(4);
    // The mounted page's revision wins over a snapshot that has already moved on.
    const context = { snapshot: snapshot({ pageRevision: 5 }), gesture: pressed() };
    expect(
      bridge.receive({ t3canvas: v, type: "setState", patch: { count: null } }, context),
    ).toEqual({ type: "setState", patch: { count: null } });
    expect(
      bridge.receive({ t3canvas: v, type: "event", event: "approve", payload: { id: 2 } }, context),
    ).toEqual({ type: "event", input: { event: "approve", payload: { id: 2 }, pageRevision: 4 } });
    expect(bridge.receive(approve, { ...context, gesture: pressed(60_000) })).toEqual({
      type: "event",
      input: { event: "approve", pageRevision: 4 },
    });
    expect(
      bridge.receive({ t3canvas: v, type: "log", level: "error", text: "boom" }, context),
    ).toEqual({ type: "log", input: { level: "error", text: "boom" } });
  });

  it("takes the gesture from the host and returns the result under the call's id", () => {
    const bridge = createCanvasBridge(4);
    bridge.receive({ t3canvas: v, type: "ready" }, { snapshot: snapshot(), gesture: idle() });
    const frameWindow = {};
    const forged = acceptCanvasPageMessage(
      { source: frameWindow, data: { ...call("c1"), args: { n: 1 }, gesture: true } },
      frameWindow,
    );
    if (forged === undefined) throw new Error("expected the call to decode");
    const action = bridge.receive(forged, { snapshot: snapshot(), gesture: idle() });
    if (action.type !== "call") throw new Error(`expected a call, got ${action.type}`);
    expect(action.input).toEqual({ function: "refresh", args: { n: 1 }, gesture: false });
    expect(action.settle({ ok: true, value: 42 })).toEqual({
      t3canvas: v,
      type: "callResult",
      id: "c1",
      ok: true,
      value: 42,
    });
    expect(action.settle({ ok: false, reason: "function-timeout", message: "slow" })).toEqual({
      t3canvas: v,
      type: "callResult",
      id: "c1",
      ok: false,
      reason: "function-timeout",
      message: "slow",
    });
  });

  it("drops the result of a call made by a page that has since reloaded", () => {
    const bridge = createCanvasBridge(4);
    const context = { snapshot: snapshot(), gesture: idle() };
    bridge.receive({ t3canvas: v, type: "ready" }, context);
    const before = bridge.receive(call("1"), context);
    bridge.receive({ t3canvas: v, type: "ready" }, context);
    const after = bridge.receive(call("1"), context);
    if (before.type !== "call" || after.type !== "call") throw new Error("expected calls");
    expect(before.settle({ ok: true, value: "old" })).toBeUndefined();
    expect(after.settle({ ok: true, value: "new" })).toMatchObject({ id: "1", value: "new" });
  });

  it.each([
    ["no recent input", idle()],
    ["input outside the canvas frame", pressedElsewhere()],
  ])("drops an event sent with %s and tells the agent why", (_name, gesture) => {
    const bridge = createCanvasBridge(4);
    const action = bridge.receive(approve, { snapshot: snapshot(), gesture });
    if (action.type !== "log") throw new Error(`expected a log, got ${action.type}`);
    expect(action.input.level).toBe("warning");
    expect(action.input.text).toContain('"approve"');
    expect(action.input.text).toContain("click or key press");
  });

  it("accepts one event, change call or link per press", () => {
    const gate = createCanvasGestureGate();
    const bridge = createCanvasBridge(4, gate);
    const context = (gesture: CanvasGestureSample) => ({ snapshot: withChange(), gesture });

    expect(bridge.receive(approve, context(pressed(1_000))).type).toBe("event");
    const second = bridge.receive(approve, context(pressed(1_050)));
    if (second.type !== "log") throw new Error(`expected a log, got ${second.type}`);
    expect(second.input.text).toContain("already");
    expect(callGesture(bridge, "restart", pressed(1_100))).toBe(false);
    expect(gate.take(pressed(1_150))).toBe("spent");
    // A function the panel has not been told about could be a change function.
    expect(callGesture(bridge, "unlisted", pressed(1_200))).toBe(false);
  });

  it("never gates a read call, and a read call does not use up the press", () => {
    const bridge = createCanvasBridge(4);
    expect(callGesture(bridge, "refresh", idle())).toBe(false);
    expect(callGesture(bridge, "refresh", pressed(1_000))).toBe(false);
    expect(callGesture(bridge, "restart", pressed(1_010))).toBe(true);
    expect(callGesture(bridge, "refresh", pressed(1_020))).toBe(false);
  });

  it("accepts the next press once any message shows the last one lapsed", () => {
    const bridge = createCanvasBridge(4);
    const context = (gesture: CanvasGestureSample) => ({ snapshot: withChange(), gesture });
    expect(callGesture(bridge, "restart", pressed(1_000))).toBe(true);
    expect(callGesture(bridge, "restart", pressed(2_000))).toBe(false);
    bridge.receive({ t3canvas: v, type: "setState", patch: {} }, context(idle(6_100)));
    expect(bridge.receive(approve, context(pressed(6_200))).type).toBe("event");
  });

  it("shares one press between the pages of a reloaded canvas", () => {
    const gate = createCanvasGestureGate();
    const before = createCanvasBridge(4, gate);
    const after = createCanvasBridge(5, gate);
    expect(callGesture(before, "restart", pressed(1_000))).toBe(true);
    expect(callGesture(after, "restart", pressed(1_500))).toBe(false);
  });

  it("posts state once per new revision, and only after the page is ready", () => {
    const bridge = createCanvasBridge(4);
    expect(bridge.stateUpdate(snapshot({ stateRevision: 8 }))).toBeUndefined();
    bridge.receive({ t3canvas: v, type: "ready" }, { snapshot: snapshot(), gesture: idle() });
    expect(bridge.stateUpdate(snapshot())).toBeUndefined();
    const next = snapshot({ stateRevision: 8, state: { count: 2 } });
    expect(bridge.stateUpdate(next)).toEqual({
      t3canvas: v,
      type: "state",
      state: { count: 2 },
      stateRevision: 8,
    });
    expect(bridge.stateUpdate(next)).toBeUndefined();
  });
});

describe("createCanvasGestureGate", () => {
  it("refuses without recent input or with focus outside the frame, and neither uses a press", () => {
    const gate = createCanvasGestureGate();
    expect(gate.take(idle(1_000))).toBe("no-gesture");
    expect(gate.take(pressedElsewhere(1_010))).toBe("no-gesture");
    expect(gate.take(pressed(1_020))).toBe("accepted");
  });

  it("refuses a second action while the same press may still be what the browser reports", () => {
    const gate = createCanvasGestureGate();
    expect(gate.take(pressed(1_000))).toBe("accepted");
    expect(gate.take(pressed(1_001))).toBe("spent");
    expect(gate.take(pressed(1_000 + CANVAS_GESTURE_REARM_MS - 1))).toBe("spent");
  });

  it("accepts again once input still reported can only be newer than the accepted press", () => {
    const gate = createCanvasGestureGate();
    expect(gate.take(pressed(1_000))).toBe("accepted");
    expect(gate.take(pressed(1_000 + CANVAS_GESTURE_REARM_MS))).toBe("accepted");
    expect(gate.take(pressed(1_001 + CANVAS_GESTURE_REARM_MS))).toBe("spent");
  });

  it("accepts again as soon as the press is seen to have lapsed", () => {
    const gate = createCanvasGestureGate();
    expect(gate.take(pressed(1_000))).toBe("accepted");
    gate.observe(pressedElsewhere(1_100));
    expect(gate.take(pressed(1_200))).toBe("spent");
    gate.observe(idle(1_300));
    expect(gate.take(pressed(1_400))).toBe("accepted");
  });
});
