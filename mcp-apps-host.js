/**
 * mcp-apps-lite-host: render MCP Apps views (ext-apps spec 2026-01-26) in any web page.
 *
 * A tool that declares `_meta.ui.resourceUri` points at a `ui://` HTML resource
 * (`text/html;profile=mcp-app`). This host loads that HTML in a sandboxed iframe and
 * speaks the View <-> Host JSON-RPC protocol over postMessage:
 *
 *   view -> ui/initialize                   host replies with capabilities + hostContext
 *   view -> ui/notifications/initialized    host sends tool-input(-partial), tool-result or tool-cancelled
 *   view -> tools/call, resources/read      host proxies to your MCP client
 *   view -> ui/message, ui/open-link        host hands them to your app
 *   view -> ui/request-display-mode         host answers with the resulting mode
 *   view -> ui/update-model-context         host stores it for the next model turn
 *   view -> ui/notifications/size-changed   host resizes the iframe
 *   host -> ui/notifications/host-context-changed, ui/resource-teardown
 *
 * Two ways to isolate the view:
 *   - inline (default): a srcdoc iframe with `sandbox="allow-scripts"` (an opaque origin).
 *   - sandboxProxy: the spec's double-iframe setup for web hosts. Serve sandbox-proxy.html
 *     and this file from a second origin and pass its URL.
 * Either way the view's `_meta.ui.csp` becomes a Content-Security-Policy and
 * `_meta.ui.permissions` becomes the iframe `allow` attribute.
 *
 * No dependencies. MIT licensed.
 */

export const PROTOCOL_VERSION = "2026-01-26";
export const VERSION = "0.2.0";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const DISPLAY_MODES = ["inline", "fullscreen", "pip"];
const LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

// -- Security helpers --------------------------------------------------------

/**
 * Keep only CSP source entries that can't break out of their directive.
 * Rejects `;` and `,` (new directive or policy), quotes (keywords like 'unsafe-eval'),
 * whitespace (several sources in one entry), angle brackets and anything non-string.
 */
