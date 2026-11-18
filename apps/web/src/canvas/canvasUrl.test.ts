import { describe, expect, it } from "vite-plus/test";

import {
  CANVAS_URL_MIN_LIFE_MS,
  CANVAS_URL_RENEWAL_CHECK_MS,
  canvasClientOrigin,
  canvasUrlNeedsMint,
  canvasUrlRenewalDelay,
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

  it("is due for renewal exactly when the wait for it ends", () => {
    const url = minted(now + CANVAS_URL_MIN_LIFE_MS + 30_000);
    expect(canvasUrlRenewalDelay(url, now)).toBe(30_000);
    expect(canvasUrlNeedsMint(url, origin, now + 30_000 - 1)).toBe(false);
    expect(canvasUrlNeedsMint(url, origin, now + 30_000)).toBe(true);
  });

  it.each([
    ["a far expiry is looked at again soon, in case the machine slept", 20 * 60 * 60_000],
    ["a renewal already due is retried", CANVAS_URL_MIN_LIFE_MS - 1],
    ["an expired URL is retried", -1],
  ])("%s", (_name, life) => {
    expect(canvasUrlRenewalDelay(minted(now + life), now)).toBe(CANVAS_URL_RENEWAL_CHECK_MS);
  });

  it("schedules nothing for an expiry that did not parse", () => {
    expect(canvasUrlRenewalDelay(minted(Number.NaN), now)).toBeNull();
  });
});
