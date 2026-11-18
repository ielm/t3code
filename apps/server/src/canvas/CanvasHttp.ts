import {
  CANVAS_DEFAULT_ENTRY,
  CanvasError,
  CanvasName,
  CanvasRelativePath,
  type CanvasUrlInput,
  type CanvasUrlResult,
  ThreadId,
} from "@t3tools/contracts";
import { injectCanvasBootstrap } from "@t3tools/shared/canvasRuntime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AssetSigner from "../assets/AssetSigner.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import { requestUrl } from "../requestUrl.ts";
import * as CanvasStore from "./CanvasStore.ts";

export const CANVAS_ROUTE_PREFIX = "/api/canvas";
export const CANVAS_WRAPPER_PATH = "__wrap";
export const CANVAS_MAX_FILE_BYTES = 5 * 1024 * 1024;

const TOKEN_BUCKET_MS = 6 * 60 * 60 * 1000;
// A token lives 18 to 24 hours and every mint inside one bucket returns the same URL.
const TOKEN_BUCKETS = 4;

const CanvasClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("canvas"),
  threadId: ThreadId,
  name: CanvasName,
  origin: Schema.String,
  expiresAt: Schema.Number,
});
const CanvasClaimsJson = Schema.fromJsonString(CanvasClaims);
const encodeClaims = Schema.encodeSync(CanvasClaimsJson);
const decodeClaimsJson = Schema.decodeUnknownOption(CanvasClaimsJson);
const decodeClaims = (payload: string) =>
  Result.match(Base64Url.decodeString(payload), {
    onFailure: () => Option.none(),
    onSuccess: decodeClaimsJson,
  });
const decodeRelativePath = Schema.decodeUnknownOption(CanvasRelativePath);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  woff2: "font/woff2",
  wasm: "application/wasm",
};

const BASE_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "private, no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function decodeRequestPath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function extensionOf(relativePath: string): string {
  const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

// The origin lands in a CSP header, so nothing that could end a source or a directive may pass.
function cspOrigin(origin: string): string | null {
  if (!URL.canParse(origin)) return null;
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return /^https?:\/\/[a-z0-9._~[\]:-]+$/.test(parsed.origin) ? parsed.origin : null;
}

// `'self'` is never a source: in a sandboxed document it matches the whole host, not this folder.
function documentCsp(sources: ReadonlyArray<string>): string {
  const allowed = sources.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${allowed}`,
    `style-src 'unsafe-inline' ${allowed}`,
    `img-src data: blob: ${allowed}`,
    `font-src data: ${allowed}`,
    `media-src data: blob: ${allowed}`,
    `connect-src ${allowed}`,
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}

function wrapperCsp(folderSource: string): string {
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${folderSource}; sandbox allow-scripts`;
}

function wrapperDocument(entry: string): string {
  const entryUrl = `./${entry.split("/").map(encodeURIComponent).join("/")}`;
  return [
    '<!doctype html><meta charset="utf-8">',
    "<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>",
    '<iframe id="canvas" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>',
    "<script>(function(){",
    'var frame=document.getElementById("canvas");',
    `frame.src=${JSON.stringify(entryUrl)}+location.search+location.hash;`,
    'addEventListener("message",function(event){',
    "if(parent===window)return;",
    'if(event.source===frame.contentWindow)parent.postMessage(event.data,"*");',
    'else if(event.source===parent)frame.contentWindow.postMessage(event.data,"*");',
    "});",
    "})();</script>",
  ].join("");
}

function matchesEtag(ifNoneMatch: string | undefined, etag: string | undefined): boolean {
  return (
    ifNoneMatch !== undefined &&
    ifNoneMatch.split(",").some((value) => {
      const candidate = value.trim();
      return (
        candidate === "*" ||
        (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2))
      );
    })
  );
}

const notFound = HttpServerResponse.text("Not Found", { status: 404 });

/**
 * Serves canvas folders to the sandboxed panel frame. The signed token in the path is the only
 * credential, and one token covers one folder so a page's relative URLs need no signing.
 */
