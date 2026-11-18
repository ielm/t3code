import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { CanvasLibraryEntry, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { LayoutDashboard, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { stackedThreadToast } from "~/components/ui/toastHelpers";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { canvasEnvironment } from "~/state/canvas";
import { useAtomCommand } from "~/state/use-atom-command";

import { canvasCommandFailure } from "./canvasCommands";
import {
  CANVAS_LIBRARY_NAMES,
  type CanvasLauncherSavedItem,
  canvasLauncherItems,
} from "./canvasLibrary";
import { canvasTabs } from "./canvasTabs";
import { useCanvasThreadRef } from "./useCanvasThreadRef";

type CanvasLauncherVariant = "list" | "menu";

const NO_CANVASES: ReadonlyArray<never> = [];
const LIST_ROW_CLASS =
  "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors hover:bg-accent/60 disabled:cursor-default disabled:opacity-50";

const libraryKey = (entry: CanvasLibraryEntry) => `${entry.scope}:${entry.name}`;

/**
 * The Canvases group of the right panel's surface launcher: the thread's canvases whose tab is
 * closed, and the saved ones. `list` suits the empty panel, `menu` the add-surface menu.
 */
export function CanvasLauncherGroup(props: { readonly variant: CanvasLauncherVariant }) {
  const threadRef = useCanvasThreadRef();
  if (threadRef === null) return null;
  return (
    <ThreadCanvasLauncherGroup
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
      variant={props.variant}
    />
  );
}

function ThreadCanvasLauncherGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly variant: CanvasLauncherVariant;
}) {
  const { environmentId, threadId } = props;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const snapshots = useAtomValue(
    canvasEnvironment.snapshots({ environmentId, input: { threadId } }),
  );
  const surfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const listLibrary = useAtomCommand(canvasEnvironment.libraryList, { reportFailure: false });
  const openSaved = useAtomCommand(canvasEnvironment.libraryOpen, { reportFailure: false });
  const removeSaved = useAtomCommand(canvasEnvironment.libraryRemove, { reportFailure: false });
  const canOpenSaved = useAtomValue(canvasEnvironment.libraryOpen.permissionAtom(environmentId));
  const canRemoveSaved = useAtomValue(
    canvasEnvironment.libraryRemove.permissionAtom(environmentId),
  );
  const [library, setLibrary] = useState<ReadonlyArray<CanvasLibraryEntry>>([]);
  const [busy, setBusy] = useState(false);

  const loadLibrary = useEffectEvent(() => {
    void listLibrary({ environmentId, input: { threadId } }).then((result) => {
      if (result._tag === "Success") setLibrary(result.value.entries);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment for its saved canvases once, when the launcher opens
  useEffect(() => loadLibrary(), []);

  const { untabbed, saved } = canvasLauncherItems({
    canvases: AsyncResult.getOrElse(snapshots, () => null)?.values() ?? NO_CANVASES,
    tabNames: new Set(canvasTabs(surfaces).map((tab) => tab.name)),
    library,
  });
  if (untabbed.length === 0 && saved.length === 0) return null;

  const openTab = (canvas: { readonly name: string; readonly title: string }) =>
    useRightPanelStore.getState().openCanvas(threadRef, { name: canvas.name, title: canvas.title });
  const reportFailure = (title: string, cause: Cause.Cause<unknown>) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: canvasCommandFailure(cause).message,
      }),
    );
  const open = ({ entry, openAs }: CanvasLauncherSavedItem) => {
    setBusy(true);
    void openSaved({
      environmentId,
      input: {
        threadId,
        scope: entry.scope,
        name: entry.name,
        ...(openAs === undefined ? {} : { as: openAs }),
      },
    }).then((result) => {
      setBusy(false);
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") reportFailure("Canvas not opened", result.cause);
      else openTab(result.value);
    });
  };
  const remove = ({ entry }: CanvasLauncherSavedItem) => {
    setBusy(true);
    void removeSaved({
      environmentId,
      input: { threadId, scope: entry.scope, name: entry.name },
    }).then((result) => {
      setBusy(false);
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        reportFailure("Canvas not removed", result.cause);
        return;
      }
      setLibrary((current) => current.filter((other) => libraryKey(other) !== libraryKey(entry)));
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Canvas removed from ${CANVAS_LIBRARY_NAMES[entry.scope]}`,
          description: entry.name,
        }),
      );
    });
  };

  if (props.variant === "menu") {
    return (
      <>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Canvases</MenuGroupLabel>
          {untabbed.map((canvas) => (
            <MenuItem key={canvas.name} onClick={() => openTab(canvas)}>
              <LayoutDashboard />
              <span className="min-w-0 truncate">{canvas.title}</span>
            </MenuItem>
          ))}
          {saved.map((item) => (
            <MenuSub key={libraryKey(item.entry)}>
              <MenuSubTrigger>
                <LayoutDashboard />
                <span className="min-w-0 flex-1 truncate">{item.entry.title}</span>
                <MenuItemDetail>{item.scopeLabel}</MenuItemDetail>
              </MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem disabled={!canOpenSaved} onClick={() => open(item)}>
                  Open
                </MenuItem>
                <MenuItem
                  variant="destructive"
                  disabled={!canRemoveSaved}
                  onClick={() => remove(item)}
                >
                  Remove from library
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          ))}
        </MenuGroup>
      </>
    );
  }

  return (
    <section aria-label="Canvases" className="mt-4 flex flex-col gap-0.5">
      <h4 className="px-2.5 pb-1 font-medium text-muted-foreground text-xs">Canvases</h4>
      {untabbed.map((canvas) => (
        <button
          key={canvas.name}
          type="button"
          className={LIST_ROW_CLASS}
          onClick={() => openTab(canvas)}
        >
          <LayoutDashboard className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{canvas.title}</span>
        </button>
      ))}
      {saved.map((item) => {
        const removeLabel = `Remove ${item.entry.title} from ${CANVAS_LIBRARY_NAMES[item.entry.scope]}`;
        return (
          <div key={libraryKey(item.entry)} className="flex items-center gap-1">
            <button
              type="button"
              className={LIST_ROW_CLASS}
              disabled={busy || !canOpenSaved}
              onClick={() => open(item)}
            >
              <LayoutDashboard className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.entry.title}</span>
              <span className="shrink-0 text-muted-foreground text-xs">{item.scopeLabel}</span>
            </button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={removeLabel}
                    disabled={busy || !canRemoveSaved}
                    size="icon-xs"
                    variant="ghost-muted"
                    onClick={() => remove(item)}
                  />
                }
              >
                <Trash2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Remove from library</TooltipPopup>
            </Tooltip>
          </div>
        );
      })}
    </section>
  );
}
