import {
  CANVAS_BRIDGE_VERSION,
  CANVAS_LOG_ENTRY_MAX_LENGTH,
  CANVAS_PAGE_GLOBAL,
} from "./canvas.ts";
import {
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  type HtmlRenderTheme,
} from "./htmlRender.ts";
import { T3_CODE_DARK_THEME_COLORS, T3_CODE_LIGHT_THEME_COLORS } from "./themePalettes.ts";

const DARK_THEME = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark");
const LIGHT_THEME = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");

// Read off the html_render helpers so the panel's existing theme code drives a canvas unchanged.
const THEME_METHOD = htmlRenderThemeMessage(DARK_THEME).method;
const THEME_FRAGMENT_KEY = htmlRenderThemeFragment(DARK_THEME).slice(1).split("=", 1)[0]!;
const THEME_STYLE_ID = "t3-theme";

const CANVAS_LOG_WINDOW_MS = 10_000;
const CANVAS_LOGS_PER_WINDOW = 20;

/** JavaScript injected into every canvas page. It defines the page API over `postMessage`. */
export const CANVAS_RUNTIME_SCRIPT = `(function () {
  "use strict";
  var host = window.parent;
  var VERSION = ${CANVAS_BRIDGE_VERSION};
  var LOG_MAX = ${CANVAS_LOG_ENTRY_MAX_LENGTH};
  var LOG_WINDOW = ${CANVAS_LOG_WINDOW_MS};
  var LOG_LIMIT = ${CANVAS_LOGS_PER_WINDOW};
  var own = Object.prototype.hasOwnProperty;

  var themeStyle = document.getElementById(${JSON.stringify(THEME_STYLE_ID)});
  function applyTheme(theme) {
    if (!themeStyle || !theme || typeof theme !== "object") return;
    var variables = theme.variables;
    if (!variables || typeof variables !== "object") return;
    var css = ":root{color-scheme:" + (theme.appearance === "light" ? "light" : "dark") + ";";
    for (var key in variables) {
      if (/^--[a-z0-9-]+$/.test(key)) {
        css += key + ":" + String(variables[key]).replace(/[;{}<>]/g, "") + ";";
      }
    }
    themeStyle.textContent = css + "}";
  }
  try {
    var fragment = /[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);
    if (fragment) {
      applyTheme(JSON.parse(decodeURIComponent(fragment[1])));
      history.replaceState(history.state, "", location.pathname + location.search);
    }
  } catch (error) {}

  function post(message) {
    message.t3canvas = VERSION;
    host.postMessage(message, "*");
  }
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function toJson(value) {
    var text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  }
  function merge(target, patch) {
    var next = {};
    var key;
    for (key in target) if (own.call(target, key)) next[key] = target[key];
    for (key in patch) {
      if (!own.call(patch, key) || key === "__proto__") continue;
      var value = patch[key];
      if (value === null) delete next[key];
      else if (isObject(value)) next[key] = merge(isObject(next[key]) ? next[key] : {}, value);
      else next[key] = value;
    }
    return next;
  }

  var state = {};
  var hasState = false;
  var listeners = [];
  var pending = {};
  var calls = 0;
  var resolveReady;
  var ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  function setLocalState(next) {
    state = next;
    hasState = true;
    listeners.slice().forEach(function (listener) {
      try {
        listener(state);
      } catch (error) {
        console.error(error);
      }
    });
  }

  var canvas = {
    name: "",
    title: "",
    functions: [],
    ready: ready,
    onState: function (listener) {
      if (typeof listener !== "function") throw new TypeError("canvas.onState needs a function");
      listeners.push(listener);
      if (hasState) listener(state);
      return function () {
        var index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    setState: function (patch) {
      var clean = toJson(patch);
      if (!isObject(clean)) throw new TypeError("canvas.setState needs an object patch");
      setLocalState(merge(state, clean));
      post({ type: "setState", patch: clean });
    },
    send: function (event, payload) {
      var message = { type: "event", event: String(event) };
      var clean = toJson(payload);
      if (clean !== undefined) message.payload = clean;
      post(message);
    },
    call: function (name, args) {
      return new Promise(function (resolve, reject) {
        var id = "c" + ++calls;
        var message = { type: "call", id: id, function: String(name) };
        var clean = toJson(args);
        if (clean !== undefined) message.args = clean;
        pending[id] = { resolve: resolve, reject: reject };
        try {
          post(message);
        } catch (error) {
          delete pending[id];
          throw error;
        }
      });
    }
  };
  Object.defineProperty(canvas, "state", {
    enumerable: true,
    get: function () {
      return state;
    }
  });
  Object.defineProperty(window, ${JSON.stringify(CANVAS_PAGE_GLOBAL)}, { value: canvas });

  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.jsonrpc === "2.0" && data.method === ${JSON.stringify(THEME_METHOD)}) {
      var params = data.params;
      if (params && params.styles) {
        applyTheme({ appearance: params.theme, variables: params.styles.variables });
      }
      return;
    }
    if (data.t3canvas !== VERSION) return;
    if (data.type === "init") {
      canvas.name = String(data.name);
      canvas.title = String(data.title);
      canvas.functions = Array.isArray(data.functions) ? data.functions : [];
      setLocalState(isObject(data.state) ? data.state : {});
      resolveReady();
    } else if (data.type === "state") {
      setLocalState(isObject(data.state) ? data.state : {});
    } else if (data.type === "callResult") {
      var call = own.call(pending, data.id) ? pending[data.id] : undefined;
      if (!call) return;
      delete pending[data.id];
      if (data.ok === true) {
        call.resolve(data.value);
      } else {
        var failure = new Error(String(data.message));
        failure.reason = String(data.reason);
        call.reject(failure);
      }
    }
  });

  var logWindowStart = 0;
  var logCount = 0;
  function describe(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.name + ": " + value.message;
    try {
      var text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (error) {
      return String(value);
    }
  }
  function log(text) {
    var now = Date.now();
    if (now - logWindowStart >= LOG_WINDOW) {
      logWindowStart = now;
      logCount = 0;
    }
    logCount += 1;
    if (logCount > LOG_LIMIT + 1) return;
    try {
      if (logCount > LOG_LIMIT) {
        post({ type: "log", level: "warning", text: "Too many errors; dropping the rest for now." });
      } else {
        post({ type: "log", level: "error", text: text.slice(0, LOG_MAX) });
      }
    } catch (error) {}
  }
  var consoleError = console.error;
  console.error = function () {
    consoleError.apply(console, arguments);
    log(Array.prototype.map.call(arguments, describe).join(" "));
  };
  window.addEventListener("error", function (event) {
    var where = event.filename ? " (" + event.filename + ":" + event.lineno + ")" : "";
    log((event.error ? describe(event.error) : String(event.message)) + where);
  });
  window.addEventListener("unhandledrejection", function (event) {
    log("Unhandled rejection: " + describe(event.reason));
  });

  post({ type: "ready" });
})();`;

