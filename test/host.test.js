// Tests for mcp-apps-lite-host: the View <-> Host protocol, with a minimal fake DOM.
// Run: npm run test:unit   (no dependencies)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- a tiny fake browser ---------------------------------------------------
let listeners = [];
let lastFrame = null;

function makeFrame() {
  const frame = {
    attrs: {},
    style: {},
    posted: [],
    targets: [],
    removed: false,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    remove() { this.removed = true; },
  };
  frame.contentWindow = {
    postMessage: (msg, target) => { frame.posted.push(structuredClone(msg)); frame.targets.push(target); },
  };
  return frame;
}

globalThis.window = { addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); } };
globalThis.document = { createElement: () => (lastFrame = makeFrame()) };
if (!globalThis.navigator) globalThis.navigator = { language: "en-US" }; // Node 21+ has one built in

const { McpAppHost, buildCsp, buildAllow, injectCsp, sanitizeDomains, resourceHtml, PROTOCOL_VERSION } = await import("../mcp-apps-host.js");

const container = () => ({ children: [], clientWidth: 640, appendChild(c) { this.children.push(c); } });
// Deliver a message as if the View posted it. A sandboxed srcdoc frame has the opaque origin "null".
const fromView = (frame, data, origin = "null") => listeners.forEach((fn) => fn({ source: frame.contentWindow, origin, data }));
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const init = (frame, params = {}) => {
  fromView(frame, { jsonrpc: "2.0", id: "init", method: "ui/initialize", params });
  return frame.posted.at(-1).result;
};
const ready = (frame, params) => {
  const result = init(frame, params);
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  return result;
};

function mount(opts = {}) {
  const host = new McpAppHost({
    container: container(),
    html: "<p>view</p>",
    tool: { name: "care_briefing" },
    toolInput: { period: "week" },
    toolResult: { content: [], structuredContent: { speech: "Mostly okay." } },
    ...opts,
  }).mount();
  return { host, frame: lastFrame };
}

beforeEach(() => { lastFrame = null; });

// ---- mounting ----------------------------------------------------------------
test("mounts a sandboxed iframe with the view HTML behind a CSP", () => {
  const { frame } = mount();
  assert.equal(frame.attrs.sandbox, "allow-scripts");
  assert.equal(frame.attrs.referrerpolicy, "no-referrer");
  assert.ok(frame.srcdoc.startsWith(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline';`));
  assert.doesNotMatch(frame.srcdoc, /'self'/, "in a srcdoc frame 'self' would mean the host page");
  assert.ok(frame.srcdoc.endsWith("<p>view</p>"));
  assert.equal(frame.attrs.allow, undefined, "no permissions requested, no allow attribute");
});

test("requires a container and some HTML", () => {
  assert.throws(() => new McpAppHost({ html: "" }), /container is required/);
  assert.throws(() => new McpAppHost({ container: container() }), /html/);
});

test("reads html, csp and permissions from a resources/read content item", () => {
  const html = "<!doctype html><p>Café ✓</p>";
  const { host, frame } = mount({
    html: undefined,
    resource: {
      uri: "ui://x/view.html",
      mimeType: "text/html;profile=mcp-app",
      blob: Buffer.from(html, "utf8").toString("base64"),
      _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] }, permissions: { camera: {}, microphone: {} } } },
    },
  });
  assert.equal(host.html, html);
  assert.equal(frame.attrs.allow, "camera; microphone");
  assert.match(frame.srcdoc, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  assert.match(frame.srcdoc, /connect-src https:\/\/api\.example\.com/);
});

// ---- handshake ---------------------------------------------------------------
test("answers ui/initialize with protocol version, host info and context", () => {
  const { frame } = mount({ hostInfo: { name: "Nova", version: "1" }, hostContext: { theme: "light" }, maxHeight: 500 });
  const result = init(frame, { appInfo: { name: "view", version: "1" }, appCapabilities: {}, protocolVersion: PROTOCOL_VERSION });
  assert.equal(result.protocolVersion, "2026-01-26");
  assert.deepEqual(result.hostInfo, { name: "Nova", version: "1" });
  assert.equal(result.hostContext.theme, "light"); // caller overrides win
  assert.equal(result.hostContext.toolInfo.tool.name, "care_briefing");
  assert.deepEqual(result.hostContext.containerDimensions, { width: 640, maxHeight: 500 });
  assert.deepEqual(result.hostContext.availableDisplayModes, ["inline"]);
  assert.equal(result.hostContext.platform, "web");
});