export function sanitizeDomains(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((d) => typeof d === "string" && d.length > 0 && d.length < 2048 && !/[;,'"\s<>]/.test(d));
}

/**
 * Build the Content-Security-Policy for a view from its `_meta.ui.csp`.
 * Follows the spec: a restrictive default when `csp` is omitted, and only declared
 * origins otherwise ("Host MUST NOT allow undeclared domains").
 *
 * `inline: true` drops 'self'. In a srcdoc iframe 'self' means the host page's origin,
 * not the view's, so keeping it would let a view call the host's own server.
 * @param {{connectDomains?: string[], resourceDomains?: string[], frameDomains?: string[], baseUriDomains?: string[]}} [csp]
 * @param {{inline?: boolean}} [options]
 * @returns {string}
 */
export function buildCsp(csp, options = {}) {
  const policy = buildPolicy(csp);
  if (!options.inline) return policy;
  return policy
    .split("; ")
    .map((d) => {
      const parts = d.split(" ").filter((p) => p !== "'self'");
      return parts.length > 1 ? parts.join(" ") : `${parts[0]} 'none'`;
    })
    .join("; ");
}

function buildPolicy(csp) {
  if (!isObj(csp)) {
    return [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self' data:",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; ");
  }
  const res = sanitizeDomains(csp.resourceDomains).join(" ");
  const conn = sanitizeDomains(csp.connectDomains).join(" ");
  const frames = sanitizeDomains(csp.frameDomains).join(" ");
  const base = sanitizeDomains(csp.baseUriDomains).join(" ");
  const d = (head, extra) => (extra ? `${head} ${extra}` : head);
  return [
    "default-src 'none'",
    d("script-src 'self' 'unsafe-inline'", res),
    d("style-src 'self' 'unsafe-inline'", res),
    d("connect-src 'self'", conn),
    d("img-src 'self' data:", res),
    d("font-src 'self'", res),
    d("media-src 'self' data:", res),
    frames ? `frame-src ${frames}` : "frame-src 'none'",
    "object-src 'none'",
    base ? `base-uri ${base}` : "base-uri 'self'",
  ].join("; ");
}

/**
 * Build the iframe `allow` attribute (Permissions Policy) from `_meta.ui.permissions`.
 * Features are separated by `;`. A space-separated list ("camera microphone") is read
 * as one feature with an invalid allowlist and grants nothing.
 */
export function buildAllow(permissions) {
  if (!isObj(permissions)) return "";
  const out = [];
  if (permissions.camera) out.push("camera");
  if (permissions.microphone) out.push("microphone");
  if (permissions.geolocation) out.push("geolocation");
  if (permissions.clipboardWrite) out.push("clipboard-write");
  return out.join("; ");
}

const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Put a CSP <meta> in front of everything in the view's HTML.
 * It goes right after a leading doctype, or first otherwise, so no comment, script or
 * fake <head> in the view can come before it. CSP metas the view adds can only tighten it.
 */
export function injectCsp(html, policy) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(policy)}">`;
  const s = String(html ?? "");
  const doctype = s.match(/^﻿?\s*<!doctype[^>]*>/i);
  if (doctype) return s.slice(0, doctype[0].length) + meta + s.slice(doctype[0].length);
  return meta + s;
}

/** The HTML of a `resources/read` content item (`text`, or base64 `blob`). */
export function resourceHtml(resource) {
  if (!isObj(resource)) return undefined;
  if (typeof resource.text === "string") return resource.text;
  if (typeof resource.blob === "string") {
    const bin = atob(resource.blob);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return undefined;
}

/** Text of a ui/message `content`: a block, an array of blocks, or a string. */
function messageText(content) {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => (typeof b === "string" ? b : b?.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

// -- Message routing ---------------------------------------------------------

const hosts = new Set();
let listening = false;

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (ev) => {
    for (const host of hosts) {
      if (host._accepts(ev)) {
        host._receive(ev.data);
        return;
      }
    }
  });
}

// -- Host --------------------------------------------------------------------

export class McpAppHost {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container      Where to mount the iframe.
   * @param {string} [opts.html]              The ui:// resource HTML. Or pass `resource`.
   * @param {object} [opts.resource]          A `resources/read` content item: {text|blob, _meta: {ui: {csp, permissions}}}.
   * @param {object} [opts.csp]               Overrides `resource._meta.ui.csp`.
   * @param {object} [opts.permissions]       Overrides `resource._meta.ui.permissions`.
   * @param {string} [opts.policy]            A full CSP string to use instead of the one built from `csp` (inline mode).
   * @param {string} [opts.sandbox]           The view iframe's `sandbox` attribute, if you need to change it.
   * @param {string} [opts.sandboxProxy]      URL of sandbox-proxy.html on another origin (web-host mode).
   * @param {object} [opts.tool]              The MCP Tool definition that produced this view.
   * @param {Array}  [opts.tools]             All tools from tools/list. When given, a view's tools/call is limited
   *                                          to listed tools whose `_meta.ui.visibility` includes "app".
   * @param {object} [opts.toolInput]         Arguments the tool was called with.
   * @param {object} [opts.toolResult]        The CallToolResult.
   * @param {(name: string, args: object) => Promise<object>} [opts.callTool]   Proxy for tools/call.
   * @param {(uri: string) => Promise<object>} [opts.readResource]            Proxy for resources/read.
   * @param {(params: object) => Promise<object>} [opts.listResources]       Proxy for resources/list.
   * @param {(text: string, params: object) => void} [opts.onMessage]        ui/message.
   * @param {(url: string) => boolean|void|Promise<boolean|void>} [opts.onOpenLink]  ui/open-link. Return false to deny.
   * @param {(ctx: {content?: Array, structuredContent?: object}) => void} [opts.onModelContext]
   * @param {(mode: string) => string|Promise<string>} [opts.onDisplayModeRequest]  Returns the resulting mode.
   * @param {(size: {width?: number, height?: number}) => void} [opts.onSizeChange]
   * @param {() => void} [opts.onRequestTeardown]  The view asked to be closed (draft spec).
   * @param {(entry: {dir: string, msg: object}) => void} [opts.onLog]  Every message in both directions.
   * @param {string[]} [opts.availableDisplayModes]  Modes this host supports. Default ["inline"].
   * @param {"light"|"dark"} [opts.theme]
   * @param {object} [opts.hostInfo]          {name, version}
   * @param {object} [opts.hostContext]       Merged into the hostContext sent at initialize.
   * @param {number} [opts.maxHeight]         Cap for size-changed (px).
   * @param {number} [opts.teardownTimeout]   How long unmount() waits for the view (ms). Default 1000.
   */
  constructor(opts) {
    if (!opts?.container) throw new Error("McpAppHost: container is required");
    const html = typeof opts.html === "string" ? opts.html : resourceHtml(opts.resource);
    if (typeof html !== "string") throw new Error("McpAppHost: html (or a resource with text or blob) is required");
    const ui = isObj(opts.resource?._meta?.ui) ? opts.resource._meta.ui : {};

    this.opts = opts;
    this.html = html;
    this.csp = opts.csp !== undefined ? opts.csp : ui.csp;
    this.permissions = opts.permissions !== undefined ? opts.permissions : ui.permissions;
    this.policy = typeof opts.policy === "string" ? opts.policy : buildCsp(this.csp, { inline: !opts.sandboxProxy });
    this.allow = buildAllow(this.permissions);
    this.availableDisplayModes = (opts.availableDisplayModes ?? ["inline"]).filter((m) => DISPLAY_MODES.includes(m));
    this.displayMode = "inline";
    this.modelContext = null;
    this.appInfo = null;
    this.appCapabilities = null;
    this.ready = false; // true once the view sent ui/notifications/initialized
    this.iframe = null;

    this._toolInput = opts.toolInput;
    this._toolResult = opts.toolResult;
    this._partial = undefined;
    this._inputSent = false;
    this._cancelled = undefined;
    this._context = {};
    this._pending = new Map();
    this._seq = 0;
    this._proxyOrigin = null;
  }

  /** Create the iframe and start listening. */
  mount() {
    if (this.iframe) return this;
    listen();
    const f = document.createElement("iframe");
    f.setAttribute("title", this.opts.tool?.name ? `${this.opts.tool.name} view` : "MCP App");
    f.style.width = "100%";
    f.style.border = "0";
    f.style.display = "block";
    f.style.height = `${Math.min(this.opts.maxHeight ?? 480, 480)}px`;
    if (this.allow) f.setAttribute("allow", this.allow);

    if (this.opts.sandboxProxy) {
      const here = typeof location !== "undefined" ? location.href : undefined;
      const url = new URL(this.opts.sandboxProxy, here);
      if (typeof location !== "undefined" && url.origin === location.origin) {
        throw new Error("McpAppHost: sandboxProxy must be served from a different origin than the host page");
      }
      this._proxyOrigin = url.origin;
      // The spec gives the proxy allow-scripts + allow-same-origin; isolation comes from the separate origin.
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      f.setAttribute("referrerpolicy", "origin"); // the proxy checks who embeds it
      f.src = url.href;
    } else {
      // No allow-same-origin: the view gets an opaque origin and can't reach the host page.
      f.setAttribute("sandbox", this.opts.sandbox ?? "allow-scripts");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.srcdoc = injectCsp(this.html, this.policy);
    }

    this.iframe = f;
    hosts.add(this);
    this.opts.container.appendChild(f);
    return this;
  }

  // -- Host -> view ----------------------------------------------------------

  /** Stream partial tool arguments while the model is still writing them. Ignored once the full input is known. */
  setToolInputPartial(args) {
    if (this._inputSent || this._toolInput !== undefined) return;
    this._partial = isObj(args) ? args : {};
    if (this.ready) this._notify("ui/notifications/tool-input-partial", { arguments: this._partial });
  }

  /** The complete tool arguments. Sent once; returns false if they were already sent. */
  setToolInput(args) {
    if (this._inputSent) return false;
    this._toolInput = isObj(args) ? args : {};
    if (this.ready) this._sendInput();
    return true;
  }

  /** The tool result. The tool input goes first if it hasn't been sent yet. Can be called again after a re-run. */
  setToolResult(result) {
    this._toolResult = isObj(result) ? result : { content: [] };
    if (this.ready) {
      this._sendInput();
      this._notify("ui/notifications/tool-result", this._toolResult);
    }
  }

  /** Same as setToolResult (kept from 0.1). */
  updateResult(result) {
    this.setToolResult(result);
  }

  /** Tell the view the tool call was cancelled. */
  cancel(reason = "cancelled") {
    this._cancelled = String(reason);
    if (this.ready) this._notify("ui/notifications/tool-cancelled", { reason: this._cancelled });
  }

  /** Change part of the host context (theme, displayMode, containerDimensions, ...). */
  setHostContext(partial) {
    if (!isObj(partial)) return;
    Object.assign(this._context, partial);
    if (DISPLAY_MODES.includes(partial.displayMode)) this.displayMode = partial.displayMode;
    if (this.ready) this._notify("ui/notifications/host-context-changed", partial);
  }

  /**
   * Send ui/resource-teardown, wait for the view to answer (or time out), then remove the iframe.
   * @returns {Promise<boolean>} true if the view answered in time.
   */
  async unmount(reason = "closed") {
    let answered = false;
    if (this.ready && this.iframe) {
      const reply = await this._ask("ui/resource-teardown", { reason }, this.opts.teardownTimeout ?? 1000);
      answered = reply !== null;
    }
    this.destroy();
    return answered;
  }

  /** Remove the iframe right away, without asking the view. */
  destroy() {
    hosts.delete(this);
    for (const resolve of this._pending.values()) resolve(null);
    this._pending.clear();
    this.iframe?.remove();
    this.iframe = null;
    this.ready = false;
  }

  // -- Wire ------------------------------------------------------------------

  _accepts(ev) {
    const w = this.iframe?.contentWindow;
    if (!w || ev.source !== w) return false;
    if (this._proxyOrigin) return ev.origin === this._proxyOrigin;
    return ev.origin === "null"; // a sandboxed srcdoc frame has an opaque origin
  }

  _log(dir, msg) {
    try {
      this.opts.onLog?.({ dir, msg });
    } catch {
      /* a logging hook must not break the protocol */
    }
  }

  _post(msg) {
    this._log("host->view", msg);
    try {
      this.iframe?.contentWindow?.postMessage(msg, this._proxyOrigin ?? "*");
    } catch {
      /* frame gone */
    }
  }

  _reply(id, result) {
    this._post({ jsonrpc: "2.0", id, result });
  }

  _fail(id, code, message) {
    this._post({ jsonrpc: "2.0", id, error: { code, message } });
  }

  _notify(method, params) {
    this._post({ jsonrpc: "2.0", method, params });
  }

  /** Host -> view request. Resolves with the response, or null on timeout or destroy. */
  _ask(method, params, timeout) {
    const id = `host-${++this._seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve(null);
      }, timeout);
      this._pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this._post({ jsonrpc: "2.0", id, method, params });
    });
  }

  _sendInput() {
    if (this._inputSent) return;
    this._inputSent = true;
    this._notify("ui/notifications/tool-input", { arguments: isObj(this._toolInput) ? this._toolInput : {} });
  }

  _sendResource() {
    // Host -> sandbox proxy only. The proxy builds the CSP itself from `csp`.
    const params = { html: this.html };
    if (this.csp !== undefined) params.csp = this.csp;
    if (this.permissions !== undefined) params.permissions = this.permissions;
    if (typeof this.opts.sandbox === "string") params.sandbox = this.opts.sandbox;
    this._notify("ui/notifications/sandbox-resource-ready", params);
  }

  _toolAllowed(name) {
    const list = this.opts.tools;
    if (!Array.isArray(list)) return true;
    const tool = list.find((t) => t?.name === name);
    if (!tool) return false;
    const vis = tool._meta?.ui?.visibility;
    return !Array.isArray(vis) || vis.includes("app");
  }

  _hostCapabilities() {
    const caps = { logging: {}, updateModelContext: { text: {}, structuredContent: {} } };
    if (this.opts.callTool) caps.serverTools = {};
    if (this.opts.readResource || this.opts.listResources) caps.serverResources = {};
    if (this.opts.onOpenLink) caps.openLinks = {};
    if (this.opts.onMessage) caps.message = { text: {} };
    const sandbox = {};
    if (isObj(this.permissions)) {
      sandbox.permissions = {};
      for (const k of ["camera", "microphone", "geolocation", "clipboardWrite"]) if (this.permissions[k]) sandbox.permissions[k] = {};
    }
    if (isObj(this.csp)) {
      sandbox.csp = {};
      for (const k of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]) {
        const v = sanitizeDomains(this.csp[k]);
        if (v.length) sandbox.csp[k] = v;
      }
    }
    if (Object.keys(sandbox).length) caps.sandbox = sandbox;
    return caps;
  }

  _hostContext() {
    const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
    const width = this.opts.container.clientWidth;
    const dims = {};
    if (width) dims.width = width;
    if (this.opts.maxHeight) dims.maxHeight = this.opts.maxHeight;
    const ctx = {
      theme: this.opts.theme ?? (prefersDark ? "dark" : "light"),
      displayMode: this.displayMode,
      availableDisplayModes: this.availableDisplayModes,
      containerDimensions: dims,
      locale: (typeof navigator !== "undefined" && navigator.language) || "en-US",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: "web",
    };
    if (this.opts.tool) ctx.toolInfo = { tool: this.opts.tool };
    return { ...ctx, ...(this.opts.hostContext ?? {}), ...this._context };
  }

  _receive(m) {
    if (!isObj(m) || m.jsonrpc !== "2.0") return;

    // A response to one of our requests (ui/resource-teardown).
    if (m.method === undefined) {
      const resolve = m.id != null ? this._pending.get(m.id) : undefined;
      if (resolve) {
        this._log("view->host", m);
        this._pending.delete(m.id);
        resolve(m);
      }
      return;
    }
    if (typeof m.method !== "string") return;
    this._log("view->host", m);

    if (m.method === "ui/notifications/sandbox-proxy-ready") {
      if (this._proxyOrigin) this._sendResource();
      return;
    }
    if (m.method.startsWith("ui/notifications/sandbox-")) return; // reserved for the proxy

    const p = isObj(m.params) ? m.params : {};
    if (m.id !== undefined && m.id !== null) this._handleRequest(m.id, m.method, p);
    else this._handleNotification(m.method, p);
  }

  _handleNotification(method, p) {
    switch (method) {
      case "ui/notifications/initialized":
        if (this.ready) return;
        this.ready = true; // the spec forbids host messages to the view before this point
        if (this._toolInput === undefined && this._partial !== undefined) {
          this._notify("ui/notifications/tool-input-partial", { arguments: this._partial });
        }
        if (this._toolInput !== undefined || this._toolResult) this._sendInput();
        if (this._toolResult) this._notify("ui/notifications/tool-result", this._toolResult);
        else if (this._cancelled !== undefined) this._notify("ui/notifications/tool-cancelled", { reason: this._cancelled });
        return;

      case "ui/notifications/size-changed": {
        const h = Number(p.height);
        if (this.iframe && Number.isFinite(h) && h > 0) {
          const cap = this.opts.maxHeight ?? Infinity;
          this.iframe.style.height = `${Math.min(Math.ceil(h), cap)}px`;
        }
        const size = {};
        if (Number.isFinite(Number(p.width))) size.width = Number(p.width);
        if (Number.isFinite(h)) size.height = h;
        this.opts.onSizeChange?.(size);
        return;
      }

      case "ui/notifications/request-teardown":
        this.opts.onRequestTeardown?.();
        return;

      default:
        return; // notifications/message and unknown notifications are only logged
    }
  }

  async _handleRequest(id, method, p) {
    try {
      switch (method) {
        case "ui/initialize":
          this.appInfo = isObj(p.appInfo) ? p.appInfo : isObj(p.clientInfo) ? p.clientInfo : null;
          this.appCapabilities = isObj(p.appCapabilities) ? p.appCapabilities : {};
          return this._reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: this.opts.hostInfo ?? { name: "mcp-apps-lite-host", version: VERSION },
            hostCapabilities: this._hostCapabilities(),
            hostContext: this._hostContext(),
          });

        case "ping":
          return this._reply(id, {});

        case "tools/call": {
          if (!this.opts.callTool) return this._fail(id, -32601, "Host does not proxy tool calls");
          const name = typeof p.name === "string" ? p.name : "";
          if (!name) return this._fail(id, -32602, "Missing tool name");
          if (!this._toolAllowed(name)) return this._fail(id, -32000, `Tool not available to apps: ${name}`);
          const result = await this.opts.callTool(name, isObj(p.arguments) ? p.arguments : {});
          return this._reply(id, isObj(result) ? result : { content: [] });
        }

        case "resources/read": {
          if (!this.opts.readResource) return this._fail(id, -32601, "Host does not proxy resource reads");
          if (typeof p.uri !== "string" || !p.uri) return this._fail(id, -32602, "Missing resource uri");
          const result = await this.opts.readResource(p.uri);
          return this._reply(id, isObj(result) ? result : { contents: [] });
        }

        case "resources/list": {
          if (!this.opts.listResources) return this._fail(id, -32601, "Host does not proxy resource lists");
          const result = await this.opts.listResources(p);
          return this._reply(id, isObj(result) ? result : { resources: [] });
        }

        case "ui/message": {
          if (!this.opts.onMessage) return this._fail(id, -32601, "Host does not accept messages");
          const text = messageText(p.content);
          if (!text) return this._fail(id, -32602, "Message has no text");
          this._reply(id, {});
          setTimeout(() => this.opts.onMessage(text, p), 0);
          return;
        }

        case "ui/open-link": {
          if (!this.opts.onOpenLink) return this._fail(id, -32601, "Opening links is not supported by this host");
          let url;
          try {
            url = new URL(String(p.url));
          } catch {
            return this._fail(id, -32602, "Invalid URL");
          }
          if (!LINK_PROTOCOLS.includes(url.protocol)) return this._fail(id, -32602, "Invalid URL");
          const ok = await this.opts.onOpenLink(url.href);
          if (ok === false) return this._fail(id, -32000, "Link opening denied");
          return this._reply(id, {});
        }

        case "ui/request-display-mode": {
          const mode = p.mode;
          const appModes = this.appCapabilities?.availableDisplayModes;
          const allowed =
            DISPLAY_MODES.includes(mode) &&
            this.availableDisplayModes.includes(mode) &&
            (!Array.isArray(appModes) || appModes.includes(mode));
          if (allowed && mode !== this.displayMode) {
            const next = this.opts.onDisplayModeRequest ? await this.opts.onDisplayModeRequest(mode) : mode;
            if (DISPLAY_MODES.includes(next) && next !== this.displayMode) {
              this.displayMode = next;
              this._context.displayMode = next;
              this._reply(id, { mode: next });
              this._notify("ui/notifications/host-context-changed", { displayMode: next });
              return;
            }
          }
          return this._reply(id, { mode: this.displayMode });
        }

        case "ui/update-model-context": {
          const ctx = {};
          if (Array.isArray(p.content)) ctx.content = p.content;
          if (isObj(p.structuredContent)) ctx.structuredContent = p.structuredContent;
          this.modelContext = ctx;
          this.opts.onModelContext?.(ctx);
          return this._reply(id, {});
        }

        default:
          return this._fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      this._fail(id, -32000, err?.message || "Request failed");
    }
  }
}

export default McpAppHost;