const KIT_STYLE_ID = "t3-canvas-kit";

// Every element rule sits in :where() so one page selector of any weight overrides it.
/** Base styles and theme variables, so plain semantic HTML matches the app. */
export const CANVAS_KIT_CSS = [
  "*,*::before,*::after{box-sizing:border-box}",
  "html{height:100%;background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:thin;scrollbar-color:var(--border) transparent}",
  "body{min-height:100%;margin:0;padding:16px}",
  ":where(h1,h2,h3,h4,h5,h6){margin:1.25em 0 .5em;font-weight:600;line-height:1.25}",
  ":where(h1){font-size:1.5rem}:where(h2){font-size:1.25rem}:where(h3){font-size:1.1rem}:where(h4,h5,h6){font-size:1rem}",
  ":where(p,ul,ol,dl,pre,table,blockquote,figure,fieldset,details){margin:0 0 1em}",
  ":where(body>:first-child){margin-top:0}:where(body>:last-child){margin-bottom:0}",
  ":where(ul,ol){padding-left:1.5em}",
  ":where(a){color:var(--accent);text-underline-offset:2px}",
  ":where(small,figcaption,caption){color:var(--muted-foreground);font-size:.85em}",
  ":where(hr){height:1px;margin:1.25em 0;border:0;background:var(--border)}",
  ":where(img,svg,video,canvas){max-width:100%}",
  ":where(blockquote){padding-left:1em;border-left:2px solid var(--border);color:var(--muted-foreground)}",
  ":where(code,kbd,pre,samp){font-family:var(--font-mono);font-size:.9em}",
  ":where(code,kbd){padding:.1em .35em;border-radius:calc(var(--radius) - 4px);background:var(--code-background);color:var(--code-foreground)}",
  ":where(kbd){border:1px solid var(--border)}",
  ":where(pre){overflow:auto;padding:12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--code-background);color:var(--code-foreground)}",
  ":where(pre code){padding:0;background:none;font-size:1em}",
  ":where(table){width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}",
  ":where(th,td){padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}",
  ":where(th){color:var(--muted-foreground);font-size:.85em;font-weight:500}",
  ":where(tbody tr:last-child>*){border-bottom:0}",
  ":where(button,input,select,textarea){font:inherit;color:inherit}",
  ":where(button,input[type=button],input[type=submit],input[type=reset]){display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 12px;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--secondary);color:var(--secondary-foreground);font-weight:500;cursor:pointer}",
  ":where(button[type=submit],input[type=submit]){border-color:transparent;background:var(--primary);color:var(--primary-foreground)}",
  ":where(button,input[type=button],input[type=submit],input[type=reset]):where(:hover:not(:disabled)){filter:brightness(1.08)}",
  ":where(button,input,select,textarea):where(:disabled){opacity:.5;cursor:not-allowed}",
  ":where(input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=button],[type=submit],[type=reset]),select,textarea){min-height:32px;max-width:100%;padding:4px 10px;border:1px solid var(--input);border-radius:calc(var(--radius) - 2px);background:var(--background);color:var(--foreground)}",
  ":where(textarea){min-height:64px;resize:vertical}",
  ":where(input[type=checkbox],input[type=radio],input[type=range],progress,meter){accent-color:var(--accent)}",
  ":where(::placeholder){color:var(--muted-foreground);opacity:1}",
  ":where(label){font-weight:500}",
  ":where(fieldset){padding:12px;border:1px solid var(--border);border-radius:var(--radius)}",
  ":where(legend){padding:0 6px;color:var(--muted-foreground);font-size:.85em}",
  ":where(details){padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);color:var(--card-foreground)}",
  ":where(summary){font-weight:500;cursor:pointer}",
  ":where(details[open]>summary){margin-bottom:8px}",
  ":where(:focus-visible){outline:2px solid var(--ring);outline-offset:1px}",
  ":where(::selection){background:var(--accent-surface);color:var(--accent-surface-foreground)}",
].join("");

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

