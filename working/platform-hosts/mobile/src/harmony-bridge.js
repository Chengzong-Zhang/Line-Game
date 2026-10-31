import { initializeSessionAuthority } from './session-authority.js';
import { createCapabilities, queryCapabilities } from './capability-contract.js';
import { createNetworkStatusController } from './network-status.js';
import { createCredentialAuthority } from './credential-authority.js';
import { createReplayImportClient } from './replay-import-client.js';

const SESSION_KEY = 'lifeline-local-game-session-v1';

function reportStorageStatus(state, error = null, details = {}) {
  const status = { state, error, ...details };
  globalThis.__LIFELINE_STORAGE_STATUS__ = status;
  globalThis.dispatchEvent(new CustomEvent('lifeline:storage-status', { detail: status }));
}

export async function initializePlatform() {
  globalThis.__LIFELINE_MOBILE_APP__ = true;
  if (!globalThis.LifelineBridge) {
    globalThis.__LIFELINE_APP_ACTIVE__ = true;
    globalThis.LifelinePlatform = Object.freeze({
      isNative: false,
      storageTier: 'webview-local-storage',
      contributionStartsEnabled: false,
      getCapabilities: () => Promise.resolve(createCapabilities({
        platform: 'browser',
        source: 'harmony-webview-fallback',
        implementations: { sessionStorage: 'browser', replayImport: 'browser' },
      })),
      getNetworkStatus: async () => ({ schemaVersion: 1, source: 'browser', revision: 0, availability: 'unknown', validation: 'unknown', reason: 'browser-only' }),
      subscribeNetworkStatus: (listener) => {
        try { listener({ schemaVersion: 1, source: 'browser', revision: 0, availability: 'unknown', validation: 'unknown', reason: 'browser-only' }); } catch (_error) {}
        return () => {};
      },
    });
    return;
  }
  if (typeof globalThis.__LIFELINE_APP_ACTIVE__ !== 'boolean') globalThis.__LIFELINE_APP_ACTIVE__ = false;
  const nativeStorage = await initializeSessionAuthority({
    storage: globalThis.localStorage,
    eventTarget: globalThis,
    reportStatus: reportStorageStatus,
    native: {
      load: (key = SESSION_KEY) => globalThis.LifelineBridge.loadRecord(key),
      write: async (value, key = SESSION_KEY) => {
        const result = await globalThis.LifelineBridge.saveRecord(key, value);
        if (result?.flushed !== true) throw new Error('HarmonyOS storage did not confirm a flushed save.');
      },
    },
  });
  const credentialAuthority = createCredentialAuthority({
    storage: globalThis.localStorage,
    provider: {
      claim: (lease) => globalThis.LifelineBridge.claimCredentialOwner({
        ...lease,
        documentChallenge: globalThis.__LIFELINE_DOCUMENT_CHALLENGE__ ?? '',
      }),
      load: (lease) => globalThis.LifelineBridge.loadCredential(lease),
      save: (lease, credential) => globalThis.LifelineBridge.saveCredential({ ...lease, credential }),
      clear: (lease) => globalThis.LifelineBridge.clearCredential(lease),
    },
    onStatus: (status) => { globalThis.__LIFELINE_CREDENTIAL_STATUS__ = status; },
  });
  await credentialAuthority.bootstrap();
  const replayImport = createReplayImportClient({
    select: () => globalThis.LifelineBridge.importReplay(),
    getOwnerToken: () => globalThis.__LIFELINE_DOCUMENT_CHALLENGE__ ?? '',
  });
  const networkStatus = createNetworkStatusController({
    source: 'harmony-native',
    getNativeStatus: () => globalThis.LifelineBridge?.getNetworkStatus?.(),
    listenNative: (notify, subscriptionId) => {
      const handler = (event) => {
        if (event?.detail?.subscriptionId === subscriptionId) notify(event.detail.status);
      };
      globalThis.addEventListener('lifeline:network-status', handler);
      return { remove: () => globalThis.removeEventListener('lifeline:network-status', handler) };
    },
    startNative: (subscriptionId) => globalThis.LifelineBridge?.startNetworkStatus?.(subscriptionId),
    stopNative: (subscriptionId) => globalThis.LifelineBridge?.stopNetworkStatus?.(subscriptionId),
  });
  globalThis.LifelinePlatform = Object.freeze({
    isNative: true,
    storageTier: 'arkts-preferences-flushed',
    contributionStartsEnabled: false,
    getCapabilities: () => queryCapabilities({
      platform: 'harmonyos',
      source: 'harmony-native',
      read: () => globalThis.LifelineBridge?.getCapabilities?.(),
    }),
    requestMoveHaptic: async () => {
      if (!globalThis.LifelineBridge?.requestMoveHaptic) throw new Error('Harmony haptics bridge is unavailable.');
      return globalThis.LifelineBridge.requestMoveHaptic();
    },
    flushSessionMirror: () => nativeStorage.flushSessionMirror(),
    saveCredential: (credential) => credentialAuthority.save(credential),
    clearCredential: () => credentialAuthority.clear(),
    beginCredentialAttempt: () => credentialAuthority.beginAttempt(),
    isCredentialAttemptCurrent: (attempt) => credentialAuthority.isAttemptCurrent(attempt),
    retryCredentialStorage: () => credentialAuthority.retry(),
    getCredentialStorageState: () => credentialAuthority.getState(),
    getNetworkStatus: networkStatus.getStatus,
    subscribeNetworkStatus: networkStatus.subscribe,
    async shareReplay(replayDocument) {
      if (!globalThis.LifelineBridge?.shareReplay) throw new Error('ArkTS share bridge is unavailable.');
      await globalThis.LifelineBridge.shareReplay(JSON.stringify(replayDocument));
    },
    importReplay: () => replayImport.importReplay(),
    openTutorial: async (targetUrl) => {
      if (!globalThis.LifelineBridge?.openTutorial) throw new Error('Harmony tutorial host is unavailable.');
      const result = await globalThis.LifelineBridge.openTutorial(targetUrl);
      if (result?.status !== 'opened') throw new Error('Harmony tutorial host did not confirm opening.');
      return result;
    },
    async getAppInfo() {
      if (!globalThis.LifelineBridge?.getAppInfo) throw new Error('HarmonyOS app metadata bridge is unavailable.');
      const info = await globalThis.LifelineBridge.getAppInfo();
      return { platform: 'harmonyos', version: String(info?.version ?? ''), build: String(info?.build ?? '') };
    },
    async moveToBackground() {
      if (!globalThis.LifelineBridge?.moveToBackground) throw new Error('HarmonyOS background bridge is unavailable.');
      await globalThis.LifelineBridge.moveToBackground();
    },
  });
}
