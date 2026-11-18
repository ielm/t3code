import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { CanvasSnapshotsState } from "@t3tools/client-runtime/state/canvas";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";

import { useComposerDraftStore } from "../composerDraftStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { canvasEnvironment } from "../state/canvas";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../threadRoutes";
import { type CanvasFollowerState, followCanvases } from "./canvasFollower";
import { readCanvasFollower, writeCanvasFollower } from "./canvasFollowerStorage";
import { canvasTabs, reconcileCanvasTabs } from "./canvasTabs";

const readPanel = (threadRef: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

/**
 * Brings a thread's canvas tabs in line with the canvases the server reports and returns the
 * follower state to keep. A canvas the agent revealed opens the panel on its tab; on a sheet
 * layout, where the panel would cover the chat, the tab is selected and waits behind the panel
 * toggle. Tabs of canvases that are gone close, and the rest take the current titles.
 */
export function applyCanvasSnapshots(
  threadRef: ScopedThreadRef,
  canvases: CanvasSnapshotsState,
  follower: CanvasFollowerState | null,
  options: { readonly sheetLayout: boolean },
): CanvasFollowerState {
  const store = useRightPanelStore.getState();
  const result = followCanvases({
    follower,
    canvases: canvases.values(),
    openTabs: new Set(canvasTabs(readPanel(threadRef).surfaces).map((tab) => tab.name)),
  });
  for (const action of result.actions) {
    const canvas = canvases.get(action.name);
    // Reconciling below closes the tabs the follower asks to close.
    if (action.type === "close" || canvas === undefined) continue;
    store.openCanvas(
      threadRef,
      { name: canvas.name, title: canvas.title },
      options.sheetLayout ? "quiet" : "show",
    );
  }
  const titles = new Map(Array.from(canvases.values(), (canvas) => [canvas.name, canvas.title]));
  const panel = readPanel(threadRef);
  // Every store write notifies this follower again, so only write a real change.
  if (reconcileCanvasTabs(panel, titles) !== panel) {
    store.reconcileCanvasSurfaces(threadRef, titles);
  }
  return result.follower;
}

/**
 * Follows one thread's canvases while it is open. The follower state is loaded from and saved
 * to local storage, so a reload neither reopens tabs the user closed nor misses a reveal that
 * happened while this client was away.
 */
function followThreadCanvases(threadRef: ScopedThreadRef): () => void {
  const threadKey = scopedThreadKey(threadRef);
  const atom = canvasEnvironment.snapshots({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  let follower = readCanvasFollower(threadKey);
  let applying = false;
  let pending = false;
  const apply = () => {
    pending = true;
    // Applying writes the panel store, which calls back in here.
    if (applying) return;
    applying = true;
    try {
      while (pending) {
        pending = false;
        // Until the first list arrives nothing is known, so no tab may close.
        const canvases = AsyncResult.getOrElse(appAtomRegistry.get(atom), () => null);
        if (canvases === null) continue;
        const next = applyCanvasSnapshots(threadRef, canvases, follower, {
          sheetLayout: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches,
        });
        if (next === follower) continue;
        follower = next;
        writeCanvasFollower(threadKey, next);
      }
    } finally {
      applying = false;
    }
  };
  const stopCanvases = appAtomRegistry.subscribe(atom, apply, { immediate: true });
  // A tab reopened from the closed-tab history has to close again if its canvas is gone.
  const stopPanel = useRightPanelStore.subscribe((state, previous) => {
    if (state.byThreadKey[threadKey] !== previous.byThreadKey[threadKey]) apply();
  });
  return () => {
    stopCanvases();
    stopPanel();
  };
}

function readOpenThreadRef(router: AnyRouter): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  return resolveActiveThreadRouteRef(target, draft);
}

/**
 * Follows the open thread's canvases for the life of the page. Only the open thread holds a
 * subscription; a reveal in another thread shows when the user next opens that thread.
 */
export function startAgentOpenedCanvases(router: AnyRouter): () => void {
  let followed: { readonly threadKey: string; readonly stop: () => void } | null = null;
  const follow = () => {
    const threadRef = readOpenThreadRef(router);
    const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
    if (threadKey === (followed?.threadKey ?? null)) return;
    followed?.stop();
    followed =
      threadRef === null || threadKey === null
        ? null
        : { threadKey, stop: followThreadCanvases(threadRef) };
  };
  follow();
  const stopRouter = router.subscribe("onResolved", follow);
  // A draft keeps its route when its server thread arrives.
  const stopDrafts = useComposerDraftStore.subscribe(follow);
  return () => {
    stopRouter();
    stopDrafts();
    followed?.stop();
  };
}
