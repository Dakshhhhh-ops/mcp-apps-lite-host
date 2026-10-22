# mcp-apps-lite-host

Render [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) views in any web page with one small, dependency-free ES module.

MCP Apps lets an MCP tool point at an interactive `ui://` HTML view (`_meta.ui.resourceUri`). Hosts like chat clients render that view in a sandboxed iframe and talk to it over JSON-RPC via `postMessage`. This library is that host side, so a custom web app, simulator or dashboard can show MCP Apps views without pulling in a framework.

It was extracted from [Nova](https://github.com/Dakshhhhh-ops/nova), a care-circle MCP server for Alexa+, where it renders views on simulated Echo Show screens.

## Features
- Implements the View ↔ Host handshake from ext-apps spec `2026-01-26`: `ui/initialize` → `ui/notifications/initialized` → `ui/notifications/tool-input` → `ui/notifications/tool-result`.
- Proxies view-initiated `tools/call` to your MCP client (`callTool`).
- Forwards `ui/message` text to your chat (`onMessage`).
- Auto-resizes on `ui/notifications/size-changed` (with an optional cap).
- Sends `ui/resource-teardown` on unmount.
- Sandboxed iframe (`allow-scripts` only, no same-origin) and a protocol log hook (`onLog`) for inspectors.
- About 200 lines, no dependencies, no build step.

## Use

```js
import { McpAppHost } from "./mcp-apps-host.js";

// 1. Your MCP client called a tool whose definition has _meta.ui.resourceUri
const result = await client.callTool({ name: "care_briefing", arguments: {} });
const html = (await client.readResource({ uri: tool._meta.ui.resourceUri })).contents[0].text;

// 2. Render it
const host = new McpAppHost({
  container: document.querySelector("#card"),
  html,
  tool,                                   // the Tool definition
  toolInput: {},                          // arguments you called it with
  toolResult: result,                     // the CallToolResult
  callTool: (name, args) => client.callTool({ name, arguments: args }),
  onMessage: (text) => chat.send(text),
  onLog: (e) => console.debug(e.dir, e.msg),
  maxHeight: 600,
}).mount();

// later
host.updateResult(newResult);
host.unmount();
```

Open `example/index.html` through any static server (for example `npx serve .`) to see a view call a tool through the host.

## API

`new McpAppHost(options).mount()` returns the host. Options:

| Option | Type | Purpose |
|---|---|---|
| `container` | `HTMLElement` | **Required.** Where the iframe is mounted. |
| `html` | `string` | The `ui://` resource text (from `resources/read`). |
| `tool` | `object` | The MCP `Tool` definition; sent as `hostContext.toolInfo`. |
| `toolInput` | `object` | Arguments the tool was called with (`ui/notifications/tool-input`). |
| `toolResult` | `object` | The `CallToolResult` (`ui/notifications/tool-result`). |
| `callTool(name, args)` | `async fn` | Proxy for view-initiated `tools/call`. Omit to refuse tool calls. |
| `onMessage(text)` | `fn` | Receives `ui/message` text (e.g. a button that asks the assistant something). |
| `onLog({dir, msg})` | `fn` | Every message in both directions, for inspectors and debugging. |
| `hostInfo` | `{name, version}` | Sent in the `ui/initialize` result. |
| `hostContext` | `object` | Merged over the defaults (theme, locale, timeZone, displayMode, containerDimensions). |
| `maxHeight` | `number` | Cap for `size-changed` resizing, in px. |

Methods: `mount()`, `updateResult(result)` (push a new result to a ready view), `unmount(reason)` (sends `ui/resource-teardown`, removes the iframe).

## Protocol coverage (ext-apps 2026-01-26)

| Message | Direction | Supported |
|---|---|---|
| `ui/initialize` → result with `protocolVersion`, `hostCapabilities`, `hostInfo`, `hostContext` | view → host | yes |
| `ui/notifications/initialized` | view → host | yes (the host sends nothing before it) |
| `ui/notifications/tool-input`, `ui/notifications/tool-result` | host → view | yes (once each, in order) |
| `tools/call` | view → host | yes (via `callTool`), JSON-RPC errors on failure |
| `ui/message` | view → host | yes (via `onMessage`) |
| `ui/notifications/size-changed` | view → host | yes (with `maxHeight` cap) |
| `ui/resource-teardown` | host → view | yes (on `unmount`) |
| `ping` | view → host | yes |
| `notifications/message` (logging) | view → host | passed to `onLog` |
| `ui/open-link`, `ui/request-display-mode`, `ui/update-model-context` | view → host | refused with an error (not yet) |

## Security notes
- The view runs in an iframe with `sandbox="allow-scripts"` and **no** `allow-same-origin`, so it can't read the host page, its cookies or storage.
- Only messages whose `event.source` is that iframe's window are handled; everything else is ignored.
- Tool calls go through your `callTool`, so you decide which tools a view may call (for example, only tools whose `_meta.ui.visibility` includes `"app"`).
- `_meta.ui.csp` isn't enforced by this library. If you render views from servers you don't trust, serve them from a separate origin with a CSP that matches the declared domains.

## Testing
```bash
npm test      # node --test, no dependencies
```
The tests drive the full handshake, tool proxying, errors, resizing, messages, teardown and the source check against a minimal fake DOM.

## Not included (yet)
- The double-iframe sandbox proxy for hosting views on a separate origin.
- CSP enforcement from `_meta.ui.csp` (set it on the page or proxy that serves the iframe).
- `ui/open-link`, display-mode changes and `ui/update-model-context` (they return "not supported").

## License
MIT
