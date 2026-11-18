import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { CanvasSnapshotsState } from "@t3tools/client-runtime/state/canvas";
import { type CanvasSnapshot, type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "../closedViewStore";
import { reopenClosedView } from "../reopenClosedView";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { applyCanvasSnapshots } from "./agentOpenedCanvases";
import type { CanvasFollowerState } from "./canvasFollower";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const inline = { sheetLayout: false };

const canvas = (name: string, revealId: string, title = name): CanvasSnapshot => ({
  threadId: ref.threadId,
  name,
  title,
  pageRevision: 0,
  stateRevision: 0,
  state: {},
  functions: [],
  revealId,
});

const list = (...canvases: ReadonlyArray<CanvasSnapshot>): CanvasSnapshotsState =>
  new Map(canvases.map((entry) => [entry.name, entry]));

const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
const tabIds = () => panel().surfaces.map((surface) => surface.id);

function setup() {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
}

describe("applyCanvasSnapshots", () => {
  it("treats the first list as a baseline, then opens the panel on a revealed canvas", () => {
    setup();
    const baseline = applyCanvasSnapshots(ref, list(canvas("plan", "r1")), null, inline);
    expect(panel().surfaces).toEqual([]);

    const revealed = applyCanvasSnapshots(
      ref,
      list(canvas("plan", "r1"), canvas("board", "r1", "Board")),
      baseline,
      inline,
    );
    expect(revealed).toEqual({ revealIds: { plan: "r1", board: "r1" } });
    expect(panel()).toMatchObject({
      isOpen: true,
      activeSurfaceId: "canvas:board",
      surfaces: [{ id: "canvas:board", kind: "canvas", name: "board", title: "Board" }],
    });
    expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(0);
  });

  it("does not reopen a tab the user closed until the agent reveals it again", () => {
    setup();
    const store = useRightPanelStore.getState();
    let follower: CanvasFollowerState = applyCanvasSnapshots(ref, list(), null, inline);
    follower = applyCanvasSnapshots(ref, list(canvas("plan", "r1")), follower, inline);
    store.closeSurface(ref, "canvas:plan");

    const unchanged = applyCanvasSnapshots(ref, list(canvas("plan", "r1")), follower, inline);
    expect(unchanged).toBe(follower);
    expect(tabIds()).toEqual([]);

    applyCanvasSnapshots(ref, list(canvas("plan", "r2")), follower, inline);
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "canvas:plan" });
  });

  it("brings an open tab forward when its canvas is revealed again", () => {
    setup();
    const store = useRightPanelStore.getState();
    const follower = applyCanvasSnapshots(ref, list(), null, inline);
    const shown = applyCanvasSnapshots(ref, list(canvas("plan", "r1")), follower, inline);
    store.open(ref, "diff");
    store.close(ref);

    applyCanvasSnapshots(ref, list(canvas("plan", "r2")), shown, inline);
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "canvas:plan" });
    expect(tabIds()).toEqual(["canvas:plan", "diff"]);
  });

  it("leaves a closed panel closed on a sheet layout, with the tab selected behind it", () => {
    setup();
    const follower = applyCanvasSnapshots(ref, list(), null, { sheetLayout: true });

    applyCanvasSnapshots(ref, list(canvas("plan", "r1")), follower, { sheetLayout: true });
    expect(panel()).toMatchObject({ isOpen: false, activeSurfaceId: "canvas:plan" });
    expect(tabIds()).toEqual(["canvas:plan"]);
  });

  it("retitles tabs and closes the tab of a canvas that is gone without recording a close", () => {
    setup();
    let follower = applyCanvasSnapshots(ref, list(), null, inline);
    follower = applyCanvasSnapshots(ref, list(canvas("plan", "r1", "Plan")), follower, inline);

    follower = applyCanvasSnapshots(
      ref,
      list(canvas("plan", "r1", "Launch plan")),
      follower,
      inline,
    );
    expect(panel().surfaces).toMatchObject([{ id: "canvas:plan", title: "Launch plan" }]);

    follower = applyCanvasSnapshots(ref, list(), follower, inline);
    expect(follower).toEqual({ revealIds: {} });
    expect(panel()).toMatchObject({ isOpen: false, surfaces: [] });
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("restores a closed tab from history only while its canvas still exists", async () => {
    setup();
    const store = useRightPanelStore.getState();
    let follower = applyCanvasSnapshots(ref, list(), null, inline);
    follower = applyCanvasSnapshots(ref, list(canvas("plan", "r1", "Plan")), follower, inline);
    store.closeSurface(ref, "canvas:plan");
    const [closed] = useClosedViewStore.getState().entries;
    const reopen = () =>
      reopenClosedView(closed!, {
        openPreview: () => Promise.reject(new Error("unused")),
        workspaceAvailable: true,
      });

    const beforeReopen = store.getUserActionRevision(ref);
    expect(await reopen()).toBe(true);
    expect(store.getUserActionRevision(ref)).toBe(beforeReopen + 1);
    follower = applyCanvasSnapshots(ref, list(canvas("plan", "r1", "Plan")), follower, inline);
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "canvas:plan" });

    store.closeSurface(ref, "canvas:plan");
    expect(await reopen()).toBe(true);
    applyCanvasSnapshots(ref, list(), follower, inline);
    expect(tabIds()).toEqual([]);
  });
});
