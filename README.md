# mcp-apps-lite-host

Render [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) views in any web page with one dependency-free ES module, including the security rules the spec asks hosts to enforce.

MCP Apps lets an MCP tool point at an interactive `ui://` HTML view (`_meta.ui.resourceUri`). A host renders that view in a sandboxed iframe and talks to it over JSON-RPC via `postMessage`. This library is the host side, so a custom web app, simulator, inspector or dashboard can show MCP Apps views without a framework or a build step.

**Tested against the official view SDK.** The browser tests run views built with `@modelcontextprotocol/ext-apps` (`App`) in real Chromium, through both isolation modes.

It was extracted from [Nova](https://github.com/Dakshhhhh-ops/nova), a care-circle MCP server for Alexa+, where it renders views on simulated Echo Show screens.

## Why
The official `AppBridge` (in `@modelcontextprotocol/ext-apps/app-bridge`) is the full-featured host SDK. It needs `@modelcontextprotocol/client`, `@modelcontextprotocol/core`, `zod` and a bundler, and its reference host uses React, Vite and an Express server to set the sandbox CSP header.

This library is for when you want to drop a view into a page with a `<script type="module">`:

| | `mcp-apps-lite-host` | official `AppBridge` |
|---|---|---|
| Dependencies | none | MCP client + core SDKs, zod |
| Build step | none (one ES module) | bundler |
| CSP from `_meta.ui.csp` | built in (meta tag, both modes) | you set it on your sandbox server |
| Sandbox proxy | static `sandbox-proxy.html`, no server code | example proxy + Express |
| Talks to your MCP client | through callbacks you pass | through an MCP `Client` |

## Features
- The full view ↔ host protocol from ext-apps spec `2026-01-26` (see the coverage table below).
- **CSP enforcement** from `_meta.ui.csp`: the spec's restrictive default when it's omitted, only declared origins otherwise, with injection-safe domain filtering.
- **Permissions** from `_meta.ui.permissions` as a correct iframe `allow` attribute (`camera; microphone; ...`).
- **Tool visibility**: pass your `tools/list` and views can only call tools whose `_meta.ui.visibility` includes `"app"`.
- **Two isolation modes**: an opaque-origin srcdoc iframe (default), or the spec's double-iframe **sandbox proxy** on a second origin for web hosts.
- Teardown that waits for the view to answer, partial tool input streaming, cancellation, host-context updates, display modes, model-context updates.
- A protocol log hook (`onLog`) for inspectors.

## Use

```js
import { McpAppHost } from "./mcp-apps-host.js";

// 1. Your MCP client called a tool whose definition has _meta.ui.resourceUri
const result = await client.callTool({ name: "care_briefing", arguments: {} });
const resource = (await client.readResource({ uri: tool._meta.ui.resourceUri })).contents[0];

// 2. Render it
const host = new McpAppHost({
  container: document.querySelector("#card"),
  resource,                                // html + _meta.ui.csp / permissions
  tool,                                    // the Tool definition
  tools,                                   // optional: tools/list, to enforce visibility
  toolInput: {},                           // arguments you called it with
  toolResult: result,                      // the CallToolResult
  callTool: (name, args) => client.callTool({ name, arguments: args }),
  readResource: (uri) => client.readResource({ uri }),
  onMessage: (text) => chat.send(text),
  onOpenLink: (url) => window.open(url, "_blank", "noopener"),
  onLog: (e) => console.debug(e.dir, e.msg),
  maxHeight: 600,
}).mount();

// later
host.setToolResult(newResult);
await host.unmount();                      // sends ui/resource-teardown and waits for the view
```

### Sandbox proxy (web hosts)
The spec says a web host MUST put the view behind a sandbox proxy on a different origin. Deploy `sandbox-proxy.html` **and** `mcp-apps-host.js` together on a second origin (say `https://sandbox.example.com`), add your app's origin to `ALLOWED_HOSTS` at the top of the proxy, then:

```js
new McpAppHost({ container, resource, sandboxProxy: "https://sandbox.example.com/sandbox-proxy.html", ... }).mount();
```

The proxy checks who embeds it, relays messages in both directions (never the reserved `ui/notifications/sandbox-*` ones), loads the view with its CSP and `allow` attribute, and applies the same CSP to its own page so a same-origin view can't use the proxy to get around it. The view gets a real origin (the sandbox's), so it can use storage.

### Examples
```bash
npm run example
```
- `http://127.0.0.1:8099/example/index.html`: inline mode, a view calling a tool through the host.
- `http://127.0.0.1:8099/example/proxy.html`: the same view through the sandbox proxy, served from `http://localhost:8099`.

## API

`new McpAppHost(options).mount()` returns the host. Options:

