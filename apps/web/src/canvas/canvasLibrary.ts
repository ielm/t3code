import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  type CanvasLibraryEntry,
  type CanvasLibrarySaveInput,
  type CanvasLibraryScope,
  CanvasName,
  type CanvasSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { StackedThreadToastOptions } from "~/components/ui/toastHelpers";

import { canvasCommandFailure } from "./canvasCommands";

const CANVAS_NAME_MAX_LENGTH = 64;

export const isCanvasName = Schema.is(CanvasName);

export const CANVAS_LIBRARY_SCOPE_LABELS: Readonly<Record<CanvasLibraryScope, string>> = {
  project: "Project",
  personal: "Personal",
};

export const CANVAS_LIBRARY_NAMES: Readonly<Record<CanvasLibraryScope, string>> = {
  project: "the project library",
  personal: "your personal library",
};

/** Why a typed name cannot be a canvas folder name, or `null` when it can. */
export function canvasNameIssue(name: string): string | null {
  if (name === "") return "Enter a name.";
  return isCanvasName(name)
    ? null
    : "Use lowercase letters, digits and hyphens, starting with a letter or digit, up to 64 characters.";
}

/** `name` when the thread has no canvas called that, otherwise the first free `name-2`, `name-3`, … */
export function freeCanvasName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  // One more candidate than there are taken names, so one of them is free.
  for (let suffix = 2; suffix <= taken.size + 2; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${name.slice(0, CANVAS_NAME_MAX_LENGTH - ending.length)}${ending}`;
    if (!taken.has(candidate)) return candidate;
  }
  return name;
}

export interface CanvasLauncherSavedItem {
  readonly entry: CanvasLibraryEntry;
  readonly scopeLabel: string;
  /** The name to open under when the thread already has a canvas with the saved name. */
  readonly openAs: CanvasName | undefined;
}

export interface CanvasLauncherItems {
  /** Canvases open in the thread whose tab is closed. */
  readonly untabbed: ReadonlyArray<Pick<CanvasSnapshot, "name" | "title">>;
  readonly saved: ReadonlyArray<CanvasLauncherSavedItem>;
}

export function canvasLauncherItems(input: {
  readonly canvases: Iterable<Pick<CanvasSnapshot, "name" | "title">>;
  readonly tabNames: ReadonlySet<string>;
  readonly library: ReadonlyArray<CanvasLibraryEntry>;
}): CanvasLauncherItems {
  const canvases = Array.from(input.canvases);
  const taken = new Set<string>(canvases.map((canvas) => canvas.name));
  return {
    untabbed: canvases.filter((canvas) => !input.tabNames.has(canvas.name)),
    saved: input.library.map((entry) => {
      const name = freeCanvasName(entry.name, taken);
      return {
        entry,
        scopeLabel: CANVAS_LIBRARY_SCOPE_LABELS[entry.scope],
        openAs: name !== entry.name && isCanvasName(name) ? name : undefined,
      };
    }),
  };
}

export type CanvasSaveOutcome =
  | { readonly type: "saved"; readonly entry: CanvasLibraryEntry; readonly replaced: boolean }
  /** The user kept the canvas already saved under that name. */
  | { readonly type: "declined" }
  | { readonly type: "interrupted" }
  | { readonly type: "failed"; readonly message: string };

/**
 * Saves a thread canvas to a library. A saved canvas with that name is replaced only after
 * `confirmOverwrite` says so.
 */
export async function saveCanvasToLibrary(
  input: Omit<CanvasLibrarySaveInput, "overwrite">,
  deps: {
    readonly save: (
      input: CanvasLibrarySaveInput,
    ) => Promise<AtomCommandResult<CanvasLibraryEntry, unknown>>;
    readonly confirmOverwrite: (target: {
      readonly name: string;
      readonly to: CanvasLibraryScope;
    }) => Promise<boolean>;
  },
): Promise<CanvasSaveOutcome> {
  const first = await deps.save(input);
  if (first._tag === "Success") return { type: "saved", entry: first.value, replaced: false };
  if (isAtomCommandInterrupted(first)) return { type: "interrupted" };
  const failure = canvasCommandFailure(first.cause);
  if (failure.reason !== "already-exists") return { type: "failed", message: failure.message };
  const confirmed = await deps.confirmOverwrite({ name: input.as ?? input.name, to: input.to });
  if (!confirmed) return { type: "declined" };
  const second = await deps.save({ ...input, overwrite: true });
  if (second._tag === "Success") return { type: "saved", entry: second.value, replaced: true };
  if (isAtomCommandInterrupted(second)) return { type: "interrupted" };
  return { type: "failed", message: canvasCommandFailure(second.cause).message };
}

/** What to tell the user about a save, or `null` when nothing was attempted against their wish. */
export function canvasSaveToast(outcome: CanvasSaveOutcome): StackedThreadToastOptions | null {
  switch (outcome.type) {
    case "declined":
    case "interrupted":
      return null;
    case "failed":
      return { type: "error", title: "Canvas not saved", description: outcome.message };
    case "saved": {
      const library = CANVAS_LIBRARY_NAMES[outcome.entry.scope];
      return {
        type: "success",
        title: `Canvas ${outcome.replaced ? "replaced in" : "saved to"} ${library}`,
        description: outcome.entry.name,
      };
    }
  }
}
