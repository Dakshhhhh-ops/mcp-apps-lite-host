// Browser tests: real Chromium, the official MCP Apps view SDK (@modelcontextprotocol/ext-apps),
// CSP and Permissions Policy enforcement, and the double-iframe sandbox proxy across two origins.
// Run: npm run test:browser   (needs `npx playwright install chromium` once)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { serve } from "./serve.js";

let server, browser, HOST, SANDBOX;

before(async () => {
  server = await serve(0);
  const { port } = server.address();
  HOST = `http://127.0.0.1:${port}`; // the host page's origin
  SANDBOX = `http://localhost:${port}`; // a second origin: SDK files, the sandbox proxy, an "API"
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

const SDK = () => `${SANDBOX}/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js`;

// A view written with the official SDK. It records what it sees in window.log.
const sdkView = () => `<!doctype html><html><body style="margin:0"><div id="out" style="height:150px">view</div>
<script type="module">
window.isView = true; window.log = {};
const put = (k, v) => { window.log[k] = v; };
try {
  const { App } = await import(${JSON.stringify(SDK())});
  const app = new App({ name: "conformance-view", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
  app.ontoolinput = (p) => put("toolInput", p);
  app.ontoolresult = (r) => put("toolResult", r);
  app.onhostcontextchanged = (c) => put("contextChanged", c);
  app.onteardown = async (p) => { put("teardown", p); return {}; };
  await app.connect();
  put("hostVersion", app.getHostVersion());
  put("hostCapabilities", app.getHostCapabilities());
  put("hostContext", app.getHostContext());
  put("call", await app.callServerTool({ name: "get_today", arguments: { day: "today" } }));
  put("read", await app.readServerResource({ uri: "nova://circle" }));
  put("message", await app.sendMessage({ role: "user", content: [{ type: "text", text: "hello from the view" }] }));
  put("link", await app.openLink({ url: "https://example.com/docs" }));
  put("mode", await app.requestDisplayMode({ mode: "fullscreen" }));
  put("context", await app.updateModelContext({ structuredContent: { step: 2 } }));
  document.getElementById("out").style.height = "333px"; // autoResize reports this
  put("origin", self.origin);
  try { localStorage.setItem("k", "v"); put("storage", localStorage.getItem("k")); } catch (e) { put("storage", "blocked"); }
  put("done", true);
} catch (e) { put("error", String(e && e.stack || e)); }
</script></body></html>`;

const netView = (declared, undeclared) => `<!doctype html><body><script>
window.isView = true; window.log = {};
const probe = (url, w) => w.fetch(url).then(r => r.json()).then(() => "ok", () => "blocked");
(async () => {
  window.log.declared = await probe(${JSON.stringify(declared)}, window);
  window.log.undeclared = await probe(${JSON.stringify(undeclared)}, window);
  let viaParent = "no-access";
  try {
    // A same-origin view could run code in the proxy page. The proxy applies the view's CSP to itself too.
    const s = parent.document.createElement("script");
    s.textContent = "fetch(" + JSON.stringify(${JSON.stringify(undeclared)}) + ").then(() => window.__leak = 'ok', () => window.__leak = 'blocked')";
    parent.document.body.appendChild(s);
    await new Promise(r => setTimeout(r, 400));
    viaParent = parent.__leak || "script blocked";
  } catch (e) { viaParent = "no-access"; }
  window.log.viaParent = viaParent;
  window.log.done = true;
})();
</script></body>`;

async function viewFrame(page) {
  for (let i = 0; i < 100; i++) {
    for (const f of page.frames()) {
      try {
        if (await f.evaluate(() => window.isView === true && window.log?.done === true || !!window.log?.error)) return f;
      } catch { /* frame not ready */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("view never finished");
}

async function openHost() {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${HOST}/test/fixtures/host.html`);
  await page.waitForFunction(() => typeof window.render === "function");
  return { page, errors };
}

async function runSdkView(extra) {
  const { page } = await openHost();
  await page.evaluate(({ html, extra }) => window.render({
    html,
    tool: { name: "get_today", inputSchema: { type: "object" } },
    toolInput: { day: "today" },
    toolResult: { content: [{ type: "text", text: "3 doses today" }], structuredContent: { doses: 3 } },
    ...extra,
  }), { html: sdkView(), extra });
  const frame = await viewFrame(page);
  const log = await frame.evaluate(() => window.log);
  return { page, frame, log };
}

function checkSdkLog(log) {
  assert.equal(log.error, undefined, log.error);
  assert.equal(log.hostVersion.name, "mcp-apps-lite-host");
  assert.deepEqual(log.toolInput, { arguments: { day: "today" } });
  assert.deepEqual(log.toolResult.structuredContent, { doses: 3 });
  assert.equal(log.hostContext.toolInfo.tool.name, "get_today");
  assert.ok(log.hostCapabilities.serverTools && log.hostCapabilities.openLinks && log.hostCapabilities.message);
  assert.deepEqual(log.call.structuredContent, { name: "get_today", args: { day: "today" } });
  assert.equal(log.read.contents[0].text, "resource body");
  assert.deepEqual(log.mode, { mode: "fullscreen" });
  assert.deepEqual(log.contextChanged?.displayMode, "fullscreen");
}

test("inline mode works with the official MCP Apps view SDK end to end", async () => {
  const { page, log } = await runSdkView({ csp: { resourceDomains: [SANDBOX] } });
  checkSdkLog(log);
  assert.equal(log.origin, "null", "inline views get an opaque origin");
  const events = await page.evaluate(() => window.events);
  assert.ok(events.some((e) => e.type === "message" && e.value === "hello from the view"));
  assert.ok(events.some((e) => e.type === "open-link" && e.value === "https://example.com/docs"));
  assert.ok(events.some((e) => e.type === "model-context" && e.value.structuredContent.step === 2));
  await page.waitForFunction(() => window.events.some((e) => e.type === "size" && e.value.height >= 333));
  assert.ok(parseInt(await page.evaluate(() => document.querySelector("iframe").style.height), 10) >= 333);
  // Teardown: the SDK's onteardown runs and its reply lets unmount finish.
  const frame = await viewFrame(page);
  const answered = await page.evaluate(() => window.unmountView());
  assert.equal(answered, true);
  void frame;
  await page.close();
});

test("without a declared resource domain the SDK can't even load (CSP blocks it)", async () => {
  const { page } = await openHost();
  await page.evaluate(({ html }) => window.render({ html }), { html: sdkView() });
  const frame = await viewFrame(page);
  const log = await frame.evaluate(() => window.log);
  assert.match(log.error, /fetch|import|module|Failed/i);
  await page.close();
});

test("CSP: declared connectDomains are reachable, undeclared origins are blocked", async () => {
  const { page } = await openHost();
  const declared = `${SANDBOX}/api/ok`;
  const undeclared = `${HOST}/api/ok`;
  await page.evaluate(({ html, d }) => window.render({ html, csp: { connectDomains: [d] } }), { html: netView(declared, undeclared), d: SANDBOX });
  const log = await (await viewFrame(page)).evaluate(() => window.log);
  assert.equal(log.declared, "ok");
  assert.equal(log.undeclared, "blocked");
  assert.equal(log.viaParent, "no-access", "an inline view can't touch the host page");

  const strict = await openHost();
  await strict.page.evaluate(({ html }) => window.render({ html }), { html: netView(declared, undeclared) });
  const log2 = await (await viewFrame(strict.page)).evaluate(() => window.log);
  assert.equal(log2.declared, "blocked", "no csp metadata: connect-src 'none'");
  await page.close();
  await strict.page.close();
});

test("permissions become a working allow attribute; the spec's space-separated example grants nothing", async () => {
  const { page } = await openHost();
  await page.evaluate(() => window.render({ html: "<p>x</p>", permissions: { camera: {}, microphone: {} } }));
  const result = await page.evaluate(() => {
    const ours = document.querySelector("iframe");
    const spaced = document.createElement("iframe");
    spaced.setAttribute("allow", "camera microphone"); // allowList.join(' ') from the spec's security section
    document.body.appendChild(spaced);
    return {
      attr: ours.getAttribute("allow"),
      ours: ["camera", "microphone"].map((f) => ours.featurePolicy.allowsFeature(f)),
      spaced: ["camera", "microphone"].map((f) => spaced.featurePolicy.allowsFeature(f)),
    };
  });
  assert.equal(result.attr, "camera; microphone");
  assert.deepEqual(result.ours, [true, true]);
  assert.notDeepEqual(result.spaced, [true, true], "space-separated features don't all get delegated");
  await page.close();
});

test("sandbox proxy on a second origin: the official SDK works through it and the view gets its own origin", async () => {
  const { page, log } = await runSdkView({ sandboxProxy: `${SANDBOX}/sandbox-proxy.html`, csp: { resourceDomains: [SANDBOX] } });
  checkSdkLog(log);
  assert.equal(log.origin, SANDBOX, "the view lives on the sandbox origin");
  assert.equal(log.storage, "v", "and can use storage there");
  const answered = await page.evaluate(() => window.unmountView());
  assert.equal(answered, true);
  await page.close();
});

test("sandbox proxy enforces the view's CSP, even when the view runs code in the proxy page", async () => {
  const { page } = await openHost();
  const api = `${HOST}/api/ok`; // undeclared
  await page.evaluate(({ html, proxy }) => window.render({ html, sandboxProxy: proxy, csp: { connectDomains: [] } }),
    { html: netView(`${SANDBOX}/api/ok`, api), proxy: `${SANDBOX}/sandbox-proxy.html` });
  const log = await (await viewFrame(page)).evaluate(() => window.log);
  assert.equal(log.declared, "ok", "'self' is the sandbox origin in proxy mode");
  assert.equal(log.undeclared, "blocked");
  assert.notEqual(log.viaParent, "ok", "the proxy page is locked down too");
  await page.close();
});
