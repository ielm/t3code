import type { CanvasSnapshot, CanvasStatePatch } from "@t3tools/contracts";
import type { CanvasHostMessage } from "@t3tools/shared/canvas";
import { htmlRenderThemeFragment, htmlRenderThemeMessage } from "@t3tools/shared/htmlRender";
import { ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";

import {
  acceptCanvasLinkRequest,
  acceptCanvasPageMessage,
  canvasFrameSrc,
  type CanvasCallOutcome,
  type CanvasCallRequest,
  type CanvasEventInput,
  type CanvasLinkRequest,
  type CanvasLogInput,
  createCanvasBridge,
  createCanvasGestureGate,
} from "./canvasBridge";

// User activation belongs to the window, not to a frame, so every canvas frame shares one gate:
// a page reloaded by a new revision or a renewed URL gets no second action from the same press.
const windowGestureGate = createCanvasGestureGate();

export interface CanvasPanelProps {
  readonly snapshot: CanvasSnapshot;
  /** Absolute URL of the canvas entry page; `null` while it loads. */
  readonly url: string | null;
  readonly onSetState: (patch: CanvasStatePatch) => void;
  readonly onEvent: (input: CanvasEventInput) => void;
  readonly onCall: (input: CanvasCallRequest) => Promise<CanvasCallOutcome>;
  readonly onLog: (input: CanvasLogInput) => void;
  /** Called only for a link the user clicked in the page. */
  readonly onOpenLink: (link: CanvasLinkRequest) => void;
  /** Turns on a library canvas's functions; `null` when this session may not run commands. */
  readonly onTrustFunctions: (() => Promise<void>) | null;
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
      {snapshot.functionsBlocked === true ? (
        <CanvasFunctionsNotice
          functions={snapshot.functions}
          onTrustFunctions={props.onTrustFunctions}
        />
      ) : null}
      {url === null ? null : (
        <CanvasFrame
          // Enabling functions reloads the page, so calls it made while they were off run again.
          key={`${snapshot.threadId}:${snapshot.name}:${snapshot.pageRevision}:${snapshot.functionsBlocked === true}`}
          {...props}
          url={url}
        />
      )}
    </div>
  );
}

function CanvasFunctionsNotice(props: {
  readonly functions: CanvasSnapshot["functions"];
  readonly onTrustFunctions: CanvasPanelProps["onTrustFunctions"];
}) {
  const { functions, onTrustFunctions } = props;
  const [enabling, setEnabling] = useState(false);
  return (
    <div className="shrink-0 p-2">
      <Alert variant="warning">
        <ShieldAlertIcon />
        <AlertTitle>This canvas's functions are off</AlertTitle>
        <AlertDescription>
          <p>
            It came from the project library, so its commands came with the repository and not from
            you or your agent. Enabling them lets this page run on the environment's machine:
          </p>
          <ul className="flex flex-col gap-0.5">
            {functions.map((declared) => (
              <li key={declared.name}>
                <code className="font-mono">{declared.name}</code>{" "}
                {declared.kind === "read"
                  ? "(read: runs whenever the page asks)"
                  : "(change: runs when you click or press a key in the canvas)"}
              </li>
            ))}
          </ul>
          {onTrustFunctions === null ? (
            <p>This connection is not allowed to run commands, so it cannot enable them.</p>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <Button
            size="sm"
            variant="outline"
            disabled={onTrustFunctions === null || enabling}
            onClick={() => {
              if (onTrustFunctions === null) return;
              setEnabling(true);
              void onTrustFunctions().finally(() => setEnabling(false));
            }}
          >
            Enable functions
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

/** Keeps the first URL while mounted; the surface remounts the panel to load a renewed one. */
function CanvasFrame(props: CanvasPanelProps & { readonly url: string }) {
  const { snapshot } = props;
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bridge] = useState(() => createCanvasBridge(snapshot.pageRevision, windowGestureGate));
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
    // The page cannot claim a gesture: activation in the frame is visible here, and the focus
    // check excludes activation from input elsewhere in the app.
    const gesture = {
      active: navigator.userActivation?.isActive === true,
      focused: document.activeElement === frame,
      now: performance.now(),
    };
    const link = acceptCanvasLinkRequest(event, frame.contentWindow, props.url);
    if (link !== undefined) {
      if (windowGestureGate.take(gesture) === "accepted") props.onOpenLink(link);
      return;
    }
    const message = acceptCanvasPageMessage(event, frame.contentWindow);
    if (message === undefined) return;
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
