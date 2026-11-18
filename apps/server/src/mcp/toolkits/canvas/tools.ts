import {
  CANVAS_MAX_PER_THREAD,
  CANVAS_STATE_MAX_BYTES,
  CanvasEvent,
  CanvasFunctionSummary,
  CanvasLibraryEntry,
  CanvasLibraryScope,
  CanvasName,
  CanvasState,
  CanvasStatePatch,
  NonNegativeInt,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as CanvasDiagnostics from "../../../canvas/CanvasDiagnostics.ts";
import * as CanvasLibrary from "../../../canvas/CanvasLibrary.ts";
import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const CANVAS_WAIT_DEFAULT_SECONDS = 30;
// Other providers' MCP clients give up on a call near 60 seconds.
export const CANVAS_WAIT_MAX_SECONDS = 45;

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CanvasService.CanvasService,
    CanvasLibrary.CanvasLibrary,
    CanvasDiagnostics.CanvasDiagnostics,
  ],
};

const Name = CanvasName.annotate({ description: "An open canvas." });

const STATE_LIMIT = `${CANVAS_STATE_MAX_BYTES / 1024} KB`;

const CANVAS_OPEN_DESCRIPTION = [
  [
    "Open a canvas: an interactive panel beside the chat that you build and keep updating.",
    "Use one for anything the user will look at across turns, compare, manipulate or decide on, instead of long prose.",
    "Short answers stay in chat; a one-off finished visual is `html_render`.",
  ],
  [
    "A canvas is a folder: edit `index.html` in the returned `path` and the page reloads.",
    "Send changing data with `canvas_state`, not page rewrites.",
    `The same \`name\` reopens it and keeps its files. At most ${CANVAS_MAX_PER_THREAD} per thread.`,
  ],
  [
    "Page global `canvas`: `state`, `onState(fn)`, `setState(patch)`, `send(event, payload)`, `await call(name, args)`.",
    "`send` reaches you as a message, so use it only for an explicit user action such as a button.",
    '`call` runs a function from `canvas.json`: `{"functions": {"name": {"command": ["cmd", "arg"], "kind": "read" | "change", "timeoutSeconds"?: n}}}`.',
    "The command runs in the thread's workspace with no shell and no agent turn: `args` arrive as JSON on stdin, stdout is the result, `T3_CANVAS_DIR` is the canvas folder.",
    "`read` may be called any time, `change` only from a user click or key press.",
  ],
  [
    "Plain semantic HTML is already styled and `html_render`'s theme variables are set.",
    "The page loads only files in its folder, and a saved canvas's at the relative URL `~lib/<scope>/<name>/parts/<file>`. No network.",
  ],
]
  .map((paragraph) => paragraph.join(" "))
  .join("\n\n");

const CanvasOpenTool = Tool.make("canvas_open", {
  ...shared,
  description: CANVAS_OPEN_DESCRIPTION,
  parameters: Schema.Struct({
    name: CanvasName.annotate({
      description: "Folder name, such as `release-plan`: lowercase letters, digits and hyphens.",
    }),
    title: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
        description: "Panel title, used on creation.",
      }),
    ),
    state: Schema.optionalKey(
      CanvasState.annotate({
        description: `Replaces the stored state: a JSON object up to ${STATE_LIMIT}. Omit to keep it.`,
      }),
    ),
    from: Schema.optionalKey(
      Schema.Struct({
        scope: CanvasLibraryScope,
        name: CanvasName.annotate({ description: "A saved canvas." }),
      }).annotate({
        description:
          "Create the canvas from this saved one, listed by `canvas_read`. Not for a canvas that is already open.",
      }),
    ),
  }),
  success: Schema.Struct({
    name: CanvasName,
    path: Schema.String,
    pageRevision: NonNegativeInt,
    stateRevision: NonNegativeInt,
  }),
})
  .annotate(Tool.Title, "Open canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasStateTool = Tool.make("canvas_state", {
  ...shared,
  description: `Merge a patch into a canvas's state, the JSON object you and its page share, up to ${STATE_LIMIT}. The page gets it through \`canvas.onState\` without reloading.`,
  parameters: Schema.Struct({
    name: Name,
    patch: CanvasStatePatch.annotate({
      description:
        "JSON Merge Patch: objects merge by key, `null` deletes a key, arrays are replaced whole.",
    }),
  }),
  success: Schema.Struct({ stateRevision: NonNegativeInt }),
})
  .annotate(Tool.Title, "Update canvas state")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const UserEvent = CanvasEvent.mapFields(Struct.omit(["id", "threadId"]));

