import { type CanvasSnapshot, CanvasName, ThreadId } from "@t3tools/contracts";
import { CANVAS_BRIDGE_VERSION, type CanvasPageMessage } from "@t3tools/shared/canvas";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptCanvasLinkRequest,
  acceptCanvasPageMessage,
  canvasFrameSrc,
  createCanvasBridge,
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

const call = (id: string): CanvasPageMessage => ({
  t3canvas: v,
  type: "call",
  id,
  function: "refresh",
});

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
      bridge.receive({ t3canvas: v, type: "ready" }, { snapshot: snapshot(), gesture: false }),
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

  it("routes setState, event and log to their handlers", () => {
    const bridge = createCanvasBridge(4);
    // The mounted page's revision wins over a snapshot that has already moved on.
    const context = { snapshot: snapshot({ pageRevision: 5 }), gesture: true };
    expect(
      bridge.receive({ t3canvas: v, type: "setState", patch: { count: null } }, context),
    ).toEqual({ type: "setState", patch: { count: null } });
    expect(
      bridge.receive({ t3canvas: v, type: "event", event: "approve", payload: { id: 2 } }, context),
    ).toEqual({ type: "event", input: { event: "approve", payload: { id: 2 }, pageRevision: 4 } });
    expect(bridge.receive({ t3canvas: v, type: "event", event: "approve" }, context)).toEqual({
      type: "event",
      input: { event: "approve", pageRevision: 4 },
    });
    expect(
      bridge.receive({ t3canvas: v, type: "log", level: "error", text: "boom" }, context),
    ).toEqual({ type: "log", input: { level: "error", text: "boom" } });
  });

  it("takes the gesture from the host and returns the result under the call's id", () => {
    const bridge = createCanvasBridge(4);
    bridge.receive({ t3canvas: v, type: "ready" }, { snapshot: snapshot(), gesture: false });
    const frameWindow = {};
    const forged = acceptCanvasPageMessage(
      { source: frameWindow, data: { ...call("c1"), args: { n: 1 }, gesture: true } },
      frameWindow,
    );
    if (forged === undefined) throw new Error("expected the call to decode");
    const action = bridge.receive(forged, { snapshot: snapshot(), gesture: false });
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
    const context = { snapshot: snapshot(), gesture: false };
    bridge.receive({ t3canvas: v, type: "ready" }, context);
    const before = bridge.receive(call("1"), context);
    bridge.receive({ t3canvas: v, type: "ready" }, context);
    const after = bridge.receive(call("1"), context);
    if (before.type !== "call" || after.type !== "call") throw new Error("expected calls");
    expect(before.settle({ ok: true, value: "old" })).toBeUndefined();
    expect(after.settle({ ok: true, value: "new" })).toMatchObject({ id: "1", value: "new" });
  });

  it("posts state once per new revision, and only after the page is ready", () => {
    const bridge = createCanvasBridge(4);
    expect(bridge.stateUpdate(snapshot({ stateRevision: 8 }))).toBeUndefined();
    bridge.receive({ t3canvas: v, type: "ready" }, { snapshot: snapshot(), gesture: false });
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
