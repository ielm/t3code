import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CanvasError,
  type CanvasLibraryEntry,
  type CanvasLibrarySaveInput,
  CanvasName,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  canvasLauncherItems,
  canvasNameIssue,
  freeCanvasName,
  saveCanvasToLibrary,
} from "./canvasLibrary";

const entry = (
  scope: CanvasLibraryEntry["scope"],
  name: string,
  title = name,
): CanvasLibraryEntry => ({ scope, name: CanvasName.make(name), title, description: null });

describe("freeCanvasName", () => {
  it.each([
    ["board", [], "board"],
    ["board", ["plan"], "board"],
    ["board", ["board"], "board-2"],
    ["board", ["board", "board-2", "board-4"], "board-3"],
    ["board-2", ["board-2"], "board-2-2"],
  ])("opens %s beside %j as %s", (name, taken, expected) => {
    expect(freeCanvasName(name, new Set(taken))).toBe(expected);
  });

  it("shortens a name at the length limit so the suffix still fits", () => {
    const longest = "a".repeat(64);
    const second = `${"a".repeat(62)}-2`;

    expect(freeCanvasName(longest, new Set([longest]))).toBe(second);
    expect(freeCanvasName(longest, new Set([longest, second]))).toBe(`${"a".repeat(62)}-3`);
    expect(canvasNameIssue(second)).toBeNull();
  });
});

describe("canvasNameIssue", () => {
  it.each(["board", "a", "2024-plan", "a".repeat(64)])("accepts %s", (name) => {
    expect(canvasNameIssue(name)).toBeNull();
  });

  it.each(["", "Board", "-board", "my board", "board_2", "../x", "a".repeat(65)])(
    "rejects %j",
    (name) => {
      expect(canvasNameIssue(name)).toEqual(expect.any(String));
    },
  );
});

describe("canvasLauncherItems", () => {
  const canvases = [
    { name: CanvasName.make("board"), title: "Board" },
    { name: CanvasName.make("plan"), title: "Plan" },
  ];

  it("offers the thread's canvases that have no tab", () => {
    expect(canvasLauncherItems({ canvases, tabNames: new Set(["board"]), library: [] })).toEqual({
      untabbed: [{ name: "plan", title: "Plan" }],
      saved: [],
    });
    expect(
      canvasLauncherItems({ canvases, tabNames: new Set(["board", "plan"]), library: [] }).untabbed,
    ).toEqual([]);
  });

  it("labels saved canvases by scope and renames one whose name the thread uses", () => {
    const library = [
      entry("project", "board", "Team board"),
      entry("project", "review"),
      entry("personal", "plan"),
    ];

    expect(
      canvasLauncherItems({ canvases, tabNames: new Set(["board", "plan"]), library }).saved,
    ).toEqual([
      { entry: library[0], scopeLabel: "Project", openAs: "board-2" },
      { entry: library[1], scopeLabel: "Project", openAs: undefined },
      { entry: library[2], scopeLabel: "Personal", openAs: "plan-2" },
    ]);
  });
});

describe("saveCanvasToLibrary", () => {
  const input = {
    threadId: ThreadId.make("thread-1"),
    name: CanvasName.make("board"),
    to: "project",
  } as const;
  const saved = entry("project", "board", "Board");
  const failure = (reason: CanvasError["reason"]): AtomCommandResult<CanvasLibraryEntry, unknown> =>
    AsyncResult.failure(Cause.fail(new CanvasError({ reason })));

  const run = (
    saveInput: Omit<CanvasLibrarySaveInput, "overwrite">,
    results: ReadonlyArray<AtomCommandResult<CanvasLibraryEntry, unknown>>,
    confirm = true,
  ) => {
    const saves: Array<CanvasLibrarySaveInput> = [];
    const confirms: Array<unknown> = [];
    const outcome = saveCanvasToLibrary(saveInput, {
      save: async (next) => {
        saves.push(next);
        return results[saves.length - 1]!;
      },
      confirmOverwrite: async (target) => {
        confirms.push(target);
        return confirm;
      },
    });
    return { outcome, saves, confirms };
  };

  it("saves without asking when the name is free", async () => {
    const { outcome, saves, confirms } = run(input, [AsyncResult.success(saved)]);

    expect(await outcome).toEqual({ type: "saved", entry: saved, replaced: false });
    expect(saves).toEqual([input]);
    expect(confirms).toEqual([]);
  });

  it("asks before replacing a saved canvas, then saves again with overwrite", async () => {
    const renamed = { ...input, as: CanvasName.make("team-board") };
    const { outcome, saves, confirms } = run(renamed, [
      failure("already-exists"),
      AsyncResult.success(saved),
    ]);

    expect(await outcome).toEqual({ type: "saved", entry: saved, replaced: true });
    expect(saves).toEqual([renamed, { ...renamed, overwrite: true }]);
    expect(confirms).toEqual([{ name: "team-board", to: "project" }]);
  });

  it("keeps the saved canvas when the user declines", async () => {
    const { outcome, saves } = run(input, [failure("already-exists")], false);

    expect(await outcome).toEqual({ type: "declined" });
    expect(saves).toEqual([input]);
  });

  it("reports any other failure, from the first save or the overwrite, without asking again", async () => {
    const storage = new CanvasError({ reason: "storage-failed" }).message;

    const first = run(input, [failure("storage-failed")]);
    expect(await first.outcome).toEqual({ type: "failed", message: storage });
    expect(first.confirms).toEqual([]);

    const second = run(input, [failure("already-exists"), failure("storage-failed")]);
    expect(await second.outcome).toEqual({ type: "failed", message: storage });
    expect(second.confirms).toHaveLength(1);
  });

  it("says nothing when the save was interrupted", async () => {
    const { outcome, confirms } = run(input, [AsyncResult.failure(Cause.interrupt())]);

    expect(await outcome).toEqual({ type: "interrupted" });
    expect(confirms).toEqual([]);
  });
});
