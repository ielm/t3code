import {
  CANVAS_MAX_PER_THREAD,
  CANVAS_STATE_MAX_BYTES,
  CanvasName,
  CanvasState,
  CanvasStatePatch,
  NonNegativeInt,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CanvasService.CanvasService,
  ],
};

const Name = CanvasName.annotate({
  description:
    "The canvas's folder name, such as `release-plan`: lowercase letters, digits and hyphens.",
});

const STATE_LIMIT = `${CANVAS_STATE_MAX_BYTES / 1024} KB`;

const CANVAS_OPEN_DESCRIPTION = [
  "Open a canvas, an interactive panel beside the chat that you build and keep updating, and show it to the user.",
  "Use one for anything the user will look at across turns, compare, manipulate or decide on, and to show structure, status and results instead of long prose.",
  "Short answers stay in chat. A one-off finished visual is `html_render`.",
  "\n\nA canvas is a folder. Edit `index.html` in the returned `path` with your file tools and the page reloads.",
  "Push data that changes with `canvas_state`, not by rewriting the page.",
  `The same \`name\` reopens that canvas and keeps its files. A thread holds at most ${CANVAS_MAX_PER_THREAD}.`,
  "\n\nThe page has a global `canvas`: `canvas.state`, `canvas.onState(fn)`, `canvas.setState(patch)`, `canvas.send(event, payload)`, `canvas.call(name, args)`.",
  "A `canvas.send` reaches you as a message, so call it only from an explicit user action such as a button.",
  "`canvas.call` runs a command on this machine with no agent turn.",
  'Declare it in `canvas.json` as `{"functions": {"name": {"command": [...], "kind": "read" | "change"}}}`.',
  "It gets `args` as JSON on stdin and its stdout is the result. A `change` function runs only from a click or key press.",
  "\n\nPlain semantic HTML is already styled, and the theme CSS variables of `html_render` are set.",
  "The page has no network access, so inline everything.",
].join(" ");

const CanvasOpenTool = Tool.make("canvas_open", {
  ...shared,
  description: CANVAS_OPEN_DESCRIPTION,
  parameters: Schema.Struct({
    name: Name,
    title: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
        description: "Shown on the panel. Used when the canvas is created.",
      }),
    ),
    state: Schema.optionalKey(
      CanvasState.annotate({
        description: `Replaces the stored state with this JSON object, up to ${STATE_LIMIT}. Omit to keep it.`,
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
  description: `Change a canvas's state, the one JSON object you and its page share. The page gets it through \`canvas.onState\` without reloading. Use this for data that changes; edit the files only to change the page itself. State is limited to ${STATE_LIMIT}.`,
  parameters: Schema.Struct({
    name: Name,
    patch: CanvasStatePatch.annotate({
      description:
        "JSON Merge Patch: objects merge key by key, `null` deletes a key, arrays are replaced whole.",
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

const CanvasCloseTool = Tool.make("canvas_close", {
  ...shared,
  description:
    "Remove a canvas from the user's view and delete its folder and state. Only when the user is done with it or asks; a canvas they may come back to stays open.",
  parameters: Schema.Struct({ name: Name }),
  success: Schema.Record(Schema.String, Schema.Never),
})
  .annotate(Tool.Title, "Close canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const CanvasToolkit = Toolkit.make(CanvasOpenTool, CanvasStateTool, CanvasCloseTool);
