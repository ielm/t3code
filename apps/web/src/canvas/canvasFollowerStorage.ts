import * as Schema from "effect/Schema";

import { readLocalStorageValue, writeLocalStorageValue } from "../hooks/useLocalStorage";
import type { CanvasFollowerState } from "./canvasFollower";

const CANVAS_FOLLOWER_STORAGE_KEY = "t3code:canvas-follower:v1";
const CANVAS_FOLLOWER_MAX_THREADS = 200;

const StoredCanvasFollowers = Schema.Record(
  Schema.String,
  Schema.Struct({ revealIds: Schema.Record(Schema.String, Schema.String) }),
);
type StoredCanvasFollowers = typeof StoredCanvasFollowers.Type;

const NO_FOLLOWERS: StoredCanvasFollowers = {};

/**
 * Keeps the most recently written threads, newest last. A thread that falls off starts over
 * from a baseline, which only costs it reveals that happened while this client was away.
 */
export function rememberCanvasFollower(
  stored: StoredCanvasFollowers,
  threadKey: string,
  follower: CanvasFollowerState,
  maxThreads = CANVAS_FOLLOWER_MAX_THREADS,
): StoredCanvasFollowers {
  const others = Object.entries(stored).filter(([key]) => key !== threadKey);
  return Object.fromEntries(
    [...others, [threadKey, follower] as const].slice(-Math.max(maxThreads, 1)),
  );
}

export function readCanvasFollower(threadKey: string): CanvasFollowerState | null {
  const stored = readLocalStorageValue(
    CANVAS_FOLLOWER_STORAGE_KEY,
    NO_FOLLOWERS,
    StoredCanvasFollowers,
  );
  return Object.hasOwn(stored, threadKey) ? (stored[threadKey] ?? null) : null;
}

export function writeCanvasFollower(threadKey: string, follower: CanvasFollowerState): void {
  writeLocalStorageValue(
    CANVAS_FOLLOWER_STORAGE_KEY,
    (stored) => rememberCanvasFollower(stored, threadKey, follower),
    NO_FOLLOWERS,
    StoredCanvasFollowers,
  );
}
