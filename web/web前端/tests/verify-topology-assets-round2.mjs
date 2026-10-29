import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const sources = new Map();
for (const name of await readdir(root)) {
  if (name.endsWith(".js")) sources.set(name, await readFile(new URL(name, root), "utf8"));
}
const version = sources.get("main.js").match(/const APP_ASSET_VERSION = "([^"]+)"/)[1];
const index = await readFile(new URL("index.html", root), "utf8");
assert.ok(index.includes(`./main.js?v=${version}`));
const references = [];
const rewrittenModules = new Set(["LocalGameSession.js", "TopologyStateCodec.js", "BoardDefinition.js", "AIStateProtocol.js"]);
for (const [parent, source] of sources) {
  for (const match of source.matchAll(/["']\.\/([A-Za-z0-9_-]+\.js)(?:\?v=([^"']+))?["']/g)) {
    references.push({ parent, child: match[1], version: match[2] });
    if (match[2] === version) rewrittenModules.add(parent);
  }
}
// A file whose import text changed must receive a new URL at every parent.
// Otherwise a browser may reuse its cached source and load old grandchildren.
for (const reference of references) {
  if (rewrittenModules.has(reference.child)) {
    assert.equal(reference.version, version, `${reference.parent} still caches ${reference.child}`);
  }
}
assert.ok(references.some(r => r.parent === "OnlineApp.js" && r.child === "LocalGameSession.js"));
assert.ok(references.some(r => r.parent === "LocalGameSession.js" && r.child === "TopologyStateCodec.js"));
console.log(`PASS product asset identity ${version}, ${rewrittenModules.size} module identities`);
