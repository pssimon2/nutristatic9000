// Minimal static server with HTTP Range support, serving a directory under a
// path prefix.
//
// `vite preview` serves at the site root, but this fork is deployed under
// /9000/, and several things only break there: relative asset bases, the
// service worker's scope, the manifest's relative URLs, and the paths the page
// resolves for the side datasets. So the browser suite runs against this
// instead. Range support matters too — the index reader uses it, and Python's
// http.server has none.
//
// usage: node scripts/serve-subpath.mjs <root-dir> <prefix> <port>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const prefix = process.argv[3] || "/9000/";
const port = +(process.argv[4] || 4600);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/vnd.microsoft.icon",
  ".txt": "text/plain; charset=utf-8",
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!p.startsWith(prefix)) {
      res.writeHead(404).end("outside prefix");
      return;
    }
    let rel = p.slice(prefix.length) || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    const size = fs.statSync(file).size;
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? +m[1] : 0;
      const end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Length": size,
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`serving ${root} at http://localhost:${port}${prefix}`));