function bootstrapMarkup(html: string): string {
  return [
    /<meta\s[^>]*charset/i.test(html.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(html)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="${THEME_STYLE_ID}">${rootRule(DARK_THEME)}@media (prefers-color-scheme: light){${rootRule(LIGHT_THEME)}}</style>`,
    `<style id="${KIT_STYLE_ID}">${CANVAS_KIT_CSS}</style>`,
    `<script>${CANVAS_RUNTIME_SCRIPT}</script>`,
  ].join("");
}

// Only whitespace, comments, a doctype and `<html>` may precede `<head>`; a later one is not a head.
const DOCUMENT_PREAMBLE =
  /^((?:\s|<!--[\s\S]*?-->|<!doctype[^>]*>)*(?:<html(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>(?:\s|<!--[\s\S]*?-->)*)?)(<head(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>)?/i;

/** Adds the kit styles and the runtime to a canvas entry document, ahead of the page's own code. */
export function injectCanvasBootstrap(html: string): string {
  const match = DOCUMENT_PREAMBLE.exec(html);
  const preamble = match?.[1] ?? "";
  const headOpen = match?.[2];
  const doctype = /<!doctype/i.test(preamble) ? "" : "<!doctype html>";
  const markup = bootstrapMarkup(html);
  const at = preamble.length + (headOpen?.length ?? 0);
  const inserted = headOpen === undefined ? `<head>${markup}</head>` : markup;
  return `${doctype}${html.slice(0, at)}${inserted}${html.slice(at)}`;
}
