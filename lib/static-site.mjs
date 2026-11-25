/**
 * The shipped page and its assets, served from public/ with the same headers as the API.
 *
 * The page is the one place a client learns the run's token: index.html is rewritten on the
 * way out to carry it in a <meta> tag. Nothing else is injected, and a path that resolves
 * outside public/ is refused instead of being read.
 */
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative } from "node:path";

import { securityHeaders, sendText } from "./http.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

export async function serveStatic(res, urlPath, { publicDir, token }) {
  const rel = normalize(urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, ""));
  if (rel.includes("..") || isAbsolute(rel)) return sendText(res, 403, "Forbidden");
  const file = join(publicDir, rel);
  // The joined path must still sit under public/. The check above refuses dot segments; this
  // refuses anything the platform might interpret differently (a drive, a UNC share).
  const back = relative(publicDir, file);
  if (back.startsWith("..") || isAbsolute(back)) return sendText(res, 403, "Forbidden");
  try {
    const data = await readFile(file);
    if (rel === "index.html") {
      // The page learns the token here and nowhere else; nothing else is injected.
      const html = data.toString("utf8");
      const tagged = html.includes("</head>")
        ? html.replace("</head>", `    <meta name="pinglab-token" content="${token}" />\n  </head>`)
        : html;
      res.writeHead(200, securityHeaders(MIME[".html"]));
      res.end(tagged);
      return;
    }
    res.writeHead(200, securityHeaders(MIME[extname(file).toLowerCase()] || "application/octet-stream"));
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}
