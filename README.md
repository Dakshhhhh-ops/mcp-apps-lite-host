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

## Not included (yet)
- The double-iframe sandbox proxy for hosting views on a separate origin.
- CSP enforcement from `_meta.ui.csp` (set it on the page or proxy that serves the iframe).
- `ui/open-link`, display-mode changes and `ui/update-model-context` (they return "not supported").

## License
MIT
