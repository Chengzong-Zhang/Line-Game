import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createCapabilities, queryCapabilities } from './capability-contract.js';
import { createReplayImportClient } from './replay-import-client.js';
import { initializeSessionAuthority } from './session-authority.js';
import { createNetworkStatusController } from './network-status.js';
import { createCredentialAuthority } from './credential-authority.js';

const LifelineStorage = registerPlugin('LifelineStorage');
const LifelineCapabilities = registerPlugin('LifelineCapabilities');
const LifelineNetwork = registerPlugin('LifelineNetwork');
const LifelineReplayImport = registerPlugin('LifelineReplayImport');
const LifelineHaptics = registerPlugin('LifelineHaptics');
const LifelineTutorialHost = registerPlugin('LifelineTutorialHost');
const SESSION_KEY = 'lifeline-local-game-session-v1';
const REPLAY_CACHE_DIRECTORY = 'lifeline-replay-share';
const REPLAY_FILE_LIMIT = 32;
const REPLAY_CACHE_BYTES_LIMIT = 128 * 1024 * 1024;
const REPLAY_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REPLAY_FILE_MIN_RETENTION_MS = 60 * 60 * 1000;
const REPLAY_JSON_LIMIT_BYTES = 4_000_000;
const SHARE_PREPARATION_TIMEOUT_MS = 30_000;
const SHARE_RESULT_TIMEOUT_MS = 9 * 60 * 1000;
let activeReplayShare = null;

