import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";
import { canvasNameFromSurfaceId, canvasSurfaceId } from "./canvasFollower";

type CanvasTab = Extract<RightPanelSurface, { kind: "canvas" }>;

export interface CanvasTabTarget {
  readonly name: string;
  /** The title last seen for the canvas, so a restored tab is labelled before its stream loads. */
  readonly title?: string | undefined;
}

export const canvasTabs = (surfaces: ReadonlyArray<RightPanelSurface>): CanvasTab[] =>
  surfaces.filter((surface): surface is CanvasTab => surface.kind === "canvas");

/** Whether a persisted value has the shape of a canvas tab. */
export function isCanvasSurface(surface: {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
}): boolean {
  return (
    typeof surface.id === "string" &&
    typeof surface.name === "string" &&
    canvasNameFromSurfaceId(surface.id) === surface.name &&
    (surface.title === undefined || typeof surface.title === "string")
  );
}

/**
 * Adds the tab when it is missing and selects it. With `showPanel` false a closed panel stays
 * closed, and the tab is waiting when the user opens it. The store passes false only for an
 * agent's reveal on a layout where the panel would cover the chat.
 */
export function openCanvasTab(
  current: ThreadRightPanelState,
  target: CanvasTabTarget,
  showPanel: boolean,
): ThreadRightPanelState {
  const id = canvasSurfaceId(target.name);
  const exists = current.surfaces.some((surface) => surface.id === id);
  const isOpen = current.isOpen || showPanel;
  if (exists && current.activeSurfaceId === id && isOpen === current.isOpen) return current;
  const surface: CanvasTab = {
    id,
    kind: "canvas",
    name: target.name,
    ...(target.title === undefined ? {} : { title: target.title }),
  };
  return {
    ...current,
    isOpen,
    activeSurfaceId: id,
    surfaces: exists ? current.surfaces : [...current.surfaces, surface],
  };
}

/**
 * Drops the tabs of canvases missing from `titles` and relabels the rest. Returns `current`
 * itself when nothing changed, so a caller can tell whether there is anything to store.
 */
export function reconcileCanvasTabs(
  current: ThreadRightPanelState,
  titles: ReadonlyMap<string, string>,
): ThreadRightPanelState {
  let changed = false;
  const surfaces = current.surfaces.flatMap<RightPanelSurface>((surface) => {
    if (surface.kind !== "canvas") return [surface];
    const title = titles.get(surface.name);
    if (title === surface.title && title !== undefined) return [surface];
    changed = true;
    return title === undefined ? [] : [{ ...surface, title }];
  });
  if (!changed) return current;
  const keptIds = new Set<string>(surfaces.map((surface) => surface.id));
  if (current.activeSurfaceId === null || keptIds.has(current.activeSurfaceId)) {
    return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
  }
  // The tab that slides into the removed one's place, as when the user closes a tab.
  const activeIndex = current.surfaces.findIndex(
    (surface) => surface.id === current.activeSurfaceId,
  );
  const keptBefore = current.surfaces
    .slice(0, Math.max(activeIndex, 0))
    .filter((surface) => keptIds.has(surface.id)).length;
  return {
    ...current,
    isOpen: surfaces.length > 0 && current.isOpen,
    surfaces,
    activeSurfaceId: surfaces[Math.min(keptBefore, surfaces.length - 1)]?.id ?? null,
  };
}
