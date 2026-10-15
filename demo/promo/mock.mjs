// Serves the built dashboard (web/dist) as a fallback origin for demo/privacy.mjs, which answers /api/* from the
// masked response cache. Read-only: every non-GET returns 403.
//   node mock.mjs [port]   (default 8799)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../../web/dist");
const port = Number(process.argv[2] || 8799);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

http.createServer((req, res) => {
  if (req.method !== "GET") { res.writeHead(403).end("{}"); return; }
  // The cache holds RAW data; masking happens in privacy.mjs (browser route). Never serve it directly.
  if (req.url.startsWith("/api/")) { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
  let p = decodeURIComponent(req.url.split("?")[0]);
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }).end(fs.readFileSync(f));
}).listen(port, "127.0.0.1", () => console.log("mock dashboard on http://127.0.0.1:" + port));
