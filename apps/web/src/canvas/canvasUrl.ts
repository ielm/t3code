/** A fresh URL is minted for a new page revision when the current one has less than this left. */
export const CANVAS_URL_MIN_LIFE_MS = 60 * 60_000;

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

/** A mounted page keeps its URL, so this is asked once per page revision, not on a timer. */
export function canvasUrlNeedsMint(
  minted: MintedCanvasUrl | null,
  origin: string,
  now: number,
): boolean {
  if (minted === null || minted.origin !== origin) return true;
  return !(minted.expiresAt - now > CANVAS_URL_MIN_LIFE_MS);
}
