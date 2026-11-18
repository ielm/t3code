import { useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { stackedThreadToast } from "~/components/ui/toastHelpers";
import { environmentCatalog } from "~/connection/catalog";
import { canvasEnvironment, canvasSnapshotAtom } from "~/state/canvas";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { canvasCallOutcome, canvasCommandFailure } from "./canvasCommands";
import { CanvasPanel } from "./CanvasPanel";
import {
  canvasClientOrigin,
  canvasUrlNeedsMint,
  type MintedCanvasUrl,
  resolveCanvasUrl,
} from "./canvasUrl";

type CanvasUrlState =
  | { readonly _tag: "Minted"; readonly minted: MintedCanvasUrl }
  | { readonly _tag: "Failed"; readonly message: string }
  | null;

function CanvasPlaceholder(props: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex size-full min-h-0 items-center justify-center p-4 text-center text-muted-foreground text-xs"
    >
      {props.children}
    </div>
  );
}

/** A canvas tab's body: the thread's live canvas wired to the sandboxed page. */
export default function CanvasSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly name: string;
}) {
  const { threadRef, name } = props;
  const { environmentId, threadId } = threadRef;
  const snapshot = useAtomValue(canvasSnapshotAtom(threadRef, name));
  const connection = usePreparedConnection(environmentId);
  const origin = canvasClientOrigin(Option.getOrNull(connection)?.httpBaseUrl);
  const pageRevision = snapshot?.pageRevision ?? null;

  const mintUrl = useAtomCommand(canvasEnvironment.url, { reportFailure: false });
  const setState = useAtomCommand(canvasEnvironment.setState);
  const sendEvent = useAtomCommand(canvasEnvironment.sendEvent, { reportFailure: false });
  const call = useAtomCommand(canvasEnvironment.call, { reportFailure: false });
  const log = useAtomCommand(canvasEnvironment.log, { reportFailure: false });

  const [urlState, setUrlState] = useState<CanvasUrlState>(null);
  const minted = urlState?._tag === "Minted" ? urlState.minted : null;
  const settleUrl = useEffectEvent(
    (signedFor: string, result: Awaited<ReturnType<typeof mintUrl>>) => {
      // An answer for an origin the client has since left would never load.
      if (signedFor !== origin || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        const message = canvasCommandFailure(result.cause).message;
        // A page already showing keeps the URL it has until that stops working.
        setUrlState((current) =>
          current?._tag === "Minted" ? current : { _tag: "Failed", message },
        );
        return;
      }
      const url = resolveCanvasUrl(signedFor, result.value.url);
      setUrlState(
        url === null
          ? { _tag: "Failed", message: "The environment returned an unusable canvas address." }
          : {
              _tag: "Minted",
              minted: { origin: signedFor, url, expiresAt: Date.parse(result.value.expiresAt) },
            },
      );
    },
  );
  const mintIfNeeded = useEffectEvent((clientOrigin: string | null, revision: number | null) => {
    if (clientOrigin === null || revision === null) return;
    if (!canvasUrlNeedsMint(minted, clientOrigin, Date.now())) return;
    void mintUrl({ environmentId, input: { threadId, name, origin: clientOrigin } }).then(
      (result) => settleUrl(clientOrigin, result),
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for a signed page URL when a page revision or a changed origin needs one
  useEffect(() => mintIfNeeded(origin, pageRevision), [origin, pageRevision]);
  // A mint fails at once while the environment is unreachable; ask again once a new session is up.
  const sessionGeneration = environmentCatalog.sessionGenerationAtom(environmentId);
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => mintIfNeeded(origin, pageRevision));

  if (snapshot === null) return <CanvasPlaceholder>Loading canvas…</CanvasPlaceholder>;
  const url = minted !== null && minted.origin === origin ? minted.url : null;
  if (url === null) {
    return (
      <CanvasPlaceholder>
        {urlState?._tag === "Failed" ? urlState.message : "Loading canvas…"}
      </CanvasPlaceholder>
    );
  }
  const target = { threadId, name };
  return (
    <CanvasPanel
      // A page keeps the URL it loaded, so a fresh one only takes effect in a new frame.
      key={url}
      snapshot={snapshot}
      url={url}
      onSetState={(patch) => void setState({ environmentId, input: { ...target, patch } })}
      onEvent={(input) =>
        void sendEvent({ environmentId, input: { ...target, ...input } }).then((result) => {
          if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Canvas action not sent",
              description: canvasCommandFailure(result.cause).message,
            }),
          );
        })
      }
      onCall={(input) =>
        call({ environmentId, input: { ...target, ...input } }).then(canvasCallOutcome)
      }
      onLog={(input) =>
        void log({
          environmentId,
          input: { ...target, pageRevision: snapshot.pageRevision, ...input },
        })
      }
    />
  );
}
