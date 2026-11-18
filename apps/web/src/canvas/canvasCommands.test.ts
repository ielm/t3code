import { CanvasError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { canvasCallOutcome } from "./canvasCommands";

describe("canvasCallOutcome", () => {
  it("passes a function's value to the page", () => {
    expect(canvasCallOutcome(AsyncResult.success({ value: { rows: 3 } }))).toEqual({
      ok: true,
      value: { rows: 3 },
    });
  });

  it("gives the page a canvas error's reason and message", () => {
    const error = new CanvasError({ reason: "function-needs-gesture", canvas: "plan" });

    expect(canvasCallOutcome(AsyncResult.failure(Cause.fail(error)))).toEqual({
      ok: false,
      reason: "function-needs-gesture",
      message: error.message,
    });
  });

  it("reports any other failure as a failed function", () => {
    expect(canvasCallOutcome(AsyncResult.failure(Cause.fail(new Error("Not connected."))))).toEqual(
      { ok: false, reason: "function-failed", message: "Not connected." },
    );
    expect(canvasCallOutcome(AsyncResult.failure(Cause.die("boom")))).toEqual({
      ok: false,
      reason: "function-failed",
      message: "The environment request failed.",
    });
  });
});
