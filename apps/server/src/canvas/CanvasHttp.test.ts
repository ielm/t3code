import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CanvasError, type CanvasManifest, ThreadId } from "@t3tools/contracts";
import { injectCanvasBootstrap } from "@t3tools/shared/canvasRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerResponse } from "effect/http";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as PayloadSigner from "../auth/PayloadSigner.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as CanvasHttp from "./CanvasHttp.ts";
import * as CanvasStore from "./CanvasStore.ts";

const threadId = ThreadId.make("thread:canvas-http");
const name = "board";
const origin = "https://app.example.test:8443";
const unused = () => Effect.die("unused by CanvasHttp");

const PAGE = "<!doctype html><html><head><title>Board</title></head><body>hi</body></html>";

const harness = Effect.fn("harness")(function* (manifest?: CanvasManifest) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  const canvasDir = path.join(root, name);
  yield* fileSystem.makeDirectory(path.join(canvasDir, "parts"), { recursive: true });
  yield* fileSystem.writeFileString(path.join(canvasDir, "index.html"), PAGE);
  yield* fileSystem.writeFileString(path.join(canvasDir, "parts", "app.js"), "export const a = 1;");
  yield* fileSystem.writeFileString(path.join(root, "secret.txt"), "outside");

  const missing = (canvas: string) => new CanvasError({ reason: "not-found", canvas });
  const signer = yield* PayloadSigner.fromSecret(new Uint8Array(32).fill(7));
  const dependencies = Layer.mergeAll(
    Layer.succeed(AssetSigner.AssetSigner, signer),
    Layer.succeed(
      CanvasStore.CanvasStore,
      CanvasStore.CanvasStore.of({
        ensure: unused,
        get: (target) =>
          target.name === name
            ? Effect.succeed({
                ...target,
                path: canvasDir,
                manifest: manifest ?? null,
                manifestIssue: manifest === undefined ? "canvas.json is missing." : null,
              })
            : Effect.fail(missing(target.name)),
        list: unused,
        changes: () => Stream.die("unused by CanvasHttp"),
        resolveFile: (input) => {
          const resolved = path.resolve(canvasDir, input.path);
          return resolved.startsWith(`${canvasDir}${path.sep}`)
            ? Effect.succeed(resolved)
            : Effect.fail(new CanvasError({ reason: "invalid-path", canvas: input.name }));
        },
        readState: unused,
        writeState: unused,
        remove: unused,
        removeThread: unused,
      }),
    ),
  );
  const canvasHttp = yield* Effect.service(CanvasHttp.CanvasHttp).pipe(
    Effect.provide(CanvasHttp.layer.pipe(Layer.provide(dependencies))),
  );
  const minted = yield* canvasHttp.mintUrl({ threadId, name, origin });
  const base = minted.url.slice(0, -CanvasHttp.CANVAS_WRAPPER_PATH.length);
  const token = base.slice(`${CanvasHttp.CANVAS_ROUTE_PREFIX}/`.length, -1);

  const get = Effect.fn("get")(function* (pathname: string, ifNoneMatch?: string) {
    const response = HttpServerResponse.toWeb(yield* canvasHttp.respond({ pathname, ifNoneMatch }));
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: yield* Effect.promise(() => response.text()),
    };
  });
  const forge = Effect.fn("forge")(function* (claims: Record<string, unknown>) {
    const payload = base64UrlEncode(JSON.stringify(claims));
    return `${CanvasHttp.CANVAS_ROUTE_PREFIX}/${payload}.${yield* signer.sign(payload)}/`;
  });

  return { canvasHttp, canvasDir, minted, base, token, get, forge, fileSystem, path, signer };
});

const folderSource = (token: string) => `${origin}${CanvasHttp.CANVAS_ROUTE_PREFIX}/${token}/`;

