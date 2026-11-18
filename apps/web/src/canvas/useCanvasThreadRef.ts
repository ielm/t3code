import type { ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { resolveActiveThreadRouteRef } from "../threadRoutes";

/** The server thread whose canvases the right panel shows, as `startAgentOpenedCanvases` resolves it. */
export function useCanvasThreadRef(): ScopedThreadRef | null {
  const target = useThreadRouteTarget();
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  return resolveActiveThreadRouteRef(target, draft);
}
