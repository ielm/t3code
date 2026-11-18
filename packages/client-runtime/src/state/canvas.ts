import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type CanvasSnapshotsState,
  EMPTY_CANVAS_SNAPSHOTS,
  reduceCanvasSnapshots,
} from "./canvasSnapshots.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export type { CanvasSnapshotsState };

export function createCanvasEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Merge patches and events mean what they say only in the order the page sent them.
  const concurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { readonly threadId: string; readonly name: string };
    }) => JSON.stringify([environmentId, input.threadId, input.name]),
  };
  return {
    /** One thread's canvases by name. It stays loading until the server's first list arrives. */
    snapshots: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:canvas:snapshots",
      tag: WS_METHODS.subscribeCanvases,
      // `scan` emits its seed first; dropping it keeps a thread with no canvases from reading
      // as loaded before the server has answered.
      transform: (items) =>
        items.pipe(
          Stream.scan((): CanvasSnapshotsState => EMPTY_CANVAS_SNAPSHOTS, reduceCanvasSnapshots),
          Stream.drop(1),
          Stream.changesWith((left, right) => left === right),
        ),
    }),
    url: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:url",
      tag: WS_METHODS.canvasUrl,
    }),
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:set-state",
      tag: WS_METHODS.canvasSetState,
      scheduler,
      concurrency,
    }),
    sendEvent: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:send-event",
      tag: WS_METHODS.canvasSendEvent,
      scheduler,
      concurrency,
    }),
    call: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:call",
      tag: WS_METHODS.canvasCall,
    }),
    log: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:log",
      tag: WS_METHODS.canvasLog,
    }),
    trustFunctions: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:trust-functions",
      tag: WS_METHODS.canvasTrustFunctions,
    }),
    libraryList: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:library-list",
      tag: WS_METHODS.canvasLibraryList,
    }),
    librarySave: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:library-save",
      tag: WS_METHODS.canvasLibrarySave,
    }),
    libraryOpen: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:library-open",
      tag: WS_METHODS.canvasLibraryOpen,
    }),
    libraryRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:canvas:library-remove",
      tag: WS_METHODS.canvasLibraryRemove,
    }),
  };
}
