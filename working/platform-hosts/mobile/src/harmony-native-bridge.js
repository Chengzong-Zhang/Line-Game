const SHARE_JSON_LIMIT_BYTES = 4_000_000;
const SHARE_OPEN_TIMEOUT_MS = 35_000;
const SHARE_DISMISS_TIMEOUT_MS = 10 * 60 * 1000;
const CAPABILITY_QUERY_TIMEOUT_MS = 5_000;

function utf8Length(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function installHarmonyNativeBridge() {
  const proxy = globalThis.LifelineArkTS;
  if (!proxy || typeof proxy.callNative !== 'function') return false;

  let nextRequestId = 0;
  const nonceWords = new Uint32Array(2);
  globalThis.crypto.getRandomValues(nonceWords);
  const pageNonce = [...nonceWords].map((word) => word.toString(16).padStart(8, '0')).join('');
  const pending = new Map();
  let activeShareRequestId = null;
  globalThis.__lifelineNativeComplete = (requestId, responseJson) => {
    const request = pending.get(requestId);
    if (!request) return;
    try {
      const response = JSON.parse(responseJson);
      if (request.operation === 'shareReplay' && response.ok && response.result?.status === 'opened') {
        request.opened = true;
        if (request.timeout !== null) globalThis.clearTimeout(request.timeout);
        request.timeout = globalThis.setTimeout(() => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          if (activeShareRequestId === requestId) activeShareRequestId = null;
          request.reject(new Error('分享面板关闭状态未确认，分享结果未知。请先关闭分享面板；若仍无法导出，请完全退出应用后重试。'));
        }, SHARE_DISMISS_TIMEOUT_MS);
        return;
      }
      pending.delete(requestId);
      if (request.timeout !== null) globalThis.clearTimeout(request.timeout);
      if (request.operation === 'shareReplay' && activeShareRequestId === requestId) activeShareRequestId = null;
      if (request.opened) {
        if (response.ok && response.result?.status === 'dismissed') request.resolve(response.result);
        else request.reject(new Error('分享面板关闭状态未确认，分享结果未知。请先关闭分享面板；若仍无法导出，请完全退出应用后重试。'));
        return;
      }
      if (request.operation === 'shareReplay' && response.ok && response.result?.status !== 'opened') {
        request.reject(new Error('Harmony did not confirm that the replay share panel opened.'));
        return;
      }
      if (response.ok) request.resolve(response.result);
      else request.reject(new Error(response.error || 'Native request failed.'));
    } catch (error) {
      pending.delete(requestId);
      if (request.timeout !== null) globalThis.clearTimeout(request.timeout);
      if (request.operation === 'shareReplay' && activeShareRequestId === requestId) activeShareRequestId = null;
      request.reject(error);
    }
  };

  globalThis.__lifelineNetworkStatusEvent = (eventJson) => {
    try {
      const event = JSON.parse(eventJson);
      if (event?.pageNonce !== pageNonce || !event.status) return;
      globalThis.dispatchEvent(new CustomEvent('lifeline:network-status', { detail: event }));
    } catch (_error) {}
  };

  const invoke = (operation, key, value = '') => new Promise((resolve, reject) => {
    if (operation === 'shareReplay' && activeShareRequestId !== null) {
      reject(new Error('A replay share panel is already active.'));
      return;
    }
    const requestId = `${pageNonce}.${++nextRequestId}`;
    const interactive = operation === 'shareReplay';
    const credentialOperation = ['claimCredentialOwner', 'loadCredential', 'saveCredential', 'clearCredential'].includes(operation);
    const timeout = credentialOperation || operation === 'importReplay' ? null : globalThis.setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      if (interactive && activeShareRequestId === requestId) activeShareRequestId = null;
      const error = new Error(interactive
        ? '未能确认系统分享面板是否打开；面板仍可能出现。请先关闭分享面板；若仍无法导出，请完全退出应用后重试。'
        : `Harmony native request timed out: ${operation}`);
      if (operation === 'getCapabilities') error.code = 'timeout';
      reject(error);
    }, interactive ? SHARE_OPEN_TIMEOUT_MS : ['getCapabilities', 'getNetworkStatus', 'startNetworkStatus', 'stopNetworkStatus', 'requestMoveHaptic'].includes(operation) ? CAPABILITY_QUERY_TIMEOUT_MS : 15000);
    pending.set(requestId, { resolve, reject, timeout, operation, opened: false });
    if (interactive) activeShareRequestId = requestId;
    try {
      proxy.callNative(requestId, operation, key, value);
    } catch (error) {
      pending.delete(requestId);
      if (timeout !== null) globalThis.clearTimeout(timeout);
      if (interactive && activeShareRequestId === requestId) activeShareRequestId = null;
      reject(error);
    }
  });

  const shareReplay = (payload) => {
    let serialized;
    try {
      serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const document = JSON.parse(serialized);
      if (!document || Array.isArray(document) || typeof document !== 'object'
        || document.format !== 'lifeline-replay' || document.schemaVersion !== 1) {
        throw new Error('Unsupported replay document.');
      }
      if (utf8Length(serialized) > SHARE_JSON_LIMIT_BYTES) throw new Error('Replay file is too large to share.');
    } catch (error) {
      return Promise.reject(error);
    }
    return invoke('shareReplay', '', serialized);
  };

  const importReplay = () => invoke('importReplay', '', '');
  const openTutorial = (targetUrl) => {
    if (typeof targetUrl !== 'string' || targetUrl.length > 8192) return Promise.reject(new Error('Invalid tutorial URL.'));
    return invoke('openTutorial', '', targetUrl);
  };

  const moveToBackground = () => invoke('moveToBackground', '');
  const requestMoveHaptic = () => invoke('requestMoveHaptic', '', '');
  const getAppInfo = () => invoke('getAppInfo', '');
  const getCapabilities = () => invoke('getCapabilities', '', JSON.stringify({ schemaVersion: 1 }));
  const getNetworkStatus = () => invoke('getNetworkStatus', '');
  const startNetworkStatus = (subscriptionId) => invoke('startNetworkStatus', '', subscriptionId);
  const stopNetworkStatus = (subscriptionId) => invoke('stopNetworkStatus', '', subscriptionId);

  globalThis.LifelineBridge = Object.freeze({
    loadRecord: (key) => invoke('loadRecord', key),
    saveRecord: (key, value) => invoke('saveRecord', key, value),
    removeRecord: (key) => invoke('removeRecord', key),
    claimCredentialOwner: (lease) => invoke('claimCredentialOwner', '', JSON.stringify(lease)),
    loadCredential: (lease) => invoke('loadCredential', '', JSON.stringify(lease)),
    saveCredential: (lease) => invoke('saveCredential', '', JSON.stringify(lease)),
    clearCredential: (lease) => invoke('clearCredential', '', JSON.stringify(lease)),
    shareReplay,
    importReplay,
    openTutorial,
    moveToBackground,
    requestMoveHaptic,
    getAppInfo,
    getCapabilities,
    getNetworkStatus,
    startNetworkStatus,
    stopNetworkStatus,
  });
  return true;
}