const documentCsp = (token: string) => {
  const C = folderSource(token);
  return `default-src 'none'; script-src 'unsafe-inline' ${C}; style-src 'unsafe-inline' ${C}; img-src data: blob: ${C}; font-src data: ${C}; media-src data: blob: ${C}; connect-src ${C}; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
};

describe("CanvasHttp", () => {
  it.effect("mints a stable wrapper URL per bucket and serves the folder until it expires", () =>
    Effect.gen(function* () {
      const { canvasHttp, minted, base, get } = yield* harness();
      expect(minted.url.endsWith("/__wrap")).toBe(true);
      expect(minted.expiresAt).toBe("1970-01-02T00:00:00.000Z");

      yield* TestClock.adjust("5 hours");
      expect(yield* canvasHttp.mintUrl({ threadId, name, origin })).toEqual(minted);
      yield* TestClock.adjust("2 hours");
      expect((yield* canvasHttp.mintUrl({ threadId, name, origin })).url).not.toBe(minted.url);

      expect((yield* get(`${base}parts/app.js`)).status).toBe(200);
      yield* TestClock.adjust("17 hours");
      expect(yield* get(`${base}parts/app.js`)).toMatchObject({ status: 404, body: "Not Found" });
      expect((yield* get(minted.url)).status).toBe(404);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails to mint for a missing canvas or an origin that could alter the CSP", () =>
    Effect.gen(function* () {
      const { canvasHttp } = yield* harness();
      const reason = (input: { readonly name: string; readonly origin: string }) =>
        canvasHttp.mintUrl({ threadId, ...input }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      expect(yield* reason({ name: "absent", origin })).toBe("not-found");
      expect(yield* reason({ name, origin: "https://a.test;script-src*" })).toBe("invalid-path");
      expect(yield* reason({ name, origin: "https://a.test,default-src*" })).toBe("invalid-path");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects tampered, foreign-kind and malformed tokens with a bare 404", () =>
    Effect.gen(function* () {
      const { token, get, forge, signer } = yield* harness();
      const [payload = "", signature = ""] = token.split(".");
      const claims = {
        version: 1,
        kind: "canvas",
        threadId,
        name,
        origin,
        expiresAt: 86_400_000,
      };
      const prefix = CanvasHttp.CANVAS_ROUTE_PREFIX;
      const otherPayload = base64UrlEncode(JSON.stringify({ ...claims, origin: "https://evil" }));
      const rejected = [
        `${prefix}/${otherPayload}.${signature}/`,
        `${prefix}/${payload}.${signature.slice(0, -2)}AA/`,
        `${prefix}/${payload}/`,
        `${prefix}/${payload}.${yield* signer.sign(`${payload}x`)}/`,
        yield* forge({ ...claims, kind: "workspace-file" }),
        yield* forge({ ...claims, version: 2 }),
        yield* forge({ ...claims, name: "../board" }),
        `${prefix}/`,
        `${prefix}/${token}`,
        "/api/assets/x/y",
      ];
      for (const pathname of rejected) {
        expect(yield* get(pathname), pathname).toMatchObject({ status: 404, body: "Not Found" });
        expect(yield* get(`${pathname}__wrap`), pathname).toMatchObject({ status: 404 });
      }
      expect((yield* get(yield* forge(claims))).status).toBe(200);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never serves outside the folder or a file under the reserved wrapper name", () =>
    Effect.gen(function* () {
      const { base, canvasDir, get, fileSystem, path } = yield* harness();
      yield* fileSystem.writeFileString(path.join(canvasDir, "__wrap"), "file named wrap");
      for (const escape of [
        "..%2Fsecret.txt",
        "parts%2F..%2F..%2Fsecret.txt",
        "%2Fetc%2Fhosts",
        "parts//app.js",
        "%E0%A4%A",
        "parts",
        "absent.js",
        "__WRAP",
        "__Wrap",
      ]) {
        expect(yield* get(`${base}${escape}`), escape).toMatchObject({
          status: 404,
          body: "Not Found",
        });
      }
      for (const wrapper of ["__wrap", "%5F%5Fwrap"]) {
        const response = yield* get(`${base}${wrapper}`);
        expect(response.status).toBe(200);
        expect(response.body).not.toContain("file named wrap");
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves a script with exactly the canvas headers and revalidates by ETag", () =>
    Effect.gen(function* () {
      const { base, canvasDir, get, fileSystem, path } = yield* harness();
      const first = yield* get(`${base}parts/app.js`);
      expect(first.status).toBe(200);
      expect(first.body).toBe("export const a = 1;");
      const etag = first.headers.etag ?? "";
      expect(etag).toMatch(/^W\/"13-[0-9a-f]+"$/);
      expect(first.headers).toEqual({
        "access-control-allow-origin": "*",
        "cache-control": "private, no-cache",
        "content-length": "19",
        "content-type": "text/javascript; charset=utf-8",
        etag,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });

      for (const ifNoneMatch of [etag, `"other", ${etag.slice(2)}`, "*"]) {
        const cached = yield* get(`${base}parts/app.js`, ifNoneMatch);
        expect(cached).toMatchObject({ status: 304, body: "" });
        expect(cached.headers).toMatchObject({
          "access-control-allow-origin": "*",
          "cache-control": "private, no-cache",
          etag,
        });
      }
      expect((yield* get(`${base}parts/app.js`, 'W/"0-0"')).status).toBe(200);

      yield* fileSystem.writeFileString(path.join(canvasDir, "parts", "app.js"), "export {};");
      expect(yield* get(`${base}parts/app.js`, etag)).toMatchObject({
        status: 200,
        body: "export {};",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("sets a content type nosniff accepts for each kind of canvas file", () =>
    Effect.gen(function* () {
      const { base, canvasDir, get, fileSystem, path } = yield* harness();
      const expected = {
        "a.mjs": "text/javascript; charset=utf-8",
        "a.css": "text/css; charset=utf-8",
        "a.json": "application/json",
        "a.js.map": "application/json",
        "a.txt": "text/plain; charset=utf-8",
        "a.SVG": "image/svg+xml",
        "a.png": "image/png",
        "a.jpg": "image/jpeg",
        "a.gif": "image/gif",
        "a.webp": "image/webp",
        "a.woff2": "font/woff2",
        "a.wasm": "application/wasm",
        "a.bin": "application/octet-stream",
        Makefile: "application/octet-stream",
      };
      for (const [file, contentType] of Object.entries(expected)) {
        yield* fileSystem.writeFileString(path.join(canvasDir, file), "x");
        expect((yield* get(`${base}${file}`)).headers["content-type"], file).toBe(contentType);
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves the entry document with the bootstrap and a CSP from the signed origin", () =>
    Effect.gen(function* () {
      const { base, token, canvasDir, get, fileSystem, path } = yield* harness();
      const expectedBody = injectCanvasBootstrap(PAGE);
      const entry = yield* get(`${base}index.html`);
      expect(entry.status).toBe(200);
      expect(entry.body).toBe(expectedBody);
      const etag = entry.headers.etag ?? "";
      expect(entry.headers).toEqual({
        "access-control-allow-origin": "*",
        "cache-control": "private, no-cache",
        "content-length": String(new TextEncoder().encode(expectedBody).byteLength),
        "content-security-policy": documentCsp(token),
        "content-type": "text/html; charset=utf-8",
        etag,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      expect(entry.headers["content-security-policy"]).not.toContain("'self'");
      expect(entry.headers.location).toBeUndefined();

      const bare = yield* get(base);
      expect(bare).toMatchObject({ status: 200, body: expectedBody });
      expect(bare.headers["content-security-policy"]).toBe(documentCsp(token));

      yield* fileSystem.writeFileString(path.join(canvasDir, "parts", "other.html"), PAGE);
      const other = yield* get(`${base}parts/other.html`);
      expect(other.body).toBe(PAGE);
      expect(other.headers["content-security-policy"]).toBe(documentCsp(token));

      yield* fileSystem.writeFileString(path.join(canvasDir, "logo.svg"), "<svg/>");
      const svg = yield* get(`${base}logo.svg`);
      expect(svg.headers["content-security-policy"]).toBe(documentCsp(token));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves the wrapper frame around the manifest's entry document", () =>
    Effect.gen(function* () {
      const { base, token, canvasDir, minted, get, fileSystem, path } = yield* harness({
        title: "Board",
        entry: "pages/main view.html",
      });
      yield* fileSystem.makeDirectory(path.join(canvasDir, "pages"));
      yield* fileSystem.writeFileString(path.join(canvasDir, "pages", "main view.html"), PAGE);

      const wrapper = yield* get(minted.url);
      expect(wrapper.status).toBe(200);
      expect(wrapper.headers).toMatchObject({
        "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${folderSource(token)}; sandbox allow-scripts`,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-cache",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      expect(wrapper.headers.etag).toBeUndefined();
      expect(wrapper.body).toContain(
        '<iframe id="canvas" sandbox="allow-scripts" referrerpolicy="no-referrer">',
      );
      expect(wrapper.body).toContain(
        'frame.src="./pages/main%20view.html"+location.search+location.hash;',
      );

      const expectedBody = injectCanvasBootstrap(PAGE);
      expect((yield* get(`${base}pages/main%20view.html`)).body).toBe(expectedBody);
      expect((yield* get(base)).body).toBe(expectedBody);
      expect((yield* get(`${base}index.html`)).body).toBe(PAGE);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses a file over the size cap", () =>
    Effect.gen(function* () {
      const { base, canvasDir, get, fileSystem, path } = yield* harness();
      const atCap = new Uint8Array(CanvasHttp.CANVAS_MAX_FILE_BYTES);
      yield* fileSystem.writeFile(path.join(canvasDir, "ok.bin"), atCap);
      yield* fileSystem.writeFile(
        path.join(canvasDir, "big.bin"),
        new Uint8Array(CanvasHttp.CANVAS_MAX_FILE_BYTES + 1),
      );
      const ok = yield* get(`${base}ok.bin`);
      expect(ok.status).toBe(200);
      expect(ok.headers["content-length"]).toBe(String(CanvasHttp.CANVAS_MAX_FILE_BYTES));
      expect(yield* get(`${base}big.bin`)).toMatchObject({
        status: 413,
        body: "Payload Too Large",
      });
    }).pipe(Effect.provide(layerTest)),
  );
});

const layerTest = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