test("advertises only the capabilities it was given handlers for", () => {
  const bare = init(mount().frame).hostCapabilities;
  assert.deepEqual(Object.keys(bare).sort(), ["logging", "updateModelContext"]);
  const full = init(mount({
    callTool: async () => ({}), readResource: async () => ({}), onOpenLink: () => {}, onMessage: () => {},
    csp: { resourceDomains: ["https://cdn.example.com", "bad; script-src *"] }, permissions: { geolocation: {} },
  }).frame).hostCapabilities;
  assert.deepEqual(full.serverTools, {});
  assert.deepEqual(full.serverResources, {});
  assert.deepEqual(full.openLinks, {});
  assert.deepEqual(full.message, { text: {} });
  assert.deepEqual(full.sandbox, { permissions: { geolocation: {} }, csp: { resourceDomains: ["https://cdn.example.com"] } });
});

test("sends tool-input then tool-result only after initialized, once", () => {
  const { frame } = mount();
  assert.equal(frame.posted.length, 0, "nothing before the view is ready");
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  assert.deepEqual(frame.posted.map((m) => m.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  assert.deepEqual(frame.posted[0].params, { arguments: { period: "week" } });
  assert.equal(frame.posted[1].params.structuredContent.speech, "Mostly okay.");
});

test("streams partial input, then the full input once, then the result", () => {
  const { host, frame } = mount({ toolInput: undefined, toolResult: undefined });
  host.setToolInputPartial({ period: "we" });
  ready(frame);
  host.setToolInputPartial({ period: "wee" });
  assert.equal(host.setToolInput({ period: "week" }), true);
  assert.equal(host.setToolInput({ period: "month" }), false, "input is sent at most once");
  host.setToolInputPartial({ period: "late" }); // ignored after the full input
  host.setToolResult({ content: [], structuredContent: { ok: true } });
  const sent = frame.posted.filter((m) => m.method?.startsWith("ui/notifications/tool"));
  assert.deepEqual(sent.map((m) => [m.method, m.params.arguments?.period]), [
    ["ui/notifications/tool-input-partial", "we"],
    ["ui/notifications/tool-input-partial", "wee"],
    ["ui/notifications/tool-input", "week"],
    ["ui/notifications/tool-result", undefined],
  ]);
});

test("a result without known input still sends tool-input first", () => {
  const { host, frame } = mount({ toolInput: undefined, toolResult: undefined });
  ready(frame);
  assert.equal(frame.posted.filter((m) => m.method).length, 0, "nothing to send yet");
  host.setToolResult({ content: [{ type: "text", text: "done" }] });
  assert.deepEqual(frame.posted.filter((m) => m.method).map((m) => m.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  assert.deepEqual(frame.posted.find((m) => m.method === "ui/notifications/tool-input").params, { arguments: {} });
});

test("cancel() is delivered after initialized, or right away when ready", () => {
  const a = mount({ toolInput: { q: 1 }, toolResult: undefined });
  a.host.cancel("user stopped it");
  assert.equal(a.frame.posted.length, 0);
  ready(a.frame);
  assert.deepEqual(a.frame.posted.at(-1), { jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: { reason: "user stopped it" } });
  const b = mount({ toolResult: undefined });
  ready(b.frame);
  b.host.cancel();
  assert.equal(b.frame.posted.at(-1).params.reason, "cancelled");
});

test("setHostContext merges into later initialize results and notifies a ready view", () => {
  const { host, frame } = mount();
  host.setHostContext({ theme: "dark" });
  assert.equal(frame.posted.length, 0);
  assert.equal(init(frame).hostContext.theme, "dark");
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  host.setHostContext({ theme: "light", displayMode: "fullscreen" });
  assert.deepEqual(frame.posted.at(-1), { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light", displayMode: "fullscreen" } });
  assert.equal(host.displayMode, "fullscreen");
});

// ---- view requests -------------------------------------------------------------
test("proxies tools/call to the MCP client and returns its result", async () => {
  const calls = [];
  const { frame } = mount({ callTool: async (name, args) => { calls.push([name, args]); return { content: [], structuredContent: { ok: true } }; } });
  fromView(frame, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "resolve_alert", arguments: { alert_id: 3 } } });
  await settle();
  assert.deepEqual(calls, [["resolve_alert", { alert_id: 3 }]]);
  assert.deepEqual(frame.posted.at(-1), { jsonrpc: "2.0", id: 7, result: { content: [], structuredContent: { ok: true } } });
});

test("tools/call errors are JSON-RPC errors", async () => {
  const { frame } = mount({ callTool: async () => { throw new Error("server down"); } });
  fromView(frame, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "x" } });
  await settle();
  assert.equal(frame.posted.at(-1).error.code, -32000);
  assert.match(frame.posted.at(-1).error.message, /server down/);
});

test("without callTool, tools/call is refused; a missing name is invalid", async () => {
  const { frame } = mount();
  fromView(frame, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } });
  await settle();
  assert.equal(frame.posted.at(-1).error.code, -32601);
  const b = mount({ callTool: async () => ({}) });
  fromView(b.frame, { jsonrpc: "2.0", id: 10, method: "tools/call", params: {} });
  await settle();
  assert.equal(b.frame.posted.at(-1).error.code, -32602);
});

