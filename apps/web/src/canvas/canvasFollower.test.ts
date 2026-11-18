import { describe, expect, it } from "vite-plus/test";

import { type CanvasFollowerState, followCanvases } from "./canvasFollower";

const canvas = (name: string, revealId: string) => ({ name, revealId });

const tabs = (...names: ReadonlyArray<string>): ReadonlySet<string> => new Set(names);

const baseline = (...canvases: ReadonlyArray<{ name: string; revealId: string }>) =>
  followCanvases({ follower: null, canvases, openTabs: tabs() }).follower;

describe("followCanvases", () => {
  it("opens a canvas whose revealId is new", () => {
    const follower = baseline(canvas("plan", "r1"));

    const revealedAgain = followCanvases({
      follower,
      canvases: [canvas("plan", "r2")],
      openTabs: tabs(),
    });
    expect(revealedAgain.actions).toEqual([{ type: "open", name: "plan" }]);
    expect(revealedAgain.follower).toEqual({ revealIds: { plan: "r2" } });

    const created = followCanvases({
      follower,
      canvases: [canvas("plan", "r1"), canvas("constructor", "r1")],
      openTabs: tabs(),
    });
    expect(created.actions).toEqual([{ type: "open", name: "constructor" }]);
  });

  it("focuses instead of opening when the revealed canvas already has a tab", () => {
    const result = followCanvases({
      follower: baseline(canvas("plan", "r1"), canvas("board", "r1")),
      canvases: [canvas("plan", "r2"), canvas("board", "r1")],
      openTabs: tabs("plan", "board"),
    });

    expect(result.actions).toEqual([{ type: "focus", name: "plan" }]);
  });

  it("does nothing for state and page updates, and keeps the follower reference", () => {
    const follower = baseline(canvas("plan", "r1"), canvas("board", "r1"));

    const updated = { ...canvas("plan", "r1"), stateRevision: 7, pageRevision: 3 };

    const result = followCanvases({
      follower,
      canvases: [updated, canvas("board", "r1")],
      openTabs: tabs("board"),
    });

    expect(result.actions).toEqual([]);
    expect(result.follower).toBe(follower);
  });

  it("treats the first canvases after load as a baseline that opens nothing", () => {
    const result = followCanvases({
      follower: null,
      canvases: [canvas("plan", "r1"), canvas("board", "r4")],
      openTabs: tabs("board"),
    });

    expect(result.actions).toEqual([]);
    expect(result.follower).toEqual({ revealIds: { plan: "r1", board: "r4" } });
  });

  it("closes the tab of a canvas that disappears", () => {
    const follower = baseline(canvas("plan", "r1"), canvas("board", "r1"));

    const result = followCanvases({
      follower,
      canvases: [canvas("board", "r1")],
      openTabs: tabs("plan", "board"),
    });
    expect(result.actions).toEqual([{ type: "close", name: "plan" }]);
    expect(result.follower).toEqual({ revealIds: { board: "r1" } });

    const withoutTab = followCanvases({
      follower,
      canvases: [canvas("board", "r1")],
      openTabs: tabs("board"),
    });
    expect(withoutTab.actions).toEqual([]);

    const staleRestoredTab = followCanvases({
      follower: null,
      canvases: [canvas("board", "r1")],
      openTabs: tabs("plan"),
    });
    expect(staleRestoredTab.actions).toEqual([{ type: "close", name: "plan" }]);
  });

  it("reopens a removed canvas that comes back, even with its old revealId", () => {
    const afterRemoval = followCanvases({
      follower: baseline(canvas("plan", "r1")),
      canvases: [],
      openTabs: tabs(),
    }).follower;

    const result = followCanvases({
      follower: afterRemoval,
      canvases: [canvas("plan", "r1")],
      openTabs: tabs(),
    });

    expect(result.actions).toEqual([{ type: "open", name: "plan" }]);
  });

  it.each<[string, CanvasFollowerState | null]>([
    ["with no persisted follower state", null],
    ["with persisted follower state", { revealIds: { plan: "r1", board: "r1" } }],
  ])("opens only a genuine new reveal after a reload %s", (_label, persisted) => {
    const canvases = [canvas("plan", "r1"), canvas("board", "r1")];
    const reloaded = followCanvases({ follower: persisted, canvases, openTabs: tabs("board") });
    expect(reloaded.actions).toEqual([]);

    const revealed = followCanvases({
      follower: reloaded.follower,
      canvases: [canvas("plan", "r2"), canvas("board", "r1")],
      openTabs: tabs("board"),
    });
    expect(revealed.actions).toEqual([{ type: "open", name: "plan" }]);

    const settled = followCanvases({
      follower: revealed.follower,
      canvases: [canvas("plan", "r2"), canvas("board", "r1")],
      openTabs: tabs("board"),
    });
    expect(settled.actions).toEqual([]);
    expect(settled.follower).toBe(revealed.follower);
  });

  it("opens a canvas revealed while this client was away when the follower was persisted", () => {
    const result = followCanvases({
      follower: { revealIds: { plan: "r1" } },
      canvases: [canvas("plan", "r2")],
      openTabs: tabs(),
    });

    expect(result.actions).toEqual([{ type: "open", name: "plan" }]);
  });
});
