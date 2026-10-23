# Contributing

Thanks for helping. This library stays small on purpose: one dependency-free ES module that a page can load with a `<script type="module">`.

## Ground rules
- **No runtime dependencies.** Dev dependencies for tests are fine.
- **Follow the spec.** Behaviour should match the MCP Apps (ext-apps) specification. If the spec is unclear or wrong, open an issue here and link the upstream discussion.
- **Security first.** Changes to the sandbox, CSP, `allow` attribute, origin checks or tool visibility need a test that shows the attack being blocked.

## Running the tests
```bash
npm install
npx playwright install chromium   # once
npm test                          # unit + browser
```
Unit tests run on Node 18, 20 and 22 with a fake DOM. Browser tests run official SDK views in Chromium.

## Pull requests
1. One change per pull request, with a test.
2. Update `CHANGELOG.md` under an "Unreleased" heading.
3. Describe what changes for host authors, and link the spec section it follows.