test("with a tool list, views may only call tools visible to apps", async () => {
  const called = [];
  const tools = [
    { name: "shared" }, // default visibility: model + app
    { name: "app_only", _meta: { ui: { visibility: ["app"] } } },
    { name: "model_only", _meta: { ui: { visibility: ["model"] } } },
  ];
  const { frame } = mount({ tools, callTool: async (name) => { called.push(name); return { content: [] }; } });
  for (const [i, name] of ["shared", "app_only", "model_only", "not_listed"].entries()) {
    fromView(frame, { jsonrpc: "2.0", id: 20 + i, method: "tools/call", params: { name } });
  }
  await settle();
  assert.deepEqual(called, ["shared", "app_only"]);
  assert.deepEqual(frame.posted.filter((m) => m.error).map((m) => [m.id, m.error.code]), [[22, -32000], [23, -32000]]);
});

test("proxies resources/read and resources/list", async () => {
  const { frame } = mount({
    readResource: async (uri) => ({ contents: [{ uri, text: "hi" }] }),
    listResources: async () => ({ resources: [{ uri: "nova://circle", name: "circle" }] }),
  });
  fromView(frame, { jsonrpc: "2.0", id: 30, method: "resources/read", params: { uri: "nova://circle" } });
  fromView(frame, { jsonrpc: "2.0", id: 31, method: "resources/list", params: {} });
  fromView(frame, { jsonrpc: "2.0", id: 32, method: "resources/read", params: {} });
  await settle();
  assert.deepEqual(frame.posted.find((m) => m.id === 30).result, { contents: [{ uri: "nova://circle", text: "hi" }] });
  assert.equal(frame.posted.find((m) => m.id === 31).result.resources[0].uri, "nova://circle");
  assert.equal(frame.posted.find((m) => m.id === 32).error.code, -32602);
});

