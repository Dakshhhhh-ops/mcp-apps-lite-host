/**
 * mcp-apps-lite-host: render MCP Apps views (ext-apps spec 2026-01-26) in any web page.
 *
 * A tool that declares `_meta.ui.resourceUri` points at a `ui://` HTML resource
 * (`text/html;profile=mcp-app`). This host puts that HTML in a sandboxed iframe and
 * speaks the View <-> Host JSON-RPC protocol over postMessage:
 *
 *   view  -> ui/initialize                 host replies with hostContext + capabilities
 *   view  -> ui/notifications/initialized  host sends tool-input, then tool-result
 *   view  -> tools/call                    host proxies to your MCP client (callTool)
 *   view  -> ui/message                    host hands text to your chat (onMessage)
 *   view  -> ui/notifications/size-changed host resizes the iframe
 *   view  -> ping                          host replies {}
 *
 * No dependencies. MIT licensed.
 */

const PROTOCOL_VERSION = "2026-01-26";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const hosts = new Set();
let listening = false;

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (ev) => {
    for (const host of hosts) {
      if (host.iframe?.contentWindow && ev.source === host.iframe.contentWindow) {
        host._handle(ev.data);
        return;
      }
    }
  });
}

export class McpAppHost {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container    Where to mount the iframe.
   * @param {string} opts.html              The ui:// resource text (from resources/read).
   * @param {object} [opts.tool]            The MCP Tool definition (at least {name}).
   * @param {object} [opts.toolInput]       Arguments the tool was called with.
   * @param {object} [opts.toolResult]      The CallToolResult ({content, structuredContent, isError}).
   * @param {(name: string, args: object) => Promise<object>} [opts.callTool]
   *        Proxy for view-initiated tools/call. Omit to deny tool calls.
   * @param {(text: string) => void} [opts.onMessage]  Receives ui/message text.
   * @param {(entry: object) => void} [opts.onLog]     Receives every message in both directions.
   * @param {object} [opts.hostInfo]        {name, version}
   * @param {object} [opts.hostContext]     Merged into the default hostContext (theme, locale, ...).
   * @param {number} [opts.maxHeight]       Cap for size-changed (px).
   */
  constructor(opts) {
    if (!opts?.container) throw new Error("McpAppHost: container is required");
    this.opts = opts;
    this.ready = false;
    this.iframe = null;
    this._seq = 0;
  }

  mount() {
    listen();
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts"); // no same-origin: the view can't touch the host page
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("title", this.opts.tool?.name ? `${this.opts.tool.name} view` : "MCP App");
    f.style.width = "100%";
    f.style.border = "0";
    f.style.height = `${Math.min(this.opts.maxHeight ?? 480, 480)}px`;
    f.srcdoc = this.opts.html;
    this.iframe = f;
    hosts.add(this);
    this.opts.container.appendChild(f);
    return this;
  }

  /** Push a fresh result into an already-mounted view (e.g. after a re-run). */
  updateResult(result) {
    this.opts.toolResult = result;
    if (this.ready) this._notify("ui/notifications/tool-result", result);
  }

  unmount(reason = "closed") {
    if (this.ready) this._post({ jsonrpc: "2.0", id: `teardown-${++this._seq}`, method: "ui/resource-teardown", params: { reason } });
    hosts.delete(this);
    this.iframe?.remove();
    this.iframe = null;
    this.ready = false;
  }

  // -- wire ------------------------------------------------------------------
  _post(msg) {
    this.opts.onLog?.({ dir: "host->view", msg });
    try { this.iframe?.contentWindow?.postMessage(msg, "*"); } catch { /* frame gone */ }
  }
  _reply(id, result) { this._post({ jsonrpc: "2.0", id, result }); }
  _fail(id, code, message) { this._post({ jsonrpc: "2.0", id, error: { code, message } }); }
  _notify(method, params) { this._post({ jsonrpc: "2.0", method, params }); }

  _handle(m) {
    if (!isObj(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string") return; // ignore non-JSON-RPC and responses
    this.opts.onLog?.({ dir: "view->host", msg: m });
    const isRequest = m.id !== undefined && m.id !== null;
    const p = isObj(m.params) ? m.params : {};

    switch (m.method) {
      case "ui/initialize":
        if (!isRequest) return;
        this._reply(m.id, {
          protocolVersion: PROTOCOL_VERSION,
          hostCapabilities: { ...(this.opts.callTool ? { serverTools: {} } : {}), logging: {} },
          hostInfo: this.opts.hostInfo ?? { name: "mcp-apps-lite-host", version: "0.1.0" },
          hostContext: {
            theme: "dark",
            displayMode: "inline",
            availableDisplayModes: ["inline"],
            platform: "web",
            locale: (typeof navigator !== "undefined" && navigator.language) || "en-US",
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(this.opts.tool ? { toolInfo: { tool: this.opts.tool } } : {}),
            containerDimensions: {
              width: this.opts.container.clientWidth || undefined,
              ...(this.opts.maxHeight ? { maxHeight: this.opts.maxHeight } : {}),
            },
            ...(this.opts.hostContext ?? {}),
          },
        });
        return;

      case "ui/notifications/initialized":
        if (this.ready) return;
        this.ready = true; // the spec forbids host messages before this point
        this._notify("ui/notifications/tool-input", { arguments: isObj(this.opts.toolInput) ? this.opts.toolInput : {} });
        if (this.opts.toolResult) this._notify("ui/notifications/tool-result", this.opts.toolResult);
        return;

      case "ui/notifications/size-changed": {
        const h = Number(p.height);
        if (this.iframe && Number.isFinite(h) && h > 0) {
          const cap = this.opts.maxHeight ?? Infinity;
          this.iframe.style.height = `${Math.min(Math.ceil(h), cap)}px`;
        }
        return;
      }

      case "tools/call":
        if (isRequest) this._toolCall(m.id, p);
        return;

      case "ui/message":
        if (!isRequest) return;
        if (!this.opts.onMessage) { this._fail(m.id, -32601, "Host does not accept messages"); return; }
        {
          const blocks = Array.isArray(p.content) ? p.content : [p.content];
          const text = blocks.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : "")).filter(Boolean).join(" ").trim();
          if (!text) { this._fail(m.id, -32602, "Message has no text"); return; }
          this._reply(m.id, {});
          setTimeout(() => this.opts.onMessage(text), 0);
        }
        return;

      case "ui/open-link":
        if (isRequest) this._fail(m.id, -32601, "Opening links is not supported by this host");
        return;

      case "ping":
        if (isRequest) this._reply(m.id, {});
        return;

      case "notifications/message":
        return; // view logging, already passed to onLog

      default:
        if (isRequest) this._fail(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  async _toolCall(id, p) {
    if (!this.opts.callTool) { this._fail(id, -32601, "Host does not proxy tool calls"); return; }
    const name = String(p.name || "");
    if (!name) { this._fail(id, -32602, "Missing tool name"); return; }
    try {
      const result = await this.opts.callTool(name, isObj(p.arguments) ? p.arguments : {});
      this._reply(id, isObj(result) ? result : { content: [] });
    } catch (err) {
      this._fail(id, -32000, err?.message || "Tool call failed");
    }
  }
}

export default McpAppHost;
