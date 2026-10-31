import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../../web/web前端/", import.meta.url));
const rendererRoot = path.resolve(fileURLToPath(new URL("../renderer/", import.meta.url)));
export function prepareHtml(source) {
  let html = source.replace(/<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax@3\/es5\/tex-chtml\.js"><\/script>/, '<script defer src="./vendor/mathjax/tex-chtml.js"></script>');
  if (!html.includes("./vendor/vue/vue.global.prod.js")) {
    const newline = html.includes("\r\n") ? "\r\n" : "\n";
    html = html.replace(/    <script>\r?\n/, `    <script src="./vendor/vue/vue.global.prod.js"></script>${newline}    <script>${newline}`);
  }
  html = html.replace(/<script type="module" src="\.\/main\.js\?v=[^"]+"><\/script>/, '<script type="module" src="./main.js"></script>');
  if (html.includes("cdn.jsdelivr.net") || html.includes("unpkg.com")) throw new Error("An online script dependency remains in the desktop HTML.");
  return html;
}

export function prepareMain(source) {
  let main = source.replace(/const VUE_CDN_URLS = \[[\s\S]*?\];\r?\n/, "");
  main = main.replace(/const APP_ASSET_VERSION = .*?;\r?\n/, "");
  main = main.replace(/async function ensureVueRuntime\(\) \{[\s\S]*?\r?\n\}\r?\n/, 'async function ensureVueRuntime() {\n  if (globalThis.Vue?.createApp) return globalThis.Vue;\n  throw new Error("Bundled Vue runtime is unavailable.");\n}\n');
  main = main.replace(/  const candidates = \[[\s\S]*?\n  \];\r?\n  let lastError = null;[\s\S]*?\n\}/, '  return import("./OnlineApp.js");\n}');
  if (/https?:\/\//.test(main)) throw new Error("An online URL remains in the desktop bootstrap.");
  return main;
}

export function prepareStyles(source) {
  const css = source.replace(/^@import url\("https:\/\/fonts\.googleapis\.com[^"]+"\);\r?\n/, "");
  if (/fonts\.googleapis\.com/.test(css)) throw new Error("A remote font import remains in desktop styles.");
  return css;
}

export function prepareApp(source) {
  const networkDock = /<DockLauncher\s+([^>]*?)variant="network"/g;
  const networkModal = /<UtilityModal\s+([^>]*?)variant="network"/g;
  const footer = /\s*<footer class="site-footer">[\s\S]*?<\/footer>/;
  let app = source.replace(networkDock, (_match, attributes) => {
    const updated = attributes.includes('v-if=')
      ? attributes.replace(/v-if="([^"]*)"/, 'v-if="$1 && !desktopPlatform"')
      : 'v-if="!desktopPlatform" ' + attributes;
    return `<DockLauncher ${updated}variant="network"`;
  });
  app = app.replace(networkModal, (_match, attributes) => {
    const updated = attributes.includes('v-if=')
      ? attributes.replace(/v-if="([^"]*)"/, 'v-if="$1 && !desktopPlatform"')
      : 'v-if="!desktopPlatform" ' + attributes;
    return `<UtilityModal ${updated}variant="network"`;
  });
  app = app.replace(footer, "");
  if (app.includes("      contributionAllowed: !desktopPlatform,") && !app.includes("      desktopPlatform,\n      contributionAllowed: !desktopPlatform,")) {
    app = app.replace("      contributionAllowed: !desktopPlatform,", "      desktopPlatform,\n      contributionAllowed: !desktopPlatform,");
  }
  const unguardedDock = [...app.matchAll(/<DockLauncher\s+([^>]*?)variant="network"/g)].some(([, attributes]) => !/v-if="[^"]*!desktopPlatform/.test(attributes));
  const unguardedModal = [...app.matchAll(/<UtilityModal\s+([^>]*?)variant="network"/g)].some(([, attributes]) => !/v-if="[^"]*!desktopPlatform/.test(attributes));
  if (app === source || unguardedDock || unguardedModal || footer.test(app)
    || (source.includes("contributionAllowed: !desktopPlatform,") && !app.includes("      desktopPlatform,\n      contributionAllowed: !desktopPlatform,"))) {
    throw new Error("Desktop app transform did not isolate the network UI and remove the web-only footer.");
  }
  return app;
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".test-tmp") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  const desktopRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  if (rendererRoot !== path.join(desktopRoot, "renderer") || !rendererRoot.startsWith(`${desktopRoot}${path.sep}`)) {
    throw new Error("Refusing to write renderer output outside desktop/renderer.");
  }
  if (fs.existsSync(rendererRoot)) {
    if (fs.lstatSync(rendererRoot).isSymbolicLink()) throw new Error("Refusing to replace a linked renderer output directory.");
    fs.rmSync(rendererRoot, { recursive: true, force: true });
  }
  copyDirectory(frontendRoot, rendererRoot);
  const indexPath = path.join(rendererRoot, "index.html");
  const mainPath = path.join(rendererRoot, "main.js");
  const stylesPath = path.join(rendererRoot, "styles.css");
  const appPath = path.join(rendererRoot, "OnlineApp.js");
  fs.writeFileSync(indexPath, prepareHtml(fs.readFileSync(indexPath, "utf8")), "utf8");
  fs.writeFileSync(mainPath, prepareMain(fs.readFileSync(mainPath, "utf8")), "utf8");
  fs.writeFileSync(stylesPath, prepareStyles(fs.readFileSync(stylesPath, "utf8")), "utf8");
  fs.writeFileSync(appPath, prepareApp(fs.readFileSync(appPath, "utf8")), "utf8");
  console.log("Prepared isolated desktop renderer output; shared Web sources are unchanged.");
}