test("ui/message hands the text to the chat", async () => {
  const said = [];
  const { frame } = mount({ onMessage: (t) => said.push(t) });
  fromView(frame, { jsonrpc: "2.0", id: 10, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Prepare a visit brief" }] } });
  fromView(frame, { jsonrpc: "2.0", id: 11, method: "ui/message", params: { role: "user", content: { type: "text", text: "single block" } } });
  fromView(frame, { jsonrpc: "2.0", id: 12, method: "ui/message", params: { role: "user", content: [{ type: "image", data: "" }] } });
  await settle(5);
  assert.deepEqual(said, ["Prepare a visit brief", "single block"]);
  assert.deepEqual(frame.posted.find((m) => m.id === 10), { jsonrpc: "2.0", id: 10, result: {} });
  assert.equal(frame.posted.find((m) => m.id === 12).error.code, -32602);
});

test("ui/open-link: http(s) goes to the handler, other schemes and denials are errors", async () => {
  const opened = [];
  const { frame } = mount({ onOpenLink: (url) => { opened.push(url); return !url.includes("deny"); } });
  const ask = (id, url) => fromView(frame, { jsonrpc: "2.0", id, method: "ui/open-link", params: { url } });
  ask(40, "https://example.com/a");
  ask(41, "javascript:alert(1)");
  ask(42, "not a url");
  ask(43, "https://example.com/deny");
  await settle();
  assert.deepEqual(opened, ["https://example.com/a", "https://example.com/deny"]);
  const by = (id) => frame.posted.find((m) => m.id === id);
  assert.deepEqual(by(40).result, {});
  assert.equal(by(41).error.code, -32602);
  assert.equal(by(42).error.code, -32602);
  assert.equal(by(43).error.code, -32000);
  const plain = mount();
  fromView(plain.frame, { jsonrpc: "2.0", id: 44, method: "ui/open-link", params: { url: "https://example.com" } });
  await settle();
  assert.equal(plain.frame.posted.at(-1).error.code, -32601);
});

test("ui/request-display-mode respects host and view support and returns the resulting mode", async () => {
  const inlineOnly = mount();
  ready(inlineOnly.frame, { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } });
  fromView(inlineOnly.frame, { jsonrpc: "2.0", id: 50, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  await settle();
  assert.deepEqual(inlineOnly.frame.posted.at(-1).result, { mode: "inline" });

  const both = mount({ availableDisplayModes: ["inline", "fullscreen"] });
  ready(both.frame, { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } });
  fromView(both.frame, { jsonrpc: "2.0", id: 51, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  await settle();
  const tail = both.frame.posted.slice(-2);
  assert.deepEqual(tail[0], { jsonrpc: "2.0", id: 51, result: { mode: "fullscreen" } });
  assert.deepEqual(tail[1], { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: "fullscreen" } });
  assert.equal(both.host.displayMode, "fullscreen");

  const undeclared = mount({ availableDisplayModes: ["inline", "pip"] });
  ready(undeclared.frame, { appCapabilities: { availableDisplayModes: ["inline"] } });
  fromView(undeclared.frame, { jsonrpc: "2.0", id: 52, method: "ui/request-display-mode", params: { mode: "pip" } });
  await settle();
  assert.deepEqual(undeclared.frame.posted.at(-1).result, { mode: "inline" }, "the view didn't declare pip");

  const vetoed = mount({ availableDisplayModes: ["inline", "fullscreen"], onDisplayModeRequest: () => "inline" });
  ready(vetoed.frame, {});
  fromView(vetoed.frame, { jsonrpc: "2.0", id: 53, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  await settle();
  assert.deepEqual(vetoed.frame.posted.at(-1).result, { mode: "inline" });
});

test("ui/update-model-context is stored, overwritten and passed on", async () => {
  const seen = [];
  const { host, frame } = mount({ onModelContext: (c) => seen.push(c) });
  fromView(frame, { jsonrpc: "2.0", id: 60, method: "ui/update-model-context", params: { content: [{ type: "text", text: "a" }] } });
  fromView(frame, { jsonrpc: "2.0", id: 61, method: "ui/update-model-context", params: { structuredContent: { b: 2 } } });
  await settle();
  assert.deepEqual(host.modelContext, { structuredContent: { b: 2 } });
  assert.equal(seen.length, 2);
  assert.deepEqual(frame.posted.at(-1), { jsonrpc: "2.0", id: 61, result: {} });
});

test("unknown requests get -32601 and pings get {}", async () => {
  const { frame } = mount();
  fromView(frame, { jsonrpc: "2.0", id: 11, method: "ui/does-not-exist" });
  await settle();
  assert.equal(frame.posted.at(-1).error.code, -32601);
  fromView(frame, { jsonrpc: "2.0", id: 12, method: "ping" });
  await settle();
  assert.deepEqual(frame.posted.at(-1), { jsonrpc: "2.0", id: 12, result: {} });
});

// ---- view notifications ------------------------------------------------------
test("size-changed resizes the iframe, capped at maxHeight", () => {
  const sizes = [];
  const { frame } = mount({ maxHeight: 300, onSizeChange: (s) => sizes.push(s) });
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 400, height: 220.4 } });
  assert.equal(frame.style.height, "221px");
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 900 } });
  assert.equal(frame.style.height, "300px");
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: "nope" } });
  assert.equal(frame.style.height, "300px");
  assert.deepEqual(sizes.slice(0, 2), [{ width: 400, height: 220.4 }, { height: 900 }]);
});

