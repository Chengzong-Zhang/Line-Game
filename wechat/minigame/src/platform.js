import { TEXT } from './i18n.js';
import { createAnonymousContributionRequest } from './contribution-transport.js';
import { avatarPlatform } from './avatar-platform.js';
import { userInfoPlatform } from './user-info-platform.js';

export function createWxPlatform(api) {
  const modal = (options) => new Promise((resolve) => api.showModal({ ...options,
    success: resolve, fail: () => resolve({ confirm: false }) }));
  return {
    ...avatarPlatform(api),
    ...userInfoPlatform(api),
    canvas: api.createCanvas(),
    createImage: () => api.createImage(),
    metrics: () => {
      const info = api.getWindowInfo ? api.getWindowInfo() : api.getSystemInfoSync();
      let menu;
      try { menu = api.getMenuButtonBoundingClientRect?.(); } catch (_) { /* Use the reserved menu row below. */ }
      const safeTop = Math.max(info.safeArea?.top || 0, info.statusBarHeight || 0, 24);
      // The native 3.17.4 simulator can return {} while drawing its capsule.
      // Reserve a menu row when its bounds are unavailable so controls stay tappable.
      const menuBottom = Number.isFinite(menu?.bottom) && menu.bottom > safeTop
        ? menu.bottom : safeTop + 40;
      return { width: info.windowWidth, height: info.windowHeight, dpr: Math.min(info.pixelRatio || 1, 2),
        top: menuBottom, capsuleTop: Number.isFinite(menu?.top) && menu.top >= safeTop && menu.top < menuBottom ? menu.top : safeTop + 4,
        capsuleLeft: Number.isFinite(menu?.left) && menu.left >= info.windowWidth / 2 && menu.left < info.windowWidth ? menu.left : info.windowWidth - 102,
        capsuleHeight: Number.isFinite(menu?.height) && menu.height >= 20 && menu.height <= 48 ? menu.height : 32,
        bottom: Math.max(16, info.windowHeight - (info.safeArea?.bottom || info.windowHeight)) };
    },
    storage: { get: (key) => api.getStorageSync(key), set: (key, value) => api.setStorageSync(key, value),
      remove: key => api.removeStorageSync?.(key) },
    contributionRequest: createAnonymousContributionRequest(api),
    readClipboard: () => new Promise((resolve, reject) => {
      if (!api.getClipboardData) return reject(new Error('CLIPBOARD_UNAVAILABLE'));
      api.getClipboardData({ success: result => resolve(result.data), fail: () => reject(new Error('CLIPBOARD_UNAVAILABLE')) });
    }),
    writeClipboard: text => new Promise((resolve, reject) => {
      if (!api.setClipboardData) return reject(new Error('CLIPBOARD_UNAVAILABLE'));
      api.setClipboardData({ data: text, success: resolve, fail: () => reject(new Error('CLIPBOARD_UNAVAILABLE')) });
    }),
    createWorker: () => api.createWorker('workers/index.js'),
    loadSubpackage: (name, progress) => new Promise((resolve, reject) => {
      if (!api.loadSubpackage) return reject(new Error('MODELS_UNAVAILABLE'));
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('MODEL_DOWNLOAD_FAILED')), 30000);
      try {
        const task = api.loadSubpackage({ name, success: () => finish(), fail: () => finish(new Error('MODEL_DOWNLOAD_FAILED')) });
        task?.onProgressUpdate?.(result => { if (!settled) progress?.(result.progress); });
      } catch (_) { finish(new Error('MODEL_DOWNLOAD_FAILED')); }
    }),
    readAsset: filePath => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
      const timer = setTimeout(() => finish(new Error('MODEL_READ_FAILED')), 10000);
      try { api.getFileSystemManager().readFile({ filePath,
        success: result => finish(null, result.data), fail: () => finish(new Error('MODEL_READ_FAILED')) }); }
      catch (_) { finish(new Error('MODEL_READ_FAILED')); }
    }),
    touchStart: (fn) => api.onTouchStart(fn), touchEnd: (fn) => api.onTouchEnd(fn),
    touchMove: (fn) => api.onTouchMove(fn), touchCancel: (fn) => api.onTouchCancel(fn),
    onHide: (fn) => api.onHide(fn), onShow: (fn) => api.onShow(fn), onResize: (fn) => api.onWindowResize(fn),
    onNetworkStatusChange: (fn) => {
      if (typeof api.onNetworkStatusChange !== 'function' || typeof api.offNetworkStatusChange !== 'function') return () => {};
      let listening = true;
      const handler = status => { if (listening) fn(status); };
      api.onNetworkStatusChange(handler);
      return () => { if (listening) { listening = false; api.offNetworkStatusChange(handler); } };
    },
    frame: (fn) => requestAnimationFrame(fn),
    confirm: async (content) => Boolean((await modal({ title: TEXT.zh.title, content })).confirm),
    message: (content) => modal({ title: TEXT.zh.title, content, showCancel: false }),
    choose: async (itemList, { previousLabel = 'Previous', nextLabel = 'Next', isCurrent = () => true } = {}) => {
      if (!Array.isArray(itemList) || !itemList.length) return -1;
      const items = itemList.slice(), pageSize = items.length > 6 ? 4 : 6;
      let offset = 0;
      while (isCurrent()) {
        // Native action sheets accept at most six rows, including navigation.
        const visible = items.slice(offset, offset + pageSize), rows = [...visible];
        const previous = offset > 0 ? rows.push(`‹ ${previousLabel}`) - 1 : -1;
        const next = offset + visible.length < items.length ? rows.push(`${nextLabel} ›`) - 1 : -1;
        const selected = await new Promise(resolve => {
          try { api.showActionSheet({ itemList: rows,
            success: result => resolve(result?.tapIndex), fail: () => resolve(-1) }); }
          catch (_) { resolve(-1); }
        });
        if (!isCurrent() || !Number.isInteger(selected) || selected < 0 || selected >= rows.length) return -1;
        if (selected < visible.length) return offset + selected;
        if (selected === previous) offset -= pageSize;
        else if (selected === next) offset += pageSize;
      }
      return -1;
    },
    input: async (content, placeholderText = '') => {
      const result = await modal({ title: content, editable: true, placeholderText });
      return result.confirm ? result.content : null;
    },
    request: (options) => new Promise((resolve, reject) => api.request({ timeout: 10000, ...options,
      success: (res) => res.statusCode >= 200 && res.statusCode < 300 ? resolve(res.data)
        : reject(new Error(typeof res.data?.detail === 'string' ? res.data.detail : `HTTP_${res.statusCode}`)),
      fail: () => reject(new Error('NETWORK_ERROR')) })),
    login: () => new Promise((resolve, reject) => api.login({
      success: (res) => res.code ? resolve(res.code) : reject(new Error('LOGIN_FAILED')),
      fail: () => reject(new Error('LOGIN_FAILED')) })),
    connectSocket: (url) => api.connectSocket({ url }),
    share: (payload) => api.shareAppMessage(payload),
    setupShare: (provider) => { api.showShareMenu?.({ withShareTicket: false }); api.onShareAppMessage(provider); },
    launchOptions: () => api.getLaunchOptionsSync?.() || {},
  };
}
