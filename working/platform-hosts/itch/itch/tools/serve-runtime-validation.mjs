import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { generateMultiplayerBrowserFixtures } from "./multiplayer-browser-fixtures.mjs";

const itchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(itchRoot, "..");
const frontendRoot = resolve(repoRoot, "web", "web前端");
const reportRoot = resolve(repoRoot, "local_artifacts", "itch-html5", "browser-runtime");
const fixtureFile = process.env.LIFELINE_MULTIPLAYER_FIXTURES
  ? resolve(process.env.LIFELINE_MULTIPLAYER_FIXTURES)
  : null;
let fixtureBytesPromise;
const loadFixtureBytes = () => {
  fixtureBytesPromise ??= fixtureFile
    ? readFile(fixtureFile)
    : Promise.resolve(Buffer.from(JSON.stringify(generateMultiplayerBrowserFixtures())));
  return fixtureBytesPromise;
};
const port = Number(process.env.LIFELINE_RUNTIME_VALIDATION_PORT ?? 8783);
const types = {
  ".css": "text/css; charset=utf-8",
  ".f32": "application/octet-stream",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid validation port");
await mkdir(reportRoot, { recursive: true });

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (request.method === "POST" && pathname === "/__multiplayer/report") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 5e6) throw new Error("Oversized report");
      }
      const data = JSON.parse(body);
      if (data.schema !== "lifeline-multiplayer-browser-v1") throw new Error("Invalid receipt");
      await writeFile(resolve(reportRoot, `report-${Date.now()}.json`), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"saved":true}');
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end();
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const file = resolve(frontendRoot, `.${pathname === "/" ? "/tests/multiplayer-browser.html" : pathname}`);
    if (pathname !== "/__multiplayer/fixtures" && !file.startsWith(`${frontendRoot}${sep}`)) throw new Error("Invalid path");
    const bytes = pathname === "/__multiplayer/fixtures" ? await loadFixtureBytes() : await readFile(file);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": pathname === "/__multiplayer/fixtures"
        ? "application/json"
        : types[extname(file)] ?? "application/octet-stream",
    });
    response.end(bytes);
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 400);
    response.end("Local verification request failed");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`LIFELINE_RUNTIME_VALIDATION_SERVER_READY http://127.0.0.1:${port}/tests/multiplayer-browser.html`);
});
