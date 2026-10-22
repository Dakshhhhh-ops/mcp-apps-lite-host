# Changelog

## 0.2.0
- CSP from `_meta.ui.csp` (restrictive default, declared origins only, injection-safe filtering), injected before anything in the view. `'self'` is dropped in inline mode, where it would mean the host page.
- Permissions from `_meta.ui.permissions` as a `;`-separated iframe `allow` attribute.
- Sandbox proxy mode for web hosts (`sandboxProxy` + static `sandbox-proxy.html`), with origin checks and the view's CSP applied to the proxy page too.
- Tool visibility: with `tools`, views can only call tools visible to `"app"`.
- New messages: `tool-input-partial`, `tool-cancelled`, `host-context-changed`, `resources/read`, `resources/list`, `ui/open-link`, `ui/request-display-mode`, `ui/update-model-context`, draft `request-teardown`.
- `unmount()` is async and waits for the view's teardown reply; `destroy()` removes right away.
- `resource` option: pass a `resources/read` content item (text or base64 blob) directly.
- Browser tests against the official `@modelcontextprotocol/ext-apps` view SDK in Chromium.

## 0.1.0
- First release: handshake, tool input and result, `tools/call`, `ui/message`, `size-changed`, teardown.