const CanvasRevisions = {
  name: CanvasName,
  title: Schema.String,
  pageRevision: NonNegativeInt,
  stateRevision: NonNegativeInt,
};

// Fails through the error channel, where an image registration reads failures, as html_preview does.
export const CanvasReadTool = Tool.make("canvas_read", {
  failure: shared.failure,
  dependencies: shared.dependencies,
  description:
    "Check a canvas after you change it: its state, functions, the user's recent actions, the page's recent errors and a screenshot. No `name`: this thread's open canvases and the saved ones `canvas_open` can start `from`.",
  parameters: Schema.Struct({ name: Schema.optionalKey(Name) }),
  success: Schema.Union([
    Schema.Struct({
      ...CanvasRevisions,
      path: Schema.String,
      state: CanvasState,
      functions: Schema.Array(CanvasFunctionSummary),
      manifestIssue: Schema.optionalKey(Schema.String),
      events: Schema.Array(UserEvent),
      errors: Schema.Array(
        Schema.Struct({
          level: Schema.Literals(["error", "warning"]),
          text: Schema.String,
          at: Schema.String,
          count: Schema.optionalKey(Schema.Int),
        }),
      ),
      screenshot: Schema.optionalKey(
        Schema.Struct({
          mimeType: Schema.Literal("image/png"),
          data: Schema.String,
          width: Schema.Int,
          height: Schema.Int,
        }),
      ),
      screenshotError: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      canvases: Schema.Array(Schema.Struct(CanvasRevisions)),
      saved: Schema.Array(CanvasLibraryEntry),
    }),
  ]),
})
  .annotate(Tool.Title, "Read canvas")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasWaitTool = Tool.make("canvas_wait", {
  ...shared,
  description:
    "Wait for the user's next `canvas.send` and get it here instead of as a message, to act on it in this turn. No `name`: any canvas. On timeout, call again.",
  parameters: Schema.Struct({
    name: Schema.optionalKey(Name),
    timeoutSeconds: Schema.optionalKey(
      Schema.Finite.annotate({
        description: `Default ${CANVAS_WAIT_DEFAULT_SECONDS}, at most ${CANVAS_WAIT_MAX_SECONDS}.`,
      }),
    ),
  }),
  success: Schema.Struct({ timedOut: Schema.Boolean, event: Schema.optionalKey(UserEvent) }),
})
  .annotate(Tool.Title, "Wait for a canvas action")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasSaveTool = Tool.make("canvas_save", {
  ...shared,
  description:
    "Copy a canvas's files, not its state, into a library so other threads can open it: `project` is `.canvases/` in the workspace, `personal` stays on this machine.",
  parameters: Schema.Struct({
    name: Name,
    to: CanvasLibraryScope,
    as: Schema.optionalKey(CanvasName.annotate({ description: "Saved name. Default: `name`." })),
    overwrite: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Replace a saved canvas of that name." }),
    ),
  }),
  success: Schema.Struct({ ...CanvasLibraryEntry.fields, path: Schema.String }),
})
  .annotate(Tool.Title, "Save canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasCloseTool = Tool.make("canvas_close", {
  ...shared,
  description:
    "Remove a canvas from the user's view and delete its folder and state. Only when the user is done with it or asks.",
  parameters: Schema.Struct({ name: Name }),
  success: Schema.Record(Schema.String, Schema.Never),
})
  .annotate(Tool.Title, "Close canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const standardTools = [
  CanvasOpenTool,
  CanvasStateTool,
  CanvasWaitTool,
  CanvasSaveTool,
  CanvasCloseTool,
] as const;

/** Everything but `canvas_read`, for a server that registers that one as an image tool. */
export const CanvasStandardToolkit = Toolkit.make(...standardTools);

export const CanvasReadToolkit = Toolkit.make(CanvasReadTool);

export const CanvasToolkit = Toolkit.make(...standardTools, CanvasReadTool);
