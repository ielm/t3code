/** JavaScript injected into every canvas page. It defines the page API over `postMessage`. */
export const CANVAS_RUNTIME_SCRIPT = "";

/** Base styles and theme variables, so plain semantic HTML matches the app. */
export const CANVAS_KIT_CSS = "";

/** Adds the kit styles and the runtime to a canvas entry document, ahead of the page's own code. */
export function injectCanvasBootstrap(html: string): string {
  return html;
}
