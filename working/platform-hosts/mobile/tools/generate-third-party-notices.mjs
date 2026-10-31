import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function generateThirdPartyNotices({
  legalRoot = path.join(mobileRoot, 'legal'),
  outputPath = path.join(mobileRoot, 'dist/legal/THIRD_PARTY_NOTICES.html'),
} = {}) {
  const manifest = JSON.parse(await readFile(path.join(legalRoot, 'license-manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== 9) {
    throw new Error(`Expected 9 reviewed license entries; got ${manifest.packages?.length ?? 'invalid manifest'}.`);
  }

  const packages = [];
  for (const [index, item] of manifest.packages.entries()) {
    const sourcePath = path.resolve(legalRoot, item.path);
    if (!sourcePath.startsWith(`${path.resolve(legalRoot)}${path.sep}`)) {
      throw new Error(`License path escapes legal directory: ${item.name}`);
    }
    const bytes = await readFile(sourcePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== item.bytes || sha256 !== item.sha256) {
      throw new Error(`Reviewed license source changed: ${item.name}`);
    }
    packages.push({
      ...item,
      id: `license-${index + 1}`,
      text: bytes.toString('utf8'),
    });
  }

  const contents = packages.map((item) =>
    `        <li><a href="#${item.id}">${escapeHtml(item.name)} ${escapeHtml(item.version)}</a></li>`,
  ).join('\n');
  const sections = packages.map((item) => `
      <section class="license-card" id="${item.id}">
        <h2>${escapeHtml(item.name)}</h2>
        <p class="metadata">Version ${escapeHtml(item.version)} · ${escapeHtml(item.license)}</p>
        <details>
          <summary>Full license text / 完整许可原文</summary>
          <pre>${escapeHtml(item.text)}</pre>
        </details>
      </section>`).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>Third-party notices · LIFELINE</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.55; background: #101714; color: #f0eee7; }
    * { box-sizing: border-box; }
    body { margin: 0 auto; padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(2rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); max-width: 56rem; }
    a { color: #d7bd79; text-underline-offset: .18em; }
    header { padding: .5rem 0 1.25rem; }
    h1 { font-size: clamp(1.65rem, 7vw, 2.4rem); line-height: 1.15; margin: 1rem 0 .5rem; }
    h2 { font-size: 1.15rem; overflow-wrap: anywhere; margin: 0; }
    .back { display: inline-flex; min-height: 2.75rem; align-items: center; padding: .45rem .8rem; border: 1px solid #726644; border-radius: .7rem; text-decoration: none; }
    .intro, .metadata { color: #c7c5bb; }
    nav, .license-card { border: 1px solid #3a4640; border-radius: .85rem; background: #18211d; padding: 1rem; margin: 1rem 0; }
    nav h2 { margin-bottom: .5rem; }
    nav ol { margin: 0; padding-left: 1.35rem; }
    nav li { padding: .22rem 0; overflow-wrap: anywhere; }
    .metadata { margin: .25rem 0 .8rem; font-size: .94rem; }
    summary { min-height: 2.75rem; display: flex; align-items: center; cursor: pointer; color: #e7d49d; font-weight: 600; }
    pre { margin: .7rem 0 0; padding: .9rem; border-radius: .6rem; background: #0c110f; color: #efeee9; white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; font: .82rem/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    footer { padding-top: 1rem; }
  </style>
</head>
<body>
  <header>
    <a class="back" href="../index.html">← Back to game / 返回游戏</a>
    <h1>Third-party notices</h1>
    <p class="intro">LIFELINE mobile includes the following software and font packages. Each section contains the complete license text shipped with this build. The Markdown notice and original license files are also included in the package.</p>
  </header>
  <nav aria-label="Package list">
    <h2>Packages / 组件</h2>
    <ol>
${contents}
    </ol>
  </nav>
${sections}
  <footer><a class="back" href="../index.html">Back to game / 返回游戏</a></footer>
  <script type="module" src="../platform/native-back-bootstrap.js"></script>
</body>
</html>
`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  return { packageCount: packages.length, outputPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateThirdPartyNotices({
    outputPath: path.resolve(process.argv[2] ?? path.join(mobileRoot, 'dist/legal/THIRD_PARTY_NOTICES.html')),
  });
  console.log(JSON.stringify({ status: 'PASS-CURRENT', ...result }));
}
