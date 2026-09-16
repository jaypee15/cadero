// packages/mobile/tests/e2e/static-server.mjs
// Minimal static server for the Next.js export (SPA fallback to index.html).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const root = process.argv[2];
const port = Number(process.argv[3]);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = join(root, decodeURIComponent(url.pathname));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    try {
      // Directory-style routes resolve to their .html export (e.g. /app →
      // app.html), mirroring the nginx try_files chain in production.
      const body = await readFile(`${path}.html`);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    } catch {
      const body = await readFile(join(root, "index.html"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    }
  }
}).listen(port, "127.0.0.1", () => console.log(`static on ${port}`));
