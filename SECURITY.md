# Security policy

`mcp-apps-lite-host` renders untrusted HTML from MCP servers, so isolation bugs matter.

## Reporting a vulnerability
Please don't open a public issue. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on this repository) with:
- what an attacker controls (the view HTML, `_meta.ui`, messages from the view, the server);
- what they can reach (the host page, other origins, tools the view shouldn't call);
- a minimal view or test that reproduces it.

You'll get a reply within a few days, and a fix and an advisory once it's confirmed.

## What's in scope
- Escaping the sandboxed iframe or the sandbox proxy, or reaching the host page's origin.
- Bypassing the CSP built from `_meta.ui.csp`, or the `allow` attribute built from `_meta.ui.permissions`.
- Calling tools that aren't visible to `"app"`, or messages accepted from the wrong window or origin.