function utf8ByteLength(value) {
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

function isCancelledShare(error) {
  return error?.message === 'Share canceled';
}

function createReplayFileName(now) {
  const random = new Uint32Array(4);
  globalThis.crypto.getRandomValues(random);
  const nonce = [...random].map((word) => word.toString(16).padStart(8, '0')).join('');
  return `replay-${String(now).padStart(13, '0')}-${nonce}.json`;
}

async function listReplayCache() {
  try {
    return await Filesystem.readdir({ path: REPLAY_CACHE_DIRECTORY, directory: Directory.Cache });
  } catch (error) {
    await Filesystem.mkdir({ path: REPLAY_CACHE_DIRECTORY, directory: Directory.Cache, recursive: true });
    return Filesystem.readdir({ path: REPLAY_CACHE_DIRECTORY, directory: Directory.Cache });
  }
}

async function prepareReplayCache(payloadBytes, now) {
  const listing = await listReplayCache();
  const cacheNames = new Set((listing.files ?? []).map((entry) => entry.name));
  let ownedFiles = [];
  let cachedBytes = 0;
  for (const entry of listing.files ?? []) {
    if (entry.type !== 'file') continue;
    const match = /^replay-(\d{13})-([a-f0-9]{32})\.json$/.exec(entry.name);
    if (!match) continue;
    const createdAt = Number(match[1]);
    if (!Number.isFinite(createdAt)) continue;
    const path = `${REPLAY_CACHE_DIRECTORY}/${entry.name}`;
    let pinned = activeReplayShare?.path === path;
    const markerName = `${entry.name}.active`;
    if (cacheNames.has(markerName)) {
      if (!pinned && now >= createdAt && now - createdAt > REPLAY_FILE_MAX_AGE_MS) {
        try {
          await Filesystem.deleteFile({ path: `${REPLAY_CACHE_DIRECTORY}/${markerName}`, directory: Directory.Cache });
          cacheNames.delete(markerName);
        } catch (_error) {
          throw new Error('检测到上一次未确认的系统分享，暂不能重复打开分享面板。请先关闭可能仍打开的面板；若无法确认，请完全退出应用后重试。');
        }
      } else {
        throw new Error('检测到上一次未确认的系统分享，暂不能重复打开分享面板。请先关闭可能仍打开的面板；若无法确认，请完全退出应用后重试。');
      }
    }
    if (!pinned && now >= createdAt && now - createdAt > REPLAY_FILE_MAX_AGE_MS) {
      try {
        await Filesystem.deleteFile({ path, directory: Directory.Cache });
        continue;
      } catch (_error) {
        // Keep undeletable cache entries in the capacity calculation.
      }
    }
    const size = Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : REPLAY_CACHE_BYTES_LIMIT;
    ownedFiles.push({ name: entry.name, path, createdAt, size, pinned });
    cachedBytes += size;
  }
  for (const name of cacheNames) {
    const markerMatch = /^(replay-\d{13}-[a-f0-9]{32}\.json)\.active$/.exec(name);
    if (!markerMatch || cacheNames.has(markerMatch[1])) continue;
    try { await Filesystem.deleteFile({ path: `${REPLAY_CACHE_DIRECTORY}/${name}`, directory: Directory.Cache }); } catch (_error) {}
  }

  while (ownedFiles.length >= REPLAY_FILE_LIMIT || cachedBytes + payloadBytes > REPLAY_CACHE_BYTES_LIMIT) {
    const candidates = ownedFiles
      .filter((entry) => !entry.pinned && now >= entry.createdAt && now - entry.createdAt >= REPLAY_FILE_MIN_RETENTION_MS)
      .sort((left, right) => left.createdAt - right.createdAt);
    let evicted = false;
    for (const oldest of candidates) {
      try {
        await Filesystem.deleteFile({ path: oldest.path, directory: Directory.Cache });
        ownedFiles = ownedFiles.filter((entry) => entry.path !== oldest.path);
        cachedBytes -= oldest.size;
        evicted = true;
        break;
      } catch (_error) {
        ownedFiles = ownedFiles.map((entry) => entry.path === oldest.path ? { ...entry, pinned: true } : entry);
      }
    }
    if (!evicted) {
      throw new Error('棋谱分享缓存暂满（最多 32 个文件或 128 MiB）。请稍后重试；未确认的分享请先关闭面板，再重新导出。');
    }
  }
}

async function writeReplayShareFile(serialized, payloadBytes, operation) {
  const now = Date.now();
  await prepareReplayCache(payloadBytes, now);
  const filename = createReplayFileName(now);
  const path = `${REPLAY_CACHE_DIRECTORY}/${filename}`;
  operation.path = path;
  try {
    await Filesystem.writeFile({
      path,
      data: serialized,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    return await Filesystem.getUri({ path, directory: Directory.Cache });
  } catch (error) {
    try { await Filesystem.deleteFile({ path, directory: Directory.Cache }); } catch (_deleteError) {}
    operation.path = null;
    throw error;
  }
}

async function removeReplayFile(path) {
  if (!path) return;
  try { await Filesystem.deleteFile({ path, directory: Directory.Cache }); } catch (_error) {}
}

async function performReplayShare(serialized, payloadBytes, operation) {
  const saved = await writeReplayShareFile(serialized, payloadBytes, operation);
  if (operation.preparationExpired) {
    await removeReplayFile(operation.path);
    operation.path = null;
    throw new Error('棋谱准备分享超时，系统分享面板尚未打开。请勿重复导出；若一直无响应，请完全退出应用后重试。');
  }
  operation.markerPath = `${operation.path}.active`;
  try {
    await Filesystem.writeFile({
      path: operation.markerPath,
      data: 'active',
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  } catch (error) {
    await removeReplayFile(operation.markerPath);
    await removeReplayFile(operation.path);
    operation.path = null;
    operation.markerPath = null;
    throw error;
  }
  if (operation.preparationExpired) {
    await removeReplayFile(operation.markerPath);
    await removeReplayFile(operation.path);
    operation.path = null;
    operation.markerPath = null;
    throw new Error('棋谱准备分享超时，系统分享面板尚未打开。请勿重复导出；若一直无响应，请完全退出应用后重试。');
  }
  let sharePromise;
  try {
    sharePromise = Share.share({ title: 'LIFELINE replay', dialogTitle: 'Share replay', url: saved.uri });
  } catch (error) {
    operation.shareStarted = false;
    await removeReplayFile(operation.markerPath);
    operation.markerPath = null;
    throw error;
  }
  operation.shareStarted = true;
  operation.onShareStarted();
  try {
    const result = await sharePromise;
    const activityType = typeof result?.activityType === 'string' ? result.activityType.trim() : '';
    return activityType
      ? { status: 'selected', activityType }
      : { status: 'returned' };
  } catch (error) {
    if (isCancelledShare(error)) {
      await removeReplayFile(operation.markerPath);
      await removeReplayFile(operation.path);
      operation.path = null;
      operation.markerPath = null;
      return { status: 'cancelled' };
    }
    throw error;
  } finally {
    if (operation.shareStarted && operation.markerPath) {
      await removeReplayFile(operation.markerPath);
      operation.markerPath = null;
    }
    operation.shareSettled = true;
  }
}

function shareReplay(replayDocument) {
  let serialized;
  try {
    serialized = JSON.stringify(replayDocument);
    const document = JSON.parse(serialized);
    if (!document || Array.isArray(document) || typeof document !== 'object'
      || document.format !== 'lifeline-replay' || document.schemaVersion !== 1) {
      throw new Error('Unsupported replay document.');
    }
    const bytes = utf8ByteLength(serialized);
    if (bytes > REPLAY_JSON_LIMIT_BYTES) throw new Error('棋谱超过 4,000,000 字节分享上限，未写入缓存。');
  } catch (error) {
    return Promise.reject(error);
  }
  if (activeReplayShare) {
    if (activeReplayShare.phase === 'preparing' || activeReplayShare.phase === 'preparation-timeout') {
      return Promise.reject(new Error('棋谱仍在准备中，系统分享面板尚未打开。请勿重复导出；若一直无响应，请完全退出应用后重试。'));
    }
    return Promise.reject(new Error('上一次系统分享状态仍未确认，暂不能重复分享。请先关闭可能仍打开的分享面板；若无法确认，请完全退出应用后重试。'));
  }

  let preparationTimer = null;
  let resultTimer = null;
  let rejectPreparation;
  let rejectResult;
  const operation = {
    path: null,
    markerPath: null,
    phase: 'preparing',
    preparationExpired: false,
    shareStarted: false,
    shareSettled: false,
    onShareStarted() {
      operation.phase = 'sharing';
      if (preparationTimer !== null) globalThis.clearTimeout(preparationTimer);
      preparationTimer = null;
      resultTimer = globalThis.setTimeout(() => {
        operation.phase = 'result-unknown';
        rejectResult(new Error('分享面板关闭状态未确认，分享结果未知。面板可能仍打开；请先关闭面板，再重新导出。'));
      }, SHARE_RESULT_TIMEOUT_MS);
    },
  };
  activeReplayShare = operation;
  const payloadBytes = utf8ByteLength(serialized);
  const work = performReplayShare(serialized, payloadBytes, operation);
  void work.then(
    () => { if (activeReplayShare === operation) activeReplayShare = null; },
    () => { if ((!operation.shareStarted || operation.shareSettled) && activeReplayShare === operation) activeReplayShare = null; },
  );
  const preparationTimeout = new Promise((_, reject) => {
    rejectPreparation = reject;
    preparationTimer = globalThis.setTimeout(() => {
      if (operation.shareStarted) return;
      operation.preparationExpired = true;
      operation.phase = 'preparation-timeout';
      rejectPreparation(new Error('棋谱准备分享超时，系统分享面板尚未打开。请勿重复导出；若一直无响应，请完全退出应用后重试。'));
    }, SHARE_PREPARATION_TIMEOUT_MS);
  });
  const resultTimeout = new Promise((_, reject) => { rejectResult = reject; });
  return Promise.race([work, preparationTimeout, resultTimeout]).finally(() => {
    if (preparationTimer !== null) globalThis.clearTimeout(preparationTimer);
    if (resultTimer !== null) globalThis.clearTimeout(resultTimer);
  });
}

function reportStorageStatus(state, error = null, details = {}) {
  const status = { state, error, ...details };
  globalThis.__LIFELINE_STORAGE_STATUS__ = status;
  globalThis.dispatchEvent(new CustomEvent('lifeline:storage-status', { detail: status }));
}

function publishAppState(isActive) {
  const active = isActive === true;
  globalThis.__LIFELINE_APP_ACTIVE__ = active;
  globalThis.dispatchEvent(new CustomEvent(`lifeline:${active ? 'foreground' : 'background'}`));
}

export async function initializePlatform() {
  const native = Capacitor.isNativePlatform();
  globalThis.__LIFELINE_MOBILE_APP__ = true;
  if (native) {
    globalThis.__LIFELINE_APP_ACTIVE__ = false;
    let lifecycleGeneration = 0;
    await App.addListener('appStateChange', ({ isActive }) => {
      lifecycleGeneration += 1;
      publishAppState(isActive);
    });
    const generationAtSnapshot = lifecycleGeneration;
    const state = await App.getState();
    if (lifecycleGeneration === generationAtSnapshot) publishAppState(state?.isActive);
  } else {
    globalThis.__LIFELINE_APP_ACTIVE__ = true;
  }
  const nativeStorage = await initializeSessionAuthority({
    storage: globalThis.localStorage,
    eventTarget: globalThis,
    reportStatus: reportStorageStatus,
    native: native ? {
      load: (key = SESSION_KEY) => LifelineStorage.loadRecord({ key }),
      write: async (value, key = SESSION_KEY) => {
        const result = await LifelineStorage.saveRecord({ key, value });
        if (result?.durable !== true) throw new Error('Native storage did not confirm durable save.');
      },
    } : null,
  });
  const credentialAuthority = native ? createCredentialAuthority({
    storage: globalThis.localStorage,
    provider: {
      claim: (lease) => LifelineStorage.claimCredentialOwner({
        ...lease,
        documentChallenge: globalThis.__LIFELINE_DOCUMENT_CHALLENGE__ ?? '',
      }),
      load: (lease) => LifelineStorage.loadCredential(lease),
      save: (lease, credential) => LifelineStorage.saveCredential({ ...lease, credential }),
      clear: (lease) => LifelineStorage.clearCredential(lease),
    },
    onStatus: (status) => { globalThis.__LIFELINE_CREDENTIAL_STATUS__ = status; },
  }) : null;
  const replayImport = native ? createReplayImportClient({
    select: () => LifelineReplayImport.selectReplay(),
    getOwnerToken: () => globalThis.__LIFELINE_DOCUMENT_CHALLENGE__ ?? '',
  }) : null;
  if (credentialAuthority) await credentialAuthority.bootstrap();
  globalThis.LifelinePlatform = Object.freeze({
    isNative: native,
    storageTier: native ? 'atomic-file-and-webview' : 'webview-local-storage',
    contributionStartsEnabled: false,
    ...(native ? { flushSessionMirror: () => nativeStorage.flushSessionMirror() } : {}),
    ...(native ? {
      saveCredential: (credential) => credentialAuthority.save(credential),
      clearCredential: () => credentialAuthority.clear(),
      beginCredentialAttempt: () => credentialAuthority.beginAttempt(),
      isCredentialAttemptCurrent: (attempt) => credentialAuthority.isAttemptCurrent(attempt),
      retryCredentialStorage: () => credentialAuthority.retry(),
      getCredentialStorageState: () => credentialAuthority.getState(),
    } : {}),
    getCapabilities: native
      ? () => queryCapabilities({
        platform: 'android',
        source: 'android-native',
        read: () => LifelineCapabilities.getCapabilities({ schemaVersion: 1 }),
      })
      : () => Promise.resolve(createCapabilities({
        platform: 'browser',
        source: 'capacitor-webview-fallback',
        implementations: { sessionStorage: 'browser', replayImport: 'browser' },
      })),
    ...(native ? {
      requestMoveHaptic: async () => LifelineHaptics.requestMoveHaptic(),
      ...(() => {
        // Capacitor's remove() acknowledges only the JS proxy, not native listener
        // removal. Keep one plugin event listener for this page and route events
        // to the controller's current subscription token.
        let networkRoute = null;
        let networkEventListener = null;
        const listenNetworkEvents = () => {
          if (!networkEventListener) {
            networkEventListener = LifelineNetwork.addListener('networkStatusChange', (event) => {
              const route = networkRoute;
              if (route && event?.subscriptionId === route.token) route.notify(event?.status);
            }).catch((error) => {
              networkEventListener = null;
              throw error;
            });
          }
          return networkEventListener;
        };
        const networkStatus = createNetworkStatusController({
          source: 'android-native',
          getNativeStatus: () => LifelineNetwork.getNetworkStatus(),
          listenNative: async (notify, token) => {
            networkRoute = { notify, token };
            await listenNetworkEvents();
            return { remove: async () => { if (networkRoute?.token === token) networkRoute = null; } };
          },
          startNative: (subscriptionId) => LifelineNetwork.startNetworkStatus({ subscriptionId }),
          stopNative: (subscriptionId) => LifelineNetwork.stopNetworkStatus({ subscriptionId }),
        });
        return { getNetworkStatus: networkStatus.getStatus, subscribeNetworkStatus: networkStatus.subscribe };
      })(),
    } : {
      getNetworkStatus: async () => ({ schemaVersion: 1, source: 'browser', revision: 0, availability: 'unknown', validation: 'unknown', reason: 'browser-only' }),
      subscribeNetworkStatus: (listener) => {
        const unknown = { schemaVersion: 1, source: 'browser', revision: 0, availability: 'unknown', validation: 'unknown', reason: 'browser-only' };
        try { listener(unknown); } catch (_error) {}
        let active = true;
        return () => { active = false; };
      },
    }),
    ...(native ? {
      async getAppInfo() {
        const info = await App.getInfo();
        return {
          platform: Capacitor.getPlatform(),
          version: String(info?.version ?? ''),
          build: String(info?.build ?? ''),
        };
      },
      shareReplay,
      importReplay: () => replayImport.importReplay(),
      openTutorial: async (url) => {
        const result = await LifelineTutorialHost.openTutorial({ url });
        if (result?.status !== 'opened') throw new Error('Android tutorial host did not confirm opening.');
        return result;
      },
      moveToBackground: () => App.minimizeApp(),
    } : {}),
  });
}
