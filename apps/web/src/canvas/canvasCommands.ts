import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { CanvasError, type CanvasCallResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import type { CanvasCallOutcome } from "./canvasBridge";

const isCanvasError = Schema.is(CanvasError);

/** What a failed canvas command tells the page or the user. */
export function canvasCommandFailure(cause: Cause.Cause<unknown>): {
  readonly reason: string;
  readonly message: string;
} {
  const error = Cause.squash(cause);
  if (isCanvasError(error)) return { reason: error.reason, message: error.message };
  return {
    // The page API knows only canvas reasons; a lost connection is a failed call to it.
    reason: "function-failed",
    message:
      error instanceof Error && error.message.trim() !== ""
        ? error.message
        : "The environment request failed.",
  };
}

export function canvasCallOutcome(
  result: AtomCommandResult<CanvasCallResult, unknown>,
): CanvasCallOutcome {
  return result._tag === "Success"
    ? { ok: true, value: result.value.value }
    : { ok: false, ...canvasCommandFailure(result.cause) };
}
