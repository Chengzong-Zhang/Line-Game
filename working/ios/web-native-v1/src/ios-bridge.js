import { Capacitor, registerPlugin } from '@capacitor/core';
import { createCapabilities, queryCapabilities } from './capability-contract.js';
import { createReplayImportClient } from './replay-import-client.js';
import { initializeSessionAuthority } from './session-authority.js';
import { createNetworkStatusController } from './network-status.js';
import { createCredentialAuthority } from './credential-authority.js';
import { createIOSCredentialRecovery } from './ios-credential-recovery.js';
import { claimIOSDocument } from './ios-document-lease.js';
import { startIOSLifecyclePolling, createIOSNetworkPolling } from './ios-polling.js';

const LifelineIOS = registerPlugin('LifelineIOS');
const LifelineStorage = registerPlugin('LifelineStorage');
const LifelineCapabilities = registerPlugin('LifelineCapabilities');
const LifelineNetwork = registerPlugin('LifelineNetwork');
const LifelineReplayImport = registerPlugin('LifelineReplayImport');
const LifelineHaptics = registerPlugin('LifelineHaptics');
const LifelineTutorialHost = registerPlugin('LifelineTutorialHost');
const SESSION_KEY = 'lifeline-local-game-session-v1';
async function shareReplay(replayDocument, documentLease) {
  const serialized = JSON.stringify(replayDocument);
  const value = JSON.parse(serialized);
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || value.format !== 'lifeline-replay' || value.schemaVersion !== 1) {
    throw new Error('Unsupported replay document.');
  }
  if (new TextEncoder().encode(serialized).length > 4_000_000) {
    throw new Error('棋谱超过 4,000,000 字节分享上限。');
  }
  const result = await LifelineIOS.shareReplay({ replayDocument: value, documentLease });
  if (result?.status !== 'returned' && result?.status !== 'cancelled') {
    throw new Error('iOS share result was not confirmed.');
  }
  return { status: result.status };
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
  const documentLease = native ? await claimIOSDocument(LifelineStorage) : null;
  if (native) {
    globalThis.__LIFELINE_APP_ACTIVE__ = false;
    await startIOSLifecyclePolling({
      read: () => LifelineIOS.getAppState({ documentLease }),
      publish: publishAppState,
      eventTarget: globalThis.document,
      pageTarget: globalThis,
    });
  } else {
    globalThis.__LIFELINE_APP_ACTIVE__ = true;
  }
  const nativeStorage = await initializeSessionAuthority({
    storage: globalThis.localStorage,
    eventTarget: globalThis,
    reportStatus: reportStorageStatus,
    native: native ? {
      load: (key = SESSION_KEY) => LifelineStorage.loadRecord({ key, documentLease }),
      write: async (value, key = SESSION_KEY) => {
        const result = await LifelineStorage.saveRecord({ key, value, documentLease });
        if (result?.durable !== true) throw new Error('Native storage did not confirm durable save.');
      },
    } : null,
  });
  let credentialAuthority;
  const credentialRecovery = native ? createIOSCredentialRecovery({
    document: globalThis.document, confirm: globalThis.confirm.bind(globalThis),
    language: globalThis.navigator?.language, getAuthority: () => credentialAuthority,
  }) : null;
  credentialAuthority = native ? createCredentialAuthority({
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
    onStatus: (status) => { globalThis.__LIFELINE_CREDENTIAL_STATUS__ = status; credentialRecovery.update(status); },
  }) : null;
  const replayImport = native ? createReplayImportClient({
    select: () => LifelineReplayImport.selectReplay({ documentLease }),
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
        platform: 'ios',
        source: 'ios-native',
        read: () => LifelineCapabilities.getCapabilities({ schemaVersion: 1 }),
      })
      : () => Promise.resolve(createCapabilities({
        platform: 'browser',
        source: 'capacitor-webview-fallback',
        implementations: { sessionStorage: 'browser', replayImport: 'browser' },
      })),
    ...(native ? {
      requestMoveHaptic: async () => LifelineHaptics.requestMoveHaptic({ documentLease }),
      ...(() => {
        const readNetwork = () => LifelineNetwork.getNetworkStatus({ documentLease });
        const listenNetwork = createIOSNetworkPolling({ read: readNetwork });
        const networkStatus = createNetworkStatusController({
          source: 'ios-native',
          getNativeStatus: readNetwork,
          listenNative: listenNetwork,
          startNative: (subscriptionId) => LifelineNetwork.startNetworkStatus({ subscriptionId, documentLease }),
          stopNative: (subscriptionId) => LifelineNetwork.stopNetworkStatus({ subscriptionId, documentLease }),
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
        const info = await LifelineIOS.getAppInfo();
        return {
          platform: Capacitor.getPlatform(),
          version: String(info?.version ?? ''),
          build: String(info?.build ?? ''),
        };
      },
      shareReplay: (document) => shareReplay(document, documentLease),
      importReplay: () => replayImport.importReplay(),
      openTutorial: async (url) => {
        const result = await LifelineTutorialHost.openTutorial({ url, documentLease });
        if (result?.status !== 'opened') throw new Error('iOS tutorial host did not confirm opening.');
        return result;
      },
    } : {}),
  });
}
