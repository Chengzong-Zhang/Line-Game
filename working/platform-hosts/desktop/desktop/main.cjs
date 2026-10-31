const { app, BrowserWindow, dialog, ipcMain, protocol, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
// Automated package checks use an isolated temporary profile. Normal launches
// leave this unset and retain Electron's standard per-user application folder.
if (process.env.LIFELINE_TEST_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.LIFELINE_TEST_USER_DATA));
}
const { createSaveStore } = require("./src/save-store.cjs");
const { createSteamAdapter } = require("./src/steam-adapter.cjs");
const { createAchievementService } = require("./src/achievement-store.cjs");
const { createProgressBackupService } = require("./src/progress-backup.cjs");

const APP_SCHEME = "lifeline";
const APP_HOST = "app";
const RENDERER_ROOT = path.resolve(__dirname, "renderer");
const DEPENDENCY_ROOT = path.resolve(__dirname, "../node_modules");
const CSP = [
  "default-src 'self' data: blob:",
  "base-uri 'self'",
  "connect-src 'self' data: blob:",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:"
].join("; ");

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

const store = createSaveStore(path.join(app.getPath("userData"), "saves"));
const { createProfileStore } = require("./src/profile-store.cjs");
const profileStore = createProfileStore(path.join(app.getPath("userData"), "profile"));
const steam = createSteamAdapter();
const achievements = createAchievementService(app.getPath("userData"), profileStore, steam);
let mainWindow = null;
const progressBackup = createProgressBackupService(profileStore, dialog, () => mainWindow);

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".css": "text/css; charset=utf-8", ".f32": "application/octet-stream", ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm",
    ".woff": "font/woff", ".woff2": "font/woff2"
  })[extension] ?? "application/octet-stream";
}

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST || request.method !== "GET") return new Response("Not found", { status: 404 });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Bad path", { status: 400 }); }
    let base = RENDERER_ROOT;
    let relative = pathname;
    if (pathname.startsWith("/vendor/vue/")) {
      base = path.join(DEPENDENCY_ROOT, "vue", "dist");
      relative = pathname.slice("/vendor/vue/".length);
    } else if (pathname.startsWith("/vendor/mathjax/")) {
      base = path.join(DEPENDENCY_ROOT, "mathjax-full", "es5");
      relative = pathname.slice("/vendor/mathjax/".length);
    }
    const target = path.resolve(base, `.${path.sep}${relative}`);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) return new Response("Forbidden", { status: 403 });
    try {
      const data = await fs.promises.readFile(target);
      return new Response(data, { headers: { "Content-Type": contentType(target), "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function isTrustedSender(event) {
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST;
  } catch { return false; }
}

function registerIpc() {
  ipcMain.on("lifeline:save:read", (event) => {
    if (!isTrustedSender(event)) return;
    event.returnValue = store.read();
  });
  ipcMain.on("lifeline:save:write", (event, serialized) => {
    if (!isTrustedSender(event)) return;
    event.returnValue = store.write(serialized);
  });
  ipcMain.on("lifeline:save:clear", (event) => {
    if (!isTrustedSender(event)) return;
    event.returnValue = store.clear();
  });
  ipcMain.on("lifeline:profile:read", (event) => {
    if (!isTrustedSender(event)) return;
    event.returnValue = profileStore.read();
  });
  ipcMain.on("lifeline:profile:write", (event, serialized) => {
    if (!isTrustedSender(event)) return;
    event.returnValue = profileStore.write(serialized);
  });
  ipcMain.handle("lifeline:replay:save", async (event, serialized) => {
    if (!isTrustedSender(event) || typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 10_000_000) return { ok: false, reason: "invalid-replay" };
    let parsed;
    try { parsed = JSON.parse(serialized); } catch { return { ok: false, reason: "invalid-replay" }; }
    if (parsed?.format !== "lifeline-replay") return { ok: false, reason: "invalid-replay" };
    const choice = await dialog.showSaveDialog(mainWindow, { title: "Export LIFELINE replay", defaultPath: "lifeline-replay.json", filters: [{ name: "LIFELINE replay", extensions: ["json"] }] });
    if (choice.canceled || !choice.filePath) return { ok: false, reason: "cancelled" };
    try { store.writeExport(choice.filePath, serialized); return { ok: true }; }
    catch (error) { return { ok: false, reason: "write-failed", message: String(error?.message ?? error) }; }
  });
  ipcMain.handle("lifeline:steam:status", (event) => isTrustedSender(event) ? steam.status() : { available: false, reason: "untrusted-renderer" });
  ipcMain.handle("lifeline:achievements:read", (event) => isTrustedSender(event)
    ? achievements.read()
    : { ok: false, status: "untrusted-renderer", achievements: [], pendingCount: 0, steam: { available: false, configured: false } });
  ipcMain.handle("lifeline:progress-backup:export", (event) => isTrustedSender(event)
    ? progressBackup.exportBackup()
    : { ok: false, status: "untrusted-renderer" });
  ipcMain.handle("lifeline:progress-backup:import", (event) => isTrustedSender(event)
    ? progressBackup.importBackup()
    : { ok: false, status: "untrusted-renderer" });
  ipcMain.handle("lifeline:app:quit", (event) => {
    if (!isTrustedSender(event)) return { ok: false, reason: "untrusted-renderer" };
    app.quit();
    return { ok: true };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f7f2e8",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) event.preventDefault();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  void mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    registerAppProtocol();
    registerIpc();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
