import { type CanvasSnapshot, CanvasName, ThreadId } from "@t3tools/contracts";
import { CANVAS_BRIDGE_VERSION } from "@t3tools/shared/canvas";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";

import { CanvasPanel } from "./CanvasPanel";

const snapshot: CanvasSnapshot = {
  threadId: ThreadId.make("thread-1"),
  name: CanvasName.make("board"),
  title: "Board",
  pageRevision: 3,
  stateRevision: 5,
  state: { count: 1 },
  functions: [{ name: "refresh", kind: "read" }],
  revealId: "reveal-1",
  manifestIssue: "canvas.json is not valid JSON.",
};

// The page reports every canvas message it receives as an event, so the test observes the
// host's posts through `onEvent`. A blob URL cannot carry the revision query, so this is a data URL.
const PAGE_URL = `data:text/html,${encodeURIComponent(`<script>
  var v = ${CANVAS_BRIDGE_VERSION};
  addEventListener("message", function (e) {
    if (e.source === parent && e.data && e.data.t3canvas === v) {
      parent.postMessage({ t3canvas: v, type: "event", event: "received", payload: e.data }, "*");
    }
  });
  parent.postMessage({ t3canvas: v, type: "ready" }, "*");
</script>`)}`;

it("answers the page's ready with init, forwards its events, and posts later state", async () => {
  const onEvent = vi.fn();
  const handlers = {
    onSetState: vi.fn(),
    onEvent,
    onCall: vi.fn(),
    onLog: vi.fn(),
  };
  await using screen = await render(
    <CanvasPanel snapshot={snapshot} url={PAGE_URL} {...handlers} />,
  );

  const frame = screen.getByTitle("Board");
  await expect.element(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("canvas.json is not valid JSON.");
  await vi.waitFor(() =>
    expect(onEvent).toHaveBeenCalledWith({
      event: "received",
      pageRevision: 3,
      payload: {
        t3canvas: CANVAS_BRIDGE_VERSION,
        type: "init",
        name: "board",
        title: "Board",
        state: { count: 1 },
        stateRevision: 5,
        functions: [{ name: "refresh", kind: "read" }],
      },
    }),
  );

  await screen.rerender(
    <CanvasPanel
      snapshot={{ ...snapshot, stateRevision: 6, state: { count: 2 } }}
      url={PAGE_URL}
      {...handlers}
    />,
  );
  await vi.waitFor(() =>
    expect(onEvent).toHaveBeenCalledWith({
      event: "received",
      pageRevision: 3,
      payload: {
        t3canvas: CANVAS_BRIDGE_VERSION,
        type: "state",
        state: { count: 2 },
        stateRevision: 6,
      },
    }),
  );
});
