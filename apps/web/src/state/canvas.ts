import { createCanvasEnvironmentAtoms } from "@t3tools/client-runtime/state/canvas";
import type { CanvasSnapshot, EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const canvasEnvironment = createCanvasEnvironmentAtoms(connectionAtomRuntime);

const canvasSnapshotFamily = Atom.family((key: string) => {
  const [environmentId, threadId, name] = JSON.parse(key) as [EnvironmentId, ThreadId, string];
  const snapshots = canvasEnvironment.snapshots({ environmentId, input: { threadId } });
  return Atom.make(
    (get): CanvasSnapshot | null =>
      AsyncResult.getOrElse(get(snapshots), () => null)?.get(name) ?? null,
  ).pipe(Atom.withLabel(`canvas-snapshot:${key}`));
});

/** One canvas, or `null` while its thread's list loads or once the canvas is gone. */
export const canvasSnapshotAtom = (threadRef: ScopedThreadRef, name: string) =>
  canvasSnapshotFamily(JSON.stringify([threadRef.environmentId, threadRef.threadId, name]));
