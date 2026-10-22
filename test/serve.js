// A tiny static server for the examples and browser tests.
// Serves the repo root with CORS, plus /api/ok for CSP connect tests.
// The same port answers on 127.0.0.1 (host page) and localhost (sandbox origin): two origins, one server.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css" };

export function serve(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/api/ok") {
      res.setHeader("Content-Type", "application/json");
      return res.end('{"ok":true}');
    }
    const path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      const body = await readFile(path.endsWith("\\") || path.endsWith("/") ? join(path, "index.html") : path);
      res.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await serve(Number(process.env.PORT) || 8099);
  const { port } = server.address();
  console.log(`Inline example:   http://127.0.0.1:${port}/example/index.html`);
  console.log(`Proxy example:    http://127.0.0.1:${port}/example/proxy.html  (sandbox served from http://localhost:${port})`);
}
