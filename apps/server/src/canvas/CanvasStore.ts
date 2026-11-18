import type {
  CanvasError,
  CanvasManifest,
  CanvasName,
  CanvasRelativePath,
  CanvasState,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface CanvasTarget {
  readonly threadId: ThreadId;
  readonly name: CanvasName;
}

export interface CanvasFolder extends CanvasTarget {
  /** Absolute path of the folder the agent edits. */
  readonly path: string;
  /** `null` when `canvas.json` is missing or invalid; `manifestIssue` then says why. */
  readonly manifest: CanvasManifest | null;
  readonly manifestIssue: string | null;
}

export interface CanvasPersistedState {
  readonly state: CanvasState;
  readonly stateRevision: number;
}

/**
 * Canvas folders on disk. A thread canvas lives under the server state directory, in a folder this
 * fork owns. Its state file sits beside the folder, not inside it, so copying the folder to a
 * library never carries state along.
 */
export class CanvasStore extends Context.Service<
  CanvasStore,
  {
    /** Creates the folder with a starter page and manifest when it does not exist yet. */
    readonly ensure: (
      input: CanvasTarget & { readonly title?: string },
    ) => Effect.Effect<CanvasFolder, CanvasError>;
    /** Fails with `not-found` when the folder does not exist. */
    readonly get: (target: CanvasTarget) => Effect.Effect<CanvasFolder, CanvasError>;
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CanvasName>, CanvasError>;
    /** Emits the reloaded folder after its files change, debounced. Never emits on state writes. */
    readonly changes: (target: CanvasTarget) => Stream.Stream<CanvasFolder, CanvasError>;
    /** Absolute path of a file inside the folder. Fails with `invalid-path` on any escape. */
    readonly resolveFile: (
      input: CanvasTarget & { readonly path: CanvasRelativePath },
    ) => Effect.Effect<string, CanvasError>;
    /** `null` when no state was ever written. */
    readonly readState: (
      target: CanvasTarget,
    ) => Effect.Effect<CanvasPersistedState | null, CanvasError>;
    readonly writeState: (
      input: CanvasTarget & CanvasPersistedState,
    ) => Effect.Effect<void, CanvasError>;
    /** Deletes the folder and its state. Succeeds when it is already gone. */
    readonly remove: (target: CanvasTarget) => Effect.Effect<void, CanvasError>;
    readonly removeThread: (threadId: ThreadId) => Effect.Effect<void, CanvasError>;
  }
>()("t3/canvas/CanvasStore") {}