test("the draft request-teardown notification reaches onRequestTeardown", () => {
  let asked = 0;
  const { frame } = mount({ onRequestTeardown: () => asked++ });
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
  assert.equal(asked, 1);
});

// ---- isolation -----------------------------------------------------------------
test("ignores messages from other windows, other origins and non-JSON-RPC data", () => {
  const { frame } = mount();
  listeners.forEach((fn) => fn({ source: {}, origin: "null", data: { jsonrpc: "2.0", id: 1, method: "ui/initialize" } }));
  fromView(frame, { jsonrpc: "2.0", id: 2, method: "ui/initialize" }, "https://evil.example");
  fromView(frame, "hello");
  fromView(frame, { id: 3, method: "ui/initialize" });
  fromView(frame, { jsonrpc: "2.0", id: "host-99", result: {} }); // a response nobody asked for
  assert.equal(frame.posted.length, 0);
});

test("the view can't use the sandbox proxy's reserved messages in inline mode", () => {
  const { frame } = mount();
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
  fromView(frame, { jsonrpc: "2.0", id: 5, method: "ui/notifications/sandbox-resource-ready", params: {} });
  assert.equal(frame.posted.length, 0);
});

test("routes each message to the host that owns the source frame", () => {
  const a = mount({ hostInfo: { name: "A", version: "1" } });
  const b = mount({ hostInfo: { name: "B", version: "1" } });
  assert.equal(init(b.frame).hostInfo.name, "B");
  assert.equal(a.frame.posted.length, 0);
  assert.equal(init(a.frame).hostInfo.name, "A");
});

// ---- sandbox proxy mode ----------------------------------------------------------
test("sandboxProxy mode loads the proxy, hands it the resource and talks only to its origin", () => {
  const { frame } = mount({
    sandboxProxy: "https://sandbox.example.net/sandbox-proxy.html",
    csp: { connectDomains: ["https://api.example.com"] },
    permissions: { clipboardWrite: {} },
  });
  assert.equal(frame.src, "https://sandbox.example.net/sandbox-proxy.html");
  assert.equal(frame.srcdoc, undefined);
  assert.equal(frame.attrs.sandbox, "allow-scripts allow-same-origin allow-forms");
  assert.equal(frame.attrs.referrerpolicy, "origin");
  assert.equal(frame.attrs.allow, "clipboard-write");

  const ready = { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} };
  fromView(frame, ready, "https://evil.example");
  fromView(frame, ready, "null");
  assert.equal(frame.posted.length, 0, "only the proxy's origin is trusted");

  fromView(frame, ready, "https://sandbox.example.net");
  assert.deepEqual(frame.posted.at(-1), {
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-resource-ready",
    params: { html: "<p>view</p>", csp: { connectDomains: ["https://api.example.com"] }, permissions: { clipboardWrite: {} } },
  });
  assert.equal(frame.targets.at(-1), "https://sandbox.example.net");
  fromView(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} }, "https://sandbox.example.net");
  assert.equal(frame.posted.at(-1).result.protocolVersion, "2026-01-26");
});

// ---- lifecycle -------------------------------------------------------------------
test("updateResult pushes a fresh result to a ready view; unmount waits for the teardown reply", async () => {
  const { host, frame } = mount();
  host.updateResult({ content: [], structuredContent: { speech: "too early" } });
  assert.equal(frame.posted.length, 0, "not before initialized");
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  host.updateResult({ content: [], structuredContent: { speech: "Updated." } });
  assert.equal(frame.posted.at(-1).params.structuredContent.speech, "Updated.");

  const done = host.unmount("closed");
  const teardown = frame.posted.find((m) => m.method === "ui/resource-teardown");
  assert.equal(teardown.params.reason, "closed");
  assert.ok(teardown.id, "teardown is a request");
  assert.equal(frame.removed, false, "waits for the view");
  fromView(frame, { jsonrpc: "2.0", id: teardown.id, result: {} });
  assert.equal(await done, true);
  assert.equal(frame.removed, true);
  assert.equal(host.iframe, null);
});

test("unmount gives up after teardownTimeout; before initialized it removes right away", async () => {
  const slow = mount({ teardownTimeout: 20 });
  ready(slow.frame);
  const started = Date.now();
  assert.equal(await slow.host.unmount(), false);
  assert.ok(Date.now() - started >= 15);
  assert.equal(slow.frame.removed, true);
  const early = mount();
  assert.equal(await early.host.unmount(), false);
  assert.equal(early.frame.posted.length, 0, "no teardown before the view is ready");
  assert.equal(early.frame.removed, true);
});

