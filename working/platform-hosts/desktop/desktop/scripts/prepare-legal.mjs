import fs from "node:fs";
import path from "node:path";
import { workspace, json, fileHash } from "./release-lib.mjs";

const lock = json(path.join(workspace, "package-lock.json"));
const records = [], sections = [];
for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!location || entry.dev) continue;
  const directory = path.join(workspace, location);
  const manifest = json(path.join(directory, "package.json"));
  const expectedName = location.split("/node_modules/").at(-1).replace(/^node_modules\//, "");
  if (manifest.version !== entry.version || manifest.name !== expectedName) throw new Error(`Installed package differs from lock: ${location}`);
  const names = fs.readdirSync(directory).filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(name)
    && fs.statSync(path.join(directory, name)).isFile()).sort();
  const supplement = !names.length && manifest.name === "mj-context-menu" && manifest.version === "0.6.1"
    ? "desktop/legal/upstream/mj-context-menu-LICENSE.txt" : null;
  if (!names.length && !supplement) throw new Error(`Review missing license text: ${location}`);
  records.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? entry.license ?? "UNDECLARED",
    source: location, ...(supplement ? { supplementalNotice: supplement, supplementSha256: fileHash(path.join(workspace, supplement)),
      note: "Published 0.6.1 tarball omits LICENSE; Apache-2.0 is declared in its package.json. Supplemental text is retained from upstream commit 72e16a5713cf30b390776c89bb6c1428747472f1." } : {}),
    notices: names.map(name => ({ file: name, sha256: fileHash(path.join(directory, name)) })) });
  const text = supplement ? fs.readFileSync(path.join(workspace, supplement), "utf8").trim()
    : names.map(name => `${name}\n${fs.readFileSync(path.join(directory, name), "utf8").trim()}`).join("\n\n");
  sections.push(`${manifest.name} ${manifest.version}\n${"=".repeat(72)}\n${supplement ? "Supplemental upstream Apache-2.0 notice (published tarball omits LICENSE).\n" : ""}${text}`);
}
const output = path.join(workspace, "desktop/legal");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "DEPENDENCY_LICENSES.txt"), "LIFELINE Windows dependency notices\nOriginal license texts from pinned packages, with explicitly labeled upstream supplements.\n\n" + sections.join("\n\n\n") + "\n");
fs.writeFileSync(path.join(output, "dependency-notice-index.json"), JSON.stringify({ format: "lifeline-license-inventory", schemaVersion: 1,
  packageLockSha256: fileHash(path.join(workspace, "package-lock.json")), packages: records }, null, 2) + "\n");
console.log(JSON.stringify({ status: "DEPENDENCY_NOTICES_PREPARED", packages: records.length, output }));