| Option | Type | Purpose |
|---|---|---|
| `container` | `HTMLElement` | **Required.** Where the iframe is mounted. |
| `resource` | `object` | A `resources/read` content item: `text` or base64 `blob`, plus `_meta.ui.csp` and `_meta.ui.permissions`. |
| `html` | `string` | The view HTML, if you don't pass `resource`. |
| `csp`, `permissions` | `object` | Override what `resource._meta.ui` declares. |
| `policy` | `string` | Use this exact CSP instead of the one built from `csp` (inline mode). |
| `sandboxProxy` | `string` | URL of `sandbox-proxy.html` on another origin. |
| `sandbox` | `string` | The view iframe's `sandbox` attribute, if you need a different one. |
| `tool` | `object` | The MCP `Tool` definition; sent as `hostContext.toolInfo`. |
| `tools` | `Tool[]` | Your `tools/list`. Views may then only call listed tools visible to `"app"`. |
| `toolInput`, `toolResult` | `object` | Sent after the view is initialized, input first. |
| `callTool(name, args)` | `async fn` | Proxy for view-initiated `tools/call`. Omit to refuse tool calls. |
| `readResource(uri)`, `listResources(params)` | `async fn` | Proxies for `resources/read` and `resources/list`. |
| `onMessage(text, params)` | `fn` | `ui/message` from the view. |
| `onOpenLink(url)` | `fn` | `ui/open-link` (http, https and mailto only). Return `false` to deny. |
| `onModelContext(ctx)` | `fn` | `ui/update-model-context`; the latest is also on `host.modelContext`. |
| `onDisplayModeRequest(mode)` | `fn` | Return the mode you actually switched to. |
| `onSizeChange({width, height})` | `fn` | After the iframe is resized. |
| `onRequestTeardown()` | `fn` | The view asked to be closed (draft spec). |
| `onLog({dir, msg})` | `fn` | Every message in both directions. |
| `availableDisplayModes` | `string[]` | Modes the host supports. Default `["inline"]`. |
| `theme`, `hostInfo`, `hostContext` | | Sent in the `ui/initialize` result. |
| `maxHeight` | `number` | Cap for `size-changed`, in px. |
| `teardownTimeout` | `number` | How long `unmount()` waits for the view. Default 1000 ms. |

Methods: `mount()`, `setToolInputPartial(args)`, `setToolInput(args)`, `setToolResult(result)` (alias `updateResult`), `cancel(reason)`, `setHostContext(partial)`, `unmount(reason)` (async), `destroy()`.

Helpers: `buildCsp(csp, {inline})`, `buildAllow(permissions)`, `injectCsp(html, policy)`, `sanitizeDomains(list)`, `resourceHtml(resource)`.

## Protocol coverage (ext-apps 2026-01-26)

| Message | Direction | Supported |
|---|---|---|
| `ui/initialize` → `protocolVersion`, `hostCapabilities`, `hostInfo`, `hostContext` | view → host | yes; capabilities match the handlers you pass |
| `ui/notifications/initialized` | view → host | yes; the host sends nothing to the view before it |
| `ui/notifications/tool-input-partial`, `tool-input`, `tool-result`, `tool-cancelled` | host → view | yes; input once, before the result |
| `ui/notifications/host-context-changed` | host → view | yes (`setHostContext`, display mode changes) |
| `ui/resource-teardown` | host → view | yes; `unmount()` waits for the reply |
| `tools/call` | view → host | yes, with visibility checks when `tools` is given |
| `resources/read`, `resources/list` | view → host | yes |
| `ui/message`, `ui/open-link` | view → host | yes |
| `ui/request-display-mode` | view → host | yes; only modes both sides declared |
| `ui/update-model-context` | view → host | yes |
| `ui/notifications/size-changed` | view → host | yes (with `maxHeight` cap) |
| `ping`, `notifications/message` | view → host | yes / passed to `onLog` |
| `ui/notifications/sandbox-proxy-ready`, `sandbox-resource-ready` | proxy ↔ host | yes (`sandbox-proxy.html`) |
| `ui/notifications/request-teardown` (draft) | view → host | passed to `onRequestTeardown` |
| `ui/download-file`, `sampling/createMessage` (draft) | view → host | refused with -32601 |

## Security notes
- **Inline mode**: `sandbox="allow-scripts"` with no `allow-same-origin`, so the view has an opaque origin and can't read the host page, its cookies or storage. The CSP is injected as the first thing in the view's HTML, so nothing the view contains runs before it. `'self'` is left out on purpose: in a srcdoc iframe it would mean the host page's origin (a browser test caught this). The view also inherits your page's own CSP, if it has one.
- **Proxy mode**: the proxy only accepts embedding from `ALLOWED_HOSTS`, only relays messages from its parent (checked by origin) and its own view, and applies the view's CSP to itself as well. A browser test checks that a view running code inside the proxy page still can't reach an undeclared origin.
- Only messages whose `event.source` is the host's own iframe (and, in proxy mode, whose origin is the proxy's) are handled.
- CSP domain entries containing `;`, `,`, quotes, whitespace or angle brackets are dropped, so a server can't inject directives or keywords like `'unsafe-eval'`.
- Like any CSP-based sandbox, this doesn't stop a view from navigating itself to another page. Treat what you send a view as visible to its server.

## Spec note
The spec's security section builds the `allow` attribute with `allowList.join(' ')`. Permissions Policy separates features with `;`, so `allow="camera microphone"` doesn't grant both (a browser test here shows it). This library and the official `AppBridge` both use `"; "`.

## Testing
```bash
npm install
npx playwright install chromium   # once
npm test                          # unit + browser
npm run test:unit                 # 35 tests, no dependencies, fake DOM
npm run test:browser              # 6 tests in Chromium
```
- **Unit**: the handshake and ordering rules, every request and notification, errors, visibility, the source and origin checks, proxy mode, teardown, the CSP and `allow` builders.
- **Browser**: an official SDK view end to end in both modes (tool input and result, `callServerTool`, `readServerResource`, `sendMessage`, `openLink`, `requestDisplayMode`, `updateModelContext`, auto-resize, `onteardown`); CSP blocking undeclared origins, and blocking the SDK itself when its CDN isn't declared; the `allow` attribute in Chromium; the proxy's lockdown.

## License
MIT
