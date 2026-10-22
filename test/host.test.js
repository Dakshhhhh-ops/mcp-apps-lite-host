// Tests for mcp-apps-lite-host: the View <-> Host protocol, with a minimal fake DOM.
// Run: node --test
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
    removed: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() { this.removed = true; },
  };
  frame.contentWindow = { postMessage: (msg) => frame.posted.push(msg) };
  return frame;
}

globalThis.window = { addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); } };
globalThis.document = { createElement: () => (lastFrame = makeFrame()) };
if (!globalThis.navigator) globalThis.navigator = { language: "en-US" }; // Node 21+ has one built in

const { McpAppHost } = await import("../mcp-apps-host.js");

const container = () => ({ children: [], clientWidth: 640, appendChild(c) { this.children.push(c); } });
// Deliver a message as if the View posted it.
const fromView = (frame, data) => listeners.forEach((fn) => fn({ source: frame.contentWindow, data }));
const settle = () => new Promise((r) => setTimeout(r, 0));

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

// ---- tests --------------------------------------------------------------------
test("mounts a sandboxed iframe with the view HTML", () => {
  const { frame } = mount();
  assert.equal(frame.attrs.sandbox, "allow-scripts");
  assert.equal(frame.srcdoc, "<p>view</p>");
});

test("answers ui/initialize with protocol version, host info and context", () => {
  const { frame } = mount({ hostInfo: { name: "Nova", version: "1" }, hostContext: { theme: "light" } });
  fromView(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
  const reply = frame.posted.at(-1);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, "2026-01-26");
  assert.deepEqual(reply.result.hostInfo, { name: "Nova", version: "1" });
  assert.equal(reply.result.hostContext.theme, "light"); // caller overrides win
  assert.equal(reply.result.hostContext.toolInfo.tool.name, "care_briefing");
});

test("sends tool-input then tool-result only after initialized, once", () => {
  const { frame } = mount();
  assert.equal(frame.posted.length, 0, "nothing before the view is ready");
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  const methods = frame.posted.map((m) => m.method);
  assert.deepEqual(methods, ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  assert.deepEqual(frame.posted[0].params, { arguments: { period: "week" } });
  assert.equal(frame.posted[1].params.structuredContent.speech, "Mostly okay.");
});

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

test("without callTool, tools/call is refused", async () => {
  const { frame } = mount();
  fromView(frame, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } });
  await settle();
  assert.equal(frame.posted.at(-1).error.code, -32601);
});

test("size-changed resizes the iframe, capped at maxHeight", () => {
  const { frame } = mount({ maxHeight: 300 });
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 220.4 } });
  assert.equal(frame.style.height, "221px");
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 900 } });
  assert.equal(frame.style.height, "300px");
});

test("ui/message hands the text to the chat", async () => {
  const said = [];
  const { frame } = mount({ onMessage: (t) => said.push(t) });
  fromView(frame, { jsonrpc: "2.0", id: 10, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Prepare a visit brief" }] } });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(said, ["Prepare a visit brief"]);
  assert.deepEqual(frame.posted.at(-1), { jsonrpc: "2.0", id: 10, result: {} });
});

test("unknown requests get -32601 and pings get {}", () => {
  const { frame } = mount();
  fromView(frame, { jsonrpc: "2.0", id: 11, method: "ui/does-not-exist" });
  assert.equal(frame.posted.at(-1).error.code, -32601);
  fromView(frame, { jsonrpc: "2.0", id: 12, method: "ping" });
  assert.deepEqual(frame.posted.at(-1), { jsonrpc: "2.0", id: 12, result: {} });
});

test("ignores messages from other windows and non-JSON-RPC data", () => {
  const { frame } = mount();
  listeners.forEach((fn) => fn({ source: {}, data: { jsonrpc: "2.0", id: 1, method: "ui/initialize" } }));
  fromView(frame, "hello");
  fromView(frame, { id: 2, method: "ui/initialize" });
  assert.equal(frame.posted.length, 0);
});

test("updateResult pushes a fresh result to a ready view; unmount tears down", () => {
  const { host, frame } = mount();
  host.updateResult({ content: [], structuredContent: { speech: "too early" } });
  assert.equal(frame.posted.length, 0, "not before initialized");
  fromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  host.updateResult({ content: [], structuredContent: { speech: "Updated." } });
  assert.equal(frame.posted.at(-1).params.structuredContent.speech, "Updated.");
  host.unmount("closed");
  const teardown = frame.posted.find((m) => m.method === "ui/resource-teardown");
  assert.equal(teardown.params.reason, "closed");
  assert.equal(frame.removed, true);
});

test("logs every message in both directions", () => {
  const log = [];
  const { frame } = mount({ onLog: (e) => log.push(e.dir) });
  fromView(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
  assert.deepEqual(log, ["view->host", "host->view"]);
});

test("requires a container", () => {
  assert.throws(() => new McpAppHost({ html: "" }), /container is required/);
});
