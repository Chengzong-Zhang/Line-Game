import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fromPosix(root, relative = "") {
  return path.join(root, ...relative.split("/").filter(Boolean));
}

export async function listFiles(root, prefix = "") {
  const files = [];
  const directory = fromPosix(root, prefix);
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((a, b) => compareOrdinal(a.name, b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function fileRecords(root, files) {
  const records = [];
  for (const relative of files) {
    const bytes = await readFile(fromPosix(root, relative));
    records.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return records;
}

export function digestRecords(records) {
  return sha256(Buffer.from(records
    .map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}`)
    .join("\n"), "utf8"));
}

export async function runtimeSourceFiles(webRoot) {
  return (await listFiles(webRoot))
    .filter((relative) => !relative.startsWith("tests/"))
    .filter((relative) => relative !== "smoke-test.html")
    .filter((relative) => relative.startsWith("assets/")
      || relative.startsWith("guide/")
      || !relative.includes("/"))
    .filter((relative) => relative.startsWith("assets/")
      || relative.startsWith("guide/")
      || /\.(?:css|html|js)$/i.test(relative));
}

export async function collectReleaseSourceRecords({ repoRoot, itchRoot }) {
  const webRoot = path.join(repoRoot, "web", "web前端");
  const records = await fileRecords(webRoot, await runtimeSourceFiles(webRoot));
  for (const name of ["package.json", "package-lock.json"]) {
    const bytes = await readFile(path.join(itchRoot, name));
    records.push({ path: `itch/${name}`, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  for (const directory of ["config", "tools", "tests"]) {
    for (const relative of await listFiles(path.join(itchRoot, directory))) {
      const bytes = await readFile(fromPosix(path.join(itchRoot, directory), relative));
      records.push({
        path: `itch/${directory}/${relative}`,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      });
    }
  }
  records.sort((a, b) => compareOrdinal(a.path, b.path));
  return records;
}