test("logs every message in both directions; a throwing logger can't break the protocol", () => {
  const log = [];
  const { frame } = mount({ onLog: (e) => log.push(e.dir) });
  fromView(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
  assert.deepEqual(log, ["view->host", "host->view"]);
  const loud = mount({ onLog: () => { throw new Error("boom"); } });
  assert.equal(init(loud.frame).protocolVersion, "2026-01-26");
});

// ---- security helpers ------------------------------------------------------------
test("buildCsp: restrictive default without metadata, declared origins only with it", () => {
  assert.equal(buildCsp(undefined),
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "media-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'");
  const p = buildCsp({
    connectDomains: ["https://api.example.com", "wss://live.example.com"],
    resourceDomains: ["https://*.cdn.example.com"],
    frameDomains: ["https://www.youtube.com"],
    baseUriDomains: ["https://base.example.com"],
  });
  assert.match(p, /connect-src 'self' https:\/\/api\.example\.com wss:\/\/live\.example\.com/);
  assert.match(p, /script-src 'self' 'unsafe-inline' https:\/\/\*\.cdn\.example\.com/);
  assert.match(p, /font-src 'self' https:\/\/\*\.cdn\.example\.com/);
  assert.match(p, /frame-src https:\/\/www\.youtube\.com/);
  assert.match(p, /base-uri https:\/\/base\.example\.com/);
  assert.match(p, /object-src 'none'/);
  assert.match(buildCsp({}), /frame-src 'none'.*base-uri 'self'/);
});

test("buildCsp inline: drops 'self', leaving 'none' where nothing else is allowed", () => {
  assert.equal(buildCsp(undefined, { inline: true }),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
    "media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
  assert.match(buildCsp({ connectDomains: ["https://api.example.com"] }, { inline: true }), /connect-src https:\/\/api\.example\.com; img-src data:; font-src 'none'/);
});

test("sanitizeDomains drops entries that could inject directives or keywords", () => {
  assert.deepEqual(sanitizeDomains([
    "https://ok.example.com",
    "https://a.com; script-src *",
    "'unsafe-eval'",
    "https://a.com https://b.com",
    "https://a.com,https://b.com",
    "https://a.com\nscript-src *",
    "<x>",
    "",
    42,
    null,
  ]), ["https://ok.example.com"]);
  assert.deepEqual(sanitizeDomains("https://a.com"), []);
  assert.doesNotMatch(buildCsp({ connectDomains: ["* 'unsafe-eval'"] }), /unsafe-eval/);
});

test("buildAllow separates Permissions Policy features with semicolons", () => {
  assert.equal(buildAllow({ camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} }), "camera; microphone; geolocation; clipboard-write");
  assert.equal(buildAllow({ microphone: {} }), "microphone");
  assert.equal(buildAllow(undefined), "");
  assert.equal(buildAllow({ camera: false, usb: {} }), "");
});

test("injectCsp puts the policy before anything the view controls", () => {
  const policy = "default-src 'none'";
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  assert.equal(injectCsp("<p>x</p>", policy), `${tag}<p>x</p>`);
  assert.equal(injectCsp("<!DOCTYPE html><html><head></head></html>", policy), `<!DOCTYPE html>${tag}<html><head></head></html>`);
  // A fake <head> inside a comment can't push the policy into the comment.
  assert.ok(injectCsp("<!--<head>--><script>evil()</script>", policy).startsWith(tag));
  // Quotes in the policy can't break out of the attribute.
  assert.equal(injectCsp("", 'a"b<c>&'), '<meta http-equiv="Content-Security-Policy" content="a&quot;b&lt;c&gt;&amp;">');
});

test("resourceHtml decodes text and UTF-8 base64 blobs", () => {
  assert.equal(resourceHtml({ text: "<p>a</p>" }), "<p>a</p>");
  assert.equal(resourceHtml({ blob: Buffer.from("<p>é ✓</p>").toString("base64") }), "<p>é ✓</p>");
  assert.equal(resourceHtml({}), undefined);
  assert.equal(resourceHtml(null), undefined);
});
