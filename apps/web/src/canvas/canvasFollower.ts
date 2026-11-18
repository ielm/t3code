import type { CanvasSnapshot } from "@t3tools/contracts";

const CANVAS_SURFACE_PREFIX = "canvas:";

export const canvasSurfaceId = (name: string) => `${CANVAS_SURFACE_PREFIX}${name}` as const;

export const canvasNameFromSurfaceId = (surfaceId: string): string | null =>
  surfaceId.startsWith(CANVAS_SURFACE_PREFIX)
    ? surfaceId.slice(CANVAS_SURFACE_PREFIX.length)
    : null;

/** Plain JSON, so the caller can persist it per thread across reloads. */
export interface CanvasFollowerState {
  /** The `revealId` this client last saw for each canvas that existed then. */
  readonly revealIds: Readonly<Record<string, string>>;
}

export interface CanvasTabAction {
  readonly type: "open" | "focus" | "close";
  readonly name: string;
}

export interface CanvasFollowerInput {
  /** `null` until this client has seen the thread's canvases once. */
  readonly follower: CanvasFollowerState | null;
  /** The thread's canvases as the server last reported them, never the pre-load empty state. */
  readonly canvases: Iterable<Pick<CanvasSnapshot, "name" | "revealId">>;
  /** Names of the canvases that have a tab in this thread's right panel. */
  readonly openTabs: ReadonlySet<string>;
}

export interface CanvasFollowerResult {
  readonly actions: ReadonlyArray<CanvasTabAction>;
  /** The input `follower` itself when no `revealId` changed. */
  readonly follower: CanvasFollowerState;
}

/**
 * With no follower state the canvases are a baseline: nothing opens, so a reload does not
 * resurrect tabs the user closed. After that only a changed `revealId` opens or focuses a tab.
 */
export function followCanvases(input: CanvasFollowerInput): CanvasFollowerResult {
  const previous = input.follower?.revealIds;
  const revealIds: Record<string, string> = {};
  const actions: CanvasTabAction[] = [];
  for (const canvas of input.canvases) {
    revealIds[canvas.name] = canvas.revealId;
    if (previous === undefined) continue;
    const seen = Object.hasOwn(previous, canvas.name) ? previous[canvas.name] : undefined;
    if (seen === canvas.revealId) continue;
    actions.push({ type: input.openTabs.has(canvas.name) ? "focus" : "open", name: canvas.name });
  }
  for (const name of input.openTabs) {
    if (!Object.hasOwn(revealIds, name)) actions.push({ type: "close", name });
  }
  const previousNames = previous === undefined ? null : Object.keys(previous);
  const unchanged =
    previousNames !== null &&
    previousNames.length === Object.keys(revealIds).length &&
    previousNames.every(
      (name) => Object.hasOwn(revealIds, name) && revealIds[name] === previous?.[name],
    );
  return { actions, follower: unchanged && input.follower ? input.follower : { revealIds } };
}
