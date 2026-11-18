import type { CanvasSnapshot, CanvasStreamItem } from "@t3tools/contracts";

/** One thread's canvases by name, in the order the server listed or added them. */
export type CanvasSnapshotsState = ReadonlyMap<string, CanvasSnapshot>;

export const EMPTY_CANVAS_SNAPSHOTS: CanvasSnapshotsState = new Map();

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        jsonEquals((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

const reuseUnchanged = (current: CanvasSnapshot | undefined, next: CanvasSnapshot) =>
  current !== undefined && jsonEquals(current, next) ? current : next;

function sameEntries(left: CanvasSnapshotsState, right: CanvasSnapshotsState): boolean {
  if (left.size !== right.size) return false;
  const rightValues = right.values();
  for (const canvas of left.values()) {
    if (rightValues.next().value !== canvas) return false;
  }
  return true;
}

/** Returns `state` itself, and keeps each unchanged canvas's reference, when an item changes nothing. */
export function reduceCanvasSnapshots(
  state: CanvasSnapshotsState,
  item: CanvasStreamItem,
): CanvasSnapshotsState {
  switch (item._tag) {
    case "snapshot": {
      const next = new Map(
        item.canvases.map((canvas) => [
          canvas.name,
          reuseUnchanged(state.get(canvas.name), canvas),
        ]),
      );
      return sameEntries(state, next) ? state : next;
    }
    case "upsert": {
      const current = state.get(item.canvas.name);
      const canvas = reuseUnchanged(current, item.canvas);
      return canvas === current ? state : new Map(state).set(canvas.name, canvas);
    }
    case "removed": {
      if (!state.has(item.name)) return state;
      const next = new Map(state);
      next.delete(item.name);
      return next;
    }
  }
}
