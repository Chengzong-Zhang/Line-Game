const VUE_CDN_URLS = [
  "https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js",
  "https://unpkg.com/vue@3/dist/vue.global.prod.js",
  "https://fastly.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js",
];
const APP_ASSET_VERSION = "20260429c";

// main.js 只做两件事：
// 1. 确保浏览器拿到 Vue 运行时
// 2. 加载真正的应用入口 OnlineApp.js

function resolvePreferredLanguage() {
  const stored = globalThis.localStorage?.getItem("triaxis-language");
  if (stored === "en" || stored === "zh") {
    return stored;
  }

  return globalThis.navigator?.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function showBootError(message) {
  const mountPoint = document.querySelector("#app");
  if (!mountPoint) {
    return;
  }

  const language = resolvePreferredLanguage();
  const normalizedMessage = String(message ?? "");
  const mentionsVue = /vue/i.test(normalizedMessage);
  const copy = language === "zh"
    ? {
      eyebrow: "TriAxis",
      title: "页面启动失败",
      body: mentionsVue
        ? "前端运行时没有成功加载，通常是浏览器没有拿到 Vue 运行库。"
        : "前端入口模块没有成功加载，通常是静态资源没有更新、路径失效，或服务器没有返回最新文件。",
    }
    : {
      eyebrow: "TriAxis",
      title: "Page Failed To Start",
      body: mentionsVue
        ? "The frontend runtime did not load successfully. Usually the browser failed to fetch the Vue runtime."
        : "The frontend entry module did not load successfully. Usually the static asset path is stale, the file was not deployed, or the server did not return the latest file.",
    };

  mountPoint.innerHTML = `
    <section style="max-width:720px;margin:48px auto;padding:24px 28px;border:1px solid rgba(95,70,40,.18);border-radius:24px;background:#fffaf0;color:#3f3426;font:16px/1.6 Georgia, serif;box-shadow:0 20px 60px rgba(74,54,31,.08);">
      <p style="margin:0 0 8px;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#8d7557;">${copy.eyebrow}</p>
      <h1 style="margin:0 0 12px;font-size:32px;">${copy.title}</h1>
      <p style="margin:0 0 10px;">${copy.body}</p>
      <p style="margin:0;">${message}</p>
    </section>
  `;
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(script);
  });
}

async function ensureVueRuntime() {
  // 运行时优先复用 window.Vue，失败时再按 CDN 列表兜底。
  if (globalThis.Vue?.createApp) {
    return globalThis.Vue;
  }

  let lastError = null;
  for (const url of VUE_CDN_URLS) {
    try {
      await loadScript(url);
      if (globalThis.Vue?.createApp) {
        return globalThis.Vue;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Vue runtime could not be loaded from any CDN.");
}

async function importAppModule() {
  const candidates = [
    new URL(`./OnlineApp.js?v=${APP_ASSET_VERSION}`, import.meta.url).href,
    new URL("./OnlineApp.js", import.meta.url).href,
    `./OnlineApp.js?v=${APP_ASSET_VERSION}`,
    "./OnlineApp.js",
  ];
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      lastError = error;
      console.warn(`TriAxis app import failed for ${candidate}:`, error);
    }
  }

  throw lastError ?? new Error("OnlineApp.js could not be loaded from any candidate URL.");
}

async function bootstrap() {
  try {
    const Vue = await ensureVueRuntime();
    const { default: App } = await importAppModule();
    Vue.createApp(App).mount("#app");
  } catch (error) {
    console.error("TriAxis bootstrap failed:", error);
    const fallbackMessage = resolvePreferredLanguage() === "zh"
      ? "未知启动错误。"
      : "Unknown bootstrap error.";
    showBootError(error?.message ?? fallbackMessage);
  }
}

void bootstrap();

