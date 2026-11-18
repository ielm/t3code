import type { CanvasSnapshot, CanvasStatePatch } from "@t3tools/contracts";
import type { CanvasHostMessage } from "@t3tools/shared/canvas";
import { htmlRenderThemeFragment, htmlRenderThemeMessage } from "@t3tools/shared/htmlRender";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";

import {
  acceptCanvasPageMessage,
  canvasFrameSrc,
  type CanvasCallOutcome,
  type CanvasCallRequest,
  type CanvasEventInput,
  type CanvasLogInput,
  createCanvasBridge,
} from "./canvasBridge";

export interface CanvasPanelProps {
  readonly snapshot: CanvasSnapshot;
  /** Absolute URL of the canvas entry page; `null` while it loads. */
  readonly url: string | null;
  readonly onSetState: (patch: CanvasStatePatch) => void;
  readonly onEvent: (input: CanvasEventInput) => void;
  readonly onCall: (input: CanvasCallRequest) => Promise<CanvasCallOutcome>;
  readonly onLog: (input: CanvasLogInput) => void;
}

export function CanvasPanel(props: CanvasPanelProps) {
  const { snapshot, url } = props;
  return (
    <div className="flex size-full min-h-0 flex-col">
      {snapshot.manifestIssue === undefined ? null : (
        <div className="shrink-0 p-2">
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertDescription>{snapshot.manifestIssue}</AlertDescription>
          </Alert>
        </div>
      )}
      {url === null ? null : (
        <CanvasFrame
          key={`${snapshot.threadId}:${snapshot.name}:${snapshot.pageRevision}`}
          {...props}
          url={url}
        />
      )}
    </div>
  );
}

/** Keeps the first URL while mounted; a renewed URL must not reload the page. */
function CanvasFrame(props: CanvasPanelProps & { readonly url: string }) {
  const { snapshot } = props;
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bridge] = useState(() => createCanvasBridge(snapshot.pageRevision));
  const [src] = useState(() =>
    canvasFrameSrc(props.url, snapshot.pageRevision, htmlRenderThemeFragment(theme)),
  );
  const [loaded, setLoaded] = useState(false);
  const post = (message: CanvasHostMessage | ReturnType<typeof htmlRenderThemeMessage>) => {
    frameRef.current?.contentWindow?.postMessage(message, "*");
  };
  const postTheme = () => post(htmlRenderThemeMessage(theme));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts the current theme to the sandboxed iframe's window
  useEffect(postTheme, [theme]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts each new state revision to the sandboxed iframe's window
  useEffect(() => {
    const message = bridge.stateUpdate(snapshot);
    if (message !== undefined) frameRef.current?.contentWindow?.postMessage(message, "*");
  }, [bridge, snapshot]);
  const onFrameMessage = useEffectEvent((frame: HTMLIFrameElement, event: MessageEvent) => {
    const message = acceptCanvasPageMessage(event, frame.contentWindow);
    if (message === undefined) return;
    // The page cannot claim a gesture: activation in the frame is visible here, and the focus
    // check excludes activation from input elsewhere in the app.
    const gesture = navigator.userActivation?.isActive === true && document.activeElement === frame;
    const action = bridge.receive(message, { snapshot, gesture });
    switch (action.type) {
      case "post":
        post(action.message);
        postTheme();
        return;
      case "setState":
        props.onSetState(action.patch);
        return;
      case "event":
        props.onEvent(action.input);
        return;
      case "log":
        props.onLog(action.input);
        return;
      case "call": {
        const settle = (outcome: CanvasCallOutcome) => {
          const result = action.settle(outcome);
          if (result !== undefined) post(result);
        };
        void props.onCall(action.input).then(settle, (cause: unknown) =>
          settle({
            ok: false,
            reason: "function-failed",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches a window message listener for the iframe at commit, before the page's ready message
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const onMessage = (event: MessageEvent) => onFrameMessage(frame, event);
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={snapshot.title}
      // Only allow-scripts: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => {
        setLoaded(true);
        // Covers a theme change that landed while the page was loading.
        postTheme();
      }}
      // Match the blank document's scheme to avoid dark-mode white flashes, then follow the app after load.
      className="min-h-0 w-full flex-1 border-0 scheme-light"
      style={loaded ? { colorScheme: theme.appearance } : undefined}
    />
  );
}
