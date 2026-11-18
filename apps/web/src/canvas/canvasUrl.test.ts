import { describe, expect, it } from "vite-plus/test";

import {
  CANVAS_URL_MIN_LIFE_MS,
  canvasClientOrigin,
  canvasUrlNeedsMint,
  resolveCanvasUrl,
} from "./canvasUrl";

describe("canvasClientOrigin", () => {
  it.each([
    ["http://localhost:3773", "http://localhost:3773"],
    ["https://box.tail1234.ts.net/", "https://box.tail1234.ts.net"],
    ["https://relay.example:8443/some/path?x=1", "https://relay.example:8443"],
    ["t3code://app", null],
    ["not a url", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("reads %j as %j", (httpBaseUrl, expected) => {
    expect(canvasClientOrigin(httpBaseUrl)).toBe(expected);
  });
});

describe("resolveCanvasUrl", () => {
  it("resolves the minted path against the environment's origin", () => {
    expect(resolveCanvasUrl("https://box.example:8443", "/api/canvas/abc.def/__wrap")).toBe(
      "https://box.example:8443/api/canvas/abc.def/__wrap",
    );
  });

  it("refuses an address on another origin", () => {
    expect(resolveCanvasUrl("https://box.example", "https://evil.example/api/canvas/x")).toBeNull();
    expect(resolveCanvasUrl("https://box.example", "//evil.example/api/canvas/x")).toBeNull();
  });
});

describe("canvasUrlNeedsMint", () => {
  const origin = "https://box.example";
  const now = 1_000_000_000;
  const minted = (expiresAt: number) => ({
    origin,
    url: `${origin}/api/canvas/t/__wrap`,
    expiresAt,
  });

  it("mints when there is no URL, or it was signed for another origin", () => {
    expect(canvasUrlNeedsMint(null, origin, now)).toBe(true);
    expect(canvasUrlNeedsMint(minted(now + 10 * CANVAS_URL_MIN_LIFE_MS), "http://other", now)).toBe(
      true,
    );
  });

  it("keeps a URL with life left and renews one near, past or without an expiry", () => {
    expect(canvasUrlNeedsMint(minted(now + CANVAS_URL_MIN_LIFE_MS + 1), origin, now)).toBe(false);
    expect(canvasUrlNeedsMint(minted(now + CANVAS_URL_MIN_LIFE_MS), origin, now)).toBe(true);
    expect(canvasUrlNeedsMint(minted(now - 1), origin, now)).toBe(true);
    expect(canvasUrlNeedsMint(minted(Number.NaN), origin, now)).toBe(true);
  });
});