export class CanvasHttp extends Context.Service<
  CanvasHttp,
  {
    /** The wrapper frame URL for the panel. Fails with `not-found` when the canvas is missing. */
    readonly mintUrl: (input: CanvasUrlInput) => Effect.Effect<CanvasUrlResult, CanvasError>;
    /** Answers a request path under the route prefix. Any rejection is a bare 404. */
    readonly respond: (input: {
      readonly pathname: string;
      readonly ifNoneMatch?: string | undefined;
    }) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3/canvas/CanvasHttp") {}

const make = Effect.gen(function* () {
  const store = yield* CanvasStore.CanvasStore;
  const signer = yield* AssetSigner.AssetSigner;
  const fileSystem = yield* FileSystem.FileSystem;

  const mintUrl = Effect.fn("CanvasHttp.mintUrl")(function* (input: CanvasUrlInput) {
    const origin = cspOrigin(input.origin);
    if (origin === null) {
      return yield* new CanvasError({
        reason: "invalid-origin",
        canvas: input.name,
        detail: "The client origin is not a plain http or https origin.",
      });
    }
    yield* store.get({ threadId: input.threadId, name: input.name });
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = (Math.floor(now / TOKEN_BUCKET_MS) + TOKEN_BUCKETS) * TOKEN_BUCKET_MS;
    const payload = base64UrlEncode(
      encodeClaims({
        version: 1,
        kind: "canvas",
        threadId: input.threadId,
        name: input.name,
        origin,
        expiresAt,
      }),
    );
    const signature = yield* signer
      .sign(payload)
      .pipe(
        Effect.mapError(
          (cause) => new CanvasError({ reason: "storage-failed", canvas: input.name, cause }),
        ),
      );
    return {
      url: `${CANVAS_ROUTE_PREFIX}/${payload}.${signature}/${CANVAS_WRAPPER_PATH}`,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
    };
  });

  const verifyToken = Effect.fn("CanvasHttp.verifyToken")(function* (token: string) {
    const [payload, signature, ...rest] = token.split(".");
    if (!payload || !signature || rest.length > 0) return null;
    const verified = yield* signer.verify(payload, signature).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to load the asset signing key.", { cause }),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (!verified) return null;
    const claims = Option.getOrNull(decodeClaims(payload));
    if (claims === null || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
    return claims;
  });

  const respond: CanvasHttp["Service"]["respond"] = Effect.fn("CanvasHttp.respond")(
    function* (input) {
      const prefix = `${CANVAS_ROUTE_PREFIX}/`;
      if (!input.pathname.startsWith(prefix)) return notFound;
      const suffix = input.pathname.slice(prefix.length);
      const separator = suffix.indexOf("/");
      if (separator <= 0) return notFound;
      const token = suffix.slice(0, separator);
      const claims = yield* verifyToken(token);
      if (claims === null) return notFound;

      const requested = decodeRequestPath(suffix.slice(separator + 1));
      if (requested === null) return notFound;
      const target = { threadId: claims.threadId, name: claims.name };
      const folder = yield* store.get(target);
      const entry = folder.manifest?.entry ?? CANVAS_DEFAULT_ENTRY;
      const folderSource = `${claims.origin}${prefix}${token}/`;

      // A case-insensitive filesystem would otherwise serve a file under the reserved name.
      if (requested.toLowerCase() === CANVAS_WRAPPER_PATH) {
        if (requested !== CANVAS_WRAPPER_PATH) return notFound;
        return HttpServerResponse.text(wrapperDocument(entry), {
          contentType: CONTENT_TYPES.html,
          headers: { ...BASE_HEADERS, "content-security-policy": wrapperCsp(folderSource) },
        });
      }

      const relativePath = Option.getOrNull(
        decodeRelativePath(requested === "" ? entry : requested),
      );
      if (relativePath === null) return notFound;
      const filePath = yield* store.resolveFile({ ...target, path: relativePath });
      const info = yield* fileSystem.stat(filePath);
      if (info.type !== "File") return notFound;
      if (info.size > BigInt(CANVAS_MAX_FILE_BYTES)) {
        return HttpServerResponse.text("Payload Too Large", { status: 413, headers: BASE_HEADERS });
      }
      const raw = yield* fileSystem.readFile(filePath);
      if (raw.byteLength > CANVAS_MAX_FILE_BYTES) {
        return HttpServerResponse.text("Payload Too Large", { status: 413, headers: BASE_HEADERS });
      }

      const extension = extensionOf(relativePath);
      const bytes =
        relativePath === entry && extension === "html"
          ? new TextEncoder().encode(injectCanvasBootstrap(new TextDecoder().decode(raw)))
          : raw;
      const modifiedAt = Option.getOrUndefined(info.mtime);
      const etag =
        modifiedAt === undefined
          ? undefined
          : `W/"${bytes.byteLength.toString(16)}-${modifiedAt.getTime().toString(16)}"`;
      const headers = {
        ...BASE_HEADERS,
        ...(etag === undefined ? {} : { etag }),
        // An SVG opened as a document runs scripts too, so it gets the same policy as a page.
        ...(extension === "html" || extension === "svg"
          ? { "content-security-policy": documentCsp([folderSource]) }
          : {}),
      };
      if (matchesEtag(input.ifNoneMatch, etag)) {
        return HttpServerResponse.empty({ status: 304, headers });
      }
      return HttpServerResponse.uint8Array(bytes, {
        contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        headers,
      });
    },
    Effect.orElseSucceed(() => notFound),
  );

  return CanvasHttp.of({ mintUrl, respond });
});

export const layer = Layer.effect(CanvasHttp, make);

export const layerRoute = HttpRouter.add(
  "GET",
  `${CANVAS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const canvasHttp = yield* CanvasHttp;
    return yield* canvasHttp.respond({
      pathname: url.value.pathname,
      ifNoneMatch: request.headers["if-none-match"],
    });
  }),
);
