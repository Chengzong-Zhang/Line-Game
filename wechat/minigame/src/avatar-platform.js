const MAX_AVATAR_BYTES = 256 * 1024;
let imageSequence = 0;

function invoke(target, name, options, code, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (typeof target?.[name] !== 'function') return reject(new Error(code));
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = timeoutMs > 0 ? setTimeout(() => finish(new Error(code)), timeoutMs) : null;
    try { target[name]({ ...options, success: value => finish(null, value), fail: error => {
      const privacy = /privacy|authorize no response|1025|112/.test(String(error?.errMsg || error?.errno || '').toLowerCase());
      finish(new Error(/cancel/i.test(error?.errMsg || '') ? 'CANCELLED' : privacy ? 'WECHAT_PRIVACY_REQUIRED' : code));
    } }); }
    catch (_) { finish(new Error(code)); }
  });
}
function decode(api, src) {
  return new Promise((resolve, reject) => {
    const image = api.createImage();
    const finish = error => { clearTimeout(timer); image.onload = image.onerror = null; error ? reject(new Error('AVATAR_LOAD_FAILED')) : resolve(image); };
    const timer = setTimeout(() => finish(true), 10000);
    image.onload = () => finish(false); image.onerror = () => finish(true); image.src = src;
  });
}
async function remove(fs, filePath) { try { await invoke(fs, 'unlink', { filePath }, 'AVATAR_READ_FAILED'); } catch (_) {} }

function avatarData(dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new Error('INVALID_AVATAR');
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_AVATAR_BYTES) throw new Error('AVATAR_TOO_LARGE');
  return { dataUrl, mimeType: dataUrl.slice(5, dataUrl.indexOf(';')), bytes };
}

async function encodeAvatar(api, src) {
  const image = await decode(api, src);
  if (!(image.width > 0 && image.height > 0) || image.width * image.height > 40000000) throw new Error('INVALID_AVATAR');
  // Crop and re-encode: never upload the original photograph or its metadata.
  let canvas;
  try { canvas = api.createOffscreenCanvas?.({ type: '2d', width: 256, height: 256 }); } catch (_) {}
  if (typeof canvas?.toTempFilePath === 'function' || typeof canvas?.toDataURL === 'function') {
    try { return await encodeCanvas(api, canvas, image); } catch (_) { /* Retry a native secondary canvas when offscreen export is broken. */ }
  }
  try { canvas = api.createCanvas?.(); } catch (_) {}
  return encodeCanvas(api, canvas, image);
}

async function encodeCanvas(api, canvas, image) {
  if (typeof canvas?.getContext !== 'function') throw new Error('AVATAR_ENCODE_FAILED');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d'), side = Math.min(image.width, image.height);
  ctx.fillStyle = '#fffaf1'; ctx.fillRect(0, 0, 256, 256);
  ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 256, 256);
  // Native Mini Game canvases can provide data URLs even when file export is unsupported.
  if (typeof canvas.toDataURL === 'function') {
    try { return avatarData(canvas.toDataURL('image/jpeg', 0.82)); } catch (_) { /* Try the native file exporter. */ }
  }
  if (typeof canvas.toTempFilePath !== 'function') throw new Error('AVATAR_ENCODE_FAILED');
  const output = await invoke(canvas, 'toTempFilePath', { x: 0, y: 0, width: 256, height: 256,
    destWidth: 256, destHeight: 256, fileType: 'jpg', quality: 0.82 }, 'AVATAR_ENCODE_FAILED');
  const fs = api.getFileSystemManager();
  try {
    const result = await invoke(fs, 'readFile', { filePath: output.tempFilePath, encoding: 'base64' }, 'AVATAR_READ_FAILED');
    const mime = typeof result.data === 'string' && result.data.startsWith('iVBORw0KGgo') ? 'image/png' : 'image/jpeg';
    return avatarData(`data:${mime};base64,${result.data}`);
  } finally { await remove(fs, output.tempFilePath); }
}

export function avatarPlatform(api) {
  return {
    async pickAvatar() {
      let selected;
      try {
        if (typeof api.chooseMedia === 'function') {
          try { selected = await invoke(api, 'chooseMedia', { count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] }, 'AVATAR_UNAVAILABLE', 0); }
          catch (error) {
            if (error.message !== 'AVATAR_UNAVAILABLE' || typeof api.chooseImage !== 'function') throw error;
          }
        }
        if (!selected) selected = await invoke(api, 'chooseImage', { count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'] }, 'AVATAR_UNAVAILABLE', 0);
      } catch (error) { if (error.message === 'CANCELLED') return null; throw error; }
      const file = selected.tempFiles?.[0], src = file?.tempFilePath || file?.path || selected.tempFilePaths?.[0];
      if (!src || file?.size > 20 * 1024 * 1024) throw new Error('AVATAR_TOO_LARGE');
      return encodeAvatar(api, src);
    },
    async importAvatar(url) {
      if (typeof url !== 'string' || !/^https?:\/\/(?:thirdwx|wx)\.qlogo\.cn\/[A-Za-z0-9_/?=&.%+~-]+$/.test(url)) throw new Error('INVALID_AVATAR');
      return encodeAvatar(api, url.replace(/^http:/, 'https:'));
    },
    async loadImage(url) {
      if (typeof url === 'string' && url.startsWith('data:image/')) {
        avatarData(url);
        const base = api.env?.USER_DATA_PATH;
        if (!base) throw new Error('AVATAR_LOAD_FAILED');
        const fs = api.getFileSystemManager(), filePath = `${base}/lifeline-avatar-${Date.now()}-${++imageSequence}.image`;
        await invoke(fs, 'writeFile', { filePath, data: url.slice(url.indexOf(',') + 1), encoding: 'base64' }, 'AVATAR_LOAD_FAILED');
        try { return await decode(api, filePath); } finally { await remove(fs, filePath); }
      }
      if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::443)?\/api\/wechat\/account\/avatar\/[0-9a-f]{32}\/[0-9a-f]{64}$/i.test(url)) throw new Error('INVALID_AVATAR');
      // Use the already configured request origin instead of requiring another
      // downloadFile domain. Remove the temporary file once the image decodes.
      const response = await invoke(api, 'request', { url, method: 'GET', responseType: 'arraybuffer', timeout: 10000 }, 'AVATAR_LOAD_FAILED');
      const data = response.data;
      if (response.statusCode !== 200 || !data || !Number.isInteger(data.byteLength) || data.byteLength < 1 || data.byteLength > MAX_AVATAR_BYTES) throw new Error('AVATAR_LOAD_FAILED');
      const base = api.env?.USER_DATA_PATH;
      if (!base) throw new Error('AVATAR_LOAD_FAILED');
      const fs = api.getFileSystemManager(), filePath = `${base}/lifeline-avatar-${Date.now()}-${++imageSequence}.image`;
      await invoke(fs, 'writeFile', { filePath, data }, 'AVATAR_LOAD_FAILED');
      try { return await decode(api, filePath); } finally { await remove(fs, filePath); }
    },
  };
}
