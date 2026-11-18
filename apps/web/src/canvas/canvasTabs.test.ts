import { describe, expect, it } from "vite-plus/test";

import type { ThreadRightPanelState } from "../rightPanelStore";
import { isCanvasSurface, openCanvasTab, reconcileCanvasTabs } from "./canvasTabs";

const diff = { id: "diff", kind: "diff" } as const;
const files = { id: "files", kind: "files" } as const;
const canvas = (name: string, title?: string) =>
  ({
    id: `canvas:${name}`,
    kind: "canvas",
    name,
    ...(title === undefined ? {} : { title }),
  }) as const;

const panel = (
  surfaces: ThreadRightPanelState["surfaces"],
  activeSurfaceId: string | null,
  isOpen = true,
): ThreadRightPanelState => ({ isOpen, activeSurfaceId, surfaces });

describe("openCanvasTab", () => {
  it("adds the tab once, selects it and opens the panel", () => {
    const closed = panel([diff], "diff", false);

    const opened = openCanvasTab(closed, { name: "plan", title: "Plan" }, true);
    expect(opened).toEqual(panel([diff, canvas("plan", "Plan")], "canvas:plan"));

    expect(openCanvasTab(opened, { name: "plan", title: "Plan" }, true)).toBe(opened);
    const elsewhere = { ...opened, activeSurfaceId: "diff" };
    expect(openCanvasTab(elsewhere, { name: "plan" }, true)).toEqual(opened);
  });

  it("selects the tab behind a closed panel when the panel must not show", () => {
    const closed = panel([diff], "diff", false);

    expect(openCanvasTab(closed, { name: "plan" }, false)).toEqual(
      panel([diff, canvas("plan")], "canvas:plan", false),
    );
    const open = panel([diff], "diff");
    expect(openCanvasTab(open, { name: "plan" }, false).isOpen).toBe(true);
  });
});

describe("reconcileCanvasTabs", () => {
  it("returns the same state when every canvas tab is current", () => {
    const current = panel([diff, canvas("plan", "Plan")], "canvas:plan");

    expect(reconcileCanvasTabs(current, new Map([["plan", "Plan"]]))).toBe(current);
    expect(reconcileCanvasTabs(panel([diff], "diff"), new Map())).toEqual(panel([diff], "diff"));
  });

  it("relabels a tab whose canvas was retitled and leaves other tabs alone", () => {
    const current = panel([diff, canvas("plan"), canvas("board", "Board")], "diff");

    const next = reconcileCanvasTabs(
      current,
      new Map([
        ["plan", "Plan"],
        ["board", "Board"],
      ]),
    );
    expect(next.surfaces).toEqual([diff, canvas("plan", "Plan"), canvas("board", "Board")]);
    expect(next.surfaces[2]).toBe(current.surfaces[2]);
    expect(next.activeSurfaceId).toBe("diff");
  });

  it("closes the tabs of canvases that are gone and selects the tab that takes their place", () => {
    const current = panel([diff, canvas("plan"), canvas("board"), files], "canvas:plan");

    expect(reconcileCanvasTabs(current, new Map())).toEqual(panel([diff, files], "files"));
    const last = panel([diff, canvas("plan")], "canvas:plan");
    expect(reconcileCanvasTabs(last, new Map())).toEqual(panel([diff], "diff"));
  });

  it("closes the panel with its last tab", () => {
    expect(reconcileCanvasTabs(panel([canvas("plan")], "canvas:plan"), new Map())).toEqual(
      panel([], null, false),
    );
  });
});

describe("isCanvasSurface", () => {
  it.each([
    [{ id: "canvas:plan", name: "plan" }, true],
    [{ id: "canvas:plan", name: "plan", title: "Plan" }, true],
    [{ id: "canvas:plan" }, false],
    [{ id: "canvas:board", name: "plan" }, false],
    [{ id: "canvas:plan", name: "plan", title: 3 }, false],
  ])("%j is a canvas tab: %s", (surface, expected) => {
    expect(isCanvasSurface(surface)).toBe(expected);
  });
});
