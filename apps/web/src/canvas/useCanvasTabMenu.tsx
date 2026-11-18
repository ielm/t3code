import type { CanvasLibraryScope, ContextMenuItem } from "@t3tools/contracts";
import { type ReactNode, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toastManager } from "~/components/ui/toast";
import { stackedThreadToast } from "~/components/ui/toastHelpers";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { readLocalApi } from "~/localApi";
import type { RightPanelSurface } from "~/rightPanelStore";
import { canvasEnvironment } from "~/state/canvas";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  CANVAS_LIBRARY_NAMES,
  CANVAS_LIBRARY_SCOPE_LABELS,
  canvasNameIssue,
  canvasSaveToast,
  isCanvasName,
  saveCanvasToLibrary,
} from "./canvasLibrary";
import { useCanvasThreadRef } from "./useCanvasThreadRef";

type CanvasTab = Extract<RightPanelSurface, { kind: "canvas" }>;

const CANVAS_TAB_MENU_ITEMS = [
  { id: "canvas-save-project", label: "Save to project" },
  { id: "canvas-save-personal", label: "Save to personal library" },
  { id: "canvas-save-as", label: "Save as…" },
] as const satisfies ReadonlyArray<ContextMenuItem>;

export type CanvasTabMenuAction = (typeof CANVAS_TAB_MENU_ITEMS)[number]["id"];

const isCanvasTabMenuAction = (action: string | null): action is CanvasTabMenuAction =>
  CANVAS_TAB_MENU_ITEMS.some((item) => item.id === action);

interface CanvasSaveAsDraft {
  readonly canvas: CanvasTab;
  readonly as: string;
  readonly to: CanvasLibraryScope;
}

const confirmOverwrite = async (target: {
  readonly name: string;
  readonly to: CanvasLibraryScope;
}) =>
  (await readLocalApi()?.dialogs.confirm(
    `Replace the saved canvas "${target.name}"?\nA canvas with that name is already in ${CANVAS_LIBRARY_NAMES[target.to]}.`,
    { variant: "destructive" },
  )) === true;

/**
 * The library entries of a canvas tab's context menu. `items`, `handles` and `run` plug into the
 * menu the tab strip already builds; `dialog` is the "Save as" prompt and has to be rendered.
 */
export function useCanvasTabMenu(): {
  readonly items: (
    surface: RightPanelSurface,
  ) => ReadonlyArray<ContextMenuItem<CanvasTabMenuAction>>;
  readonly handles: (action: string | null) => action is CanvasTabMenuAction;
  readonly run: (surface: RightPanelSurface, action: CanvasTabMenuAction) => void;
  readonly dialog: ReactNode;
} {
  const threadRef = useCanvasThreadRef();
  const saveCommand = useAtomCommand(canvasEnvironment.librarySave, { reportFailure: false });
  const [saveAs, setSaveAs] = useState<CanvasSaveAsDraft | null>(null);

  const save = async (draft: CanvasSaveAsDraft, renamed: boolean) => {
    const { canvas, as, to } = draft;
    if (threadRef === null || !isCanvasName(canvas.name) || !isCanvasName(as)) return;
    const { environmentId, threadId } = threadRef;
    const outcome = await saveCanvasToLibrary(
      { threadId, name: canvas.name, to, ...(renamed ? { as } : {}) },
      { save: (input) => saveCommand({ environmentId, input }), confirmOverwrite },
    );
    // Back to the prompt with what was typed, so another name is one edit away.
    if (outcome.type === "declined" && renamed) setSaveAs(draft);
    const toast = canvasSaveToast(outcome);
    if (toast !== null) toastManager.add(stackedThreadToast(toast));
  };

  return {
    items: (surface) =>
      surface.kind === "canvas" && threadRef !== null ? CANVAS_TAB_MENU_ITEMS : [],
    handles: isCanvasTabMenuAction,
    run: (surface, action) => {
      if (surface.kind !== "canvas") return;
      switch (action) {
        case "canvas-save-project":
          void save({ canvas: surface, as: surface.name, to: "project" }, false);
          return;
        case "canvas-save-personal":
          void save({ canvas: surface, as: surface.name, to: "personal" }, false);
          return;
        case "canvas-save-as":
          setSaveAs({ canvas: surface, as: surface.name, to: "project" });
      }
    },
    dialog:
      saveAs === null ? null : (
        <CanvasSaveAsDialog
          draft={saveAs}
          onClose={() => setSaveAs(null)}
          onSave={(draft) => {
            setSaveAs(null);
            void save(draft, true);
          }}
        />
      ),
  };
}

function CanvasSaveAsDialog(props: {
  readonly draft: CanvasSaveAsDraft;
  readonly onClose: () => void;
  readonly onSave: (draft: CanvasSaveAsDraft) => void;
}) {
  const { canvas } = props.draft;
  const id = useId();
  const [name, setName] = useState(props.draft.as);
  const [to, setTo] = useState(props.draft.to);
  const [issue, setIssue] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const as = name.trim();
            const problem = canvasNameIssue(as);
            if (problem === null) props.onSave({ canvas, as, to });
            else setIssue(problem);
          }}
        >
          <DialogHeader>
            <DialogTitle>Save canvas as</DialogTitle>
            <DialogDescription>
              Saves a copy of {canvas.title ?? canvas.name} to open in other threads. Its state is
              not saved.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-name`}>
                Name
                <Input
                  id={`${id}-name`}
                  font="mono"
                  autoFocus
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  aria-invalid={issue !== null}
                  aria-describedby={issue === null ? undefined : `${id}-issue`}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setIssue(null);
                  }}
                />
              </Label>
              <ToggleGroup
                aria-label="Library"
                className="w-full *:flex-1"
                value={[to]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "project" || value === "personal") setTo(value);
                }}
              >
                <Toggle value="project">{CANVAS_LIBRARY_SCOPE_LABELS.project}</Toggle>
                <Toggle value="personal">{CANVAS_LIBRARY_SCOPE_LABELS.personal}</Toggle>
              </ToggleGroup>
              {issue === null ? null : (
                <p id={`${id}-issue`} role="alert" className="text-destructive">
                  {issue}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
