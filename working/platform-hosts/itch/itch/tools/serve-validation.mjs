import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const itchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(itchRoot, "..");
const candidateRoot = path.join(repoRoot, "local_artifacts", "itch-html5", "dist");
const host = process.env.LIFELINE_VALIDATION_HOST ?? "127.0.0.1";
const port = Number(process.env.LIFELINE_VALIDATION_PORT ?? 8876);
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".f32", "application/octet-stream"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tex", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff2", "font/woff2"],
]);

function candidatePath(pathname) {
  const relative = decodeURIComponent(pathname.slice("/candidate/".length));
  const requested = path.resolve(candidateRoot, relative || "index.html");
  if (requested !== candidateRoot && !requested.startsWith(`${candidateRoot}${path.sep}`)) return null;
  return requested;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  let target = null;
  if (url.pathname === "/iframe/") target = path.join(itchRoot, "tests", "iframe-harness.html");
  else if (url.pathname === "/storage-denied/") target = path.join(itchRoot, "tests", "storage-denied-harness.html");
  else if (url.pathname.startsWith("/candidate/")) target = candidatePath(url.pathname);
  if (!target) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-length": metadata.size,
      "content-type": mimeTypes.get(path.extname(target).toLowerCase()) ?? "application/octet-stream",
      "cross-origin-resource-policy": "cross-origin",
    });
    createReadStream(target).pipe(response);
  } catch (_error) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    status: "LIFELINE_ITCH_VALIDATION_SERVER_READY",
    candidate: `http://${host}:${port}/candidate/`,
    iframe: `http://${host}:${port}/iframe/`,
    storage_denied: `http://${host}:${port}/storage-denied/`,
  }));
});
