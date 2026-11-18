/** A URL with less than this left is replaced by a fresh one. */
export const CANVAS_URL_MIN_LIFE_MS = 60 * 60_000;
/** How long a pending renewal waits between looks at the clock, and a failed one before retrying. */
export const CANVAS_URL_RENEWAL_CHECK_MS = 60_000;

/**
 * The scheme, host and port the client reaches an environment on. The server signs it into the
 * page's content security policy, so it must be the origin the frame really loads from.
 */
export function canvasClientOrigin(httpBaseUrl: string | null | undefined): string | null {
  if (!httpBaseUrl || !URL.canParse(httpBaseUrl)) return null;
  const { protocol, origin } = new URL(httpBaseUrl);
  return protocol === "http:" || protocol === "https:" ? origin : null;
}

/** The absolute frame URL for a path the server minted, or `null` when it leaves `origin`. */
export function resolveCanvasUrl(origin: string, path: string): string | null {
  if (!URL.canParse(path, origin)) return null;
  const url = new URL(path, origin);
  return url.origin === origin ? url.href : null;
}

export interface MintedCanvasUrl {
  readonly origin: string;
  readonly url: string;
  /** Epoch milliseconds, or `NaN` when the server's timestamp did not parse. */
  readonly expiresAt: number;
}

export function canvasUrlNeedsMint(
  minted: MintedCanvasUrl | null,
  origin: string,
  now: number,
): boolean {
  if (minted === null || minted.origin !== origin) return true;
  return !(minted.expiresAt - now > CANVAS_URL_MIN_LIFE_MS);
}

/**
 * Milliseconds until `canvasUrlNeedsMint` is worth asking again for a mounted page, or `null` when
 * the expiry is unknown. Capped because a timer stands still while the machine sleeps and the
 * expiry does not.
 */
export function canvasUrlRenewalDelay(minted: MintedCanvasUrl, now: number): number | null {
  if (Number.isNaN(minted.expiresAt)) return null;
  const untilDue = minted.expiresAt - CANVAS_URL_MIN_LIFE_MS - now;
  return untilDue > 0
    ? Math.min(untilDue, CANVAS_URL_RENEWAL_CHECK_MS)
    : CANVAS_URL_RENEWAL_CHECK_MS;
}
