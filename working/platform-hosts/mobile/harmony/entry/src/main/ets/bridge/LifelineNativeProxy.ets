import { preferences, uniformTypeDescriptor as utd } from '@kit.ArkData';
import { webview } from '@kit.ArkWeb';
import { bundleManager, common } from '@kit.AbilityKit';
import { fileIo, fileUri, picker } from '@kit.CoreFileKit';
import { systemShare } from '@kit.ShareKit';
import { url, util } from '@kit.ArkTS';
import { vibrator } from '@kit.SensorServiceKit';
import { huks } from '@kit.UniversalKeystoreKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { NetworkStatusMonitor, NetworkStatusSnapshot } from './NetworkStatusMonitor';
import { WebControllerRegistry } from './WebControllerRegistry';

const SESSION_KEY: string = 'lifeline-local-game-session-v1';
const TOPOLOGY_SESSION_KEY: string = 'lifeline-topology-local-game-session-v1';
const CREDENTIAL_KEY: string = 'lifeline-credential-ciphertext-v1';
const CREDENTIAL_BARRIER_KEY: string = 'lifeline-credential-barrier-v1';
const CREDENTIAL_KEY_ALIAS: string = 'lifeline.credentials.v1';
const TOMBSTONE: string = '__lifeline_native_session_cleared_v1__';
const SESSION_READ_SENTINEL: string = '__lifeline_native_session_read_sentinel_7f3a91c2__';
const TRUSTED_ORIGIN: string = 'https://lifeline.appassets.invalid';
const SHARE_DIRECTORY: string = 'lifeline-replay-share';
const SHARE_FILE_LIMIT: number = 32;
const SHARE_CACHE_TOTAL_BYTES_LIMIT: number = 128 * 1024 * 1024;
// Files expire after 24 hours; pressure eviction requires one hour and excludes active/unknown shares.
const SHARE_FILE_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;
const SHARE_FILE_MIN_RETENTION_MS: number = 60 * 60 * 1000;
const SHARE_JSON_LIMIT_BYTES: number = 4_000_000;
const REPLAY_IMPORT_LIMIT_BYTES: number = 4_000_000;
const SHARE_OPEN_TIMEOUT_MS: number = 30_000;
const SHARE_DISMISS_TIMEOUT_MS: number = 9 * 60 * 1000;

interface ReplayDocument {
  format?: string;
  schemaVersion?: number;
}

interface CachedReplayFile {
  name: string;
  createdAt: number;
  size: number;
  pinned: boolean;
}

interface NativeResult {
  value?: string | null;
  flushed?: boolean;
  status?: string;
  schemaVersion?: number;
  source?: string;
  revision?: number;
  availability?: string;
  validation?: string;
  state?: string;
  credential?: Object;
  pageEpoch?: number;
  ownerGeneration?: number;
  documentNonce?: string;
  durable?: boolean;
  text?: string;
}

interface NativeReply {
  ok: boolean;
  result?: NativeResult;
  error?: string;
}

interface SessionSnapshot {
  exists: boolean;
  value: string;
}

interface NativeCapability {
  support: string;
  implementation: string;
}

function unicodeCodePointCount(value: string): number {
  let count: number = 0;
  for (let index: number = 0; index < value.length; index++) {
    const code: number = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
      const next: number = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) index++;
    }
    count++;
  }
  return count;
}

interface NativeCapabilities {
  sessionStorage: NativeCapability;
  credentialStorage: NativeCapability;
  replayShare: NativeCapability;
  replayImport: NativeCapability;
  tutorialHost: NativeCapability;
  appInfo: NativeCapability;
  background: NativeCapability;
  backEvents: NativeCapability;
  appLifecycle: NativeCapability;
  systemNetwork: NativeCapability;
  haptics: NativeCapability;
  channelLogin: NativeCapability;
  realName: NativeCapability;
}

function toHex(data: Uint8Array): string {
  let result: string = '';
  for (let i: number = 0; i < data.length; i++) result += data[i].toString(16).padStart(2, '0');
  return result;
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) throw new Error('Invalid credential envelope.');
  const result: Uint8Array = new Uint8Array(value.length / 2);
  for (let i: number = 0; i < result.length; i++) result[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

function generateNonce(): Uint8Array {
  const random = cryptoFramework.createRandom();
  return random.generateRandomSync(12).data;
}

function aesProperties(purpose: number, nonce: Uint8Array, tag?: Uint8Array): Array<huks.HuksParam> {
  const properties: Array<huks.HuksParam> = [
    { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
    { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
    { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: purpose },
    { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
    { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
    { tag: huks.HuksTag.HUKS_TAG_NONCE, value: nonce },
    { tag: huks.HuksTag.HUKS_TAG_ASSOCIATED_DATA, value: util.TextEncoder.create('utf-8').encodeInto('lifeline-credential-v1') },
  ];
  if (tag) properties.push({ tag: huks.HuksTag.HUKS_TAG_AE_TAG, value: tag });
  return properties;
}

async function ensureCredentialKey(): Promise<void> {
  const exists = await huks.isKeyItemExist(CREDENTIAL_KEY_ALIAS, { properties: [] });
  if (exists) return;
  const options: huks.HuksOptions = { properties: [
    { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
    { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
    { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
  ] };
  await huks.generateKeyItem(CREDENTIAL_KEY_ALIAS, options);
}

async function encryptCredential(value: string): Promise<string> {
  await ensureCredentialKey();
  const nonce = generateNonce();
  if (nonce.length !== 12) throw new Error('Credential nonce generation failed.');
  const options: huks.HuksOptions = { properties: aesProperties(huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT, nonce), inData: util.TextEncoder.create('utf-8').encodeInto(value) };
  let handle: number = -1;
  try {
    const initialized = await huks.initSession(CREDENTIAL_KEY_ALIAS, options);
    handle = initialized.handle;
    const finished = await huks.finishSession(handle, options);
    const encrypted = finished.outData as Uint8Array;
    if (encrypted.length < 16) throw new Error('Credential encryption failed.');
    return JSON.stringify({ nonce: toHex(nonce), data: toHex(encrypted) });
  } catch (_error) {
    if (handle >= 0) { try { await huks.abortSession(handle, { properties: [] }); } catch (_abortError) {} }
    throw new Error('Credential encryption failed.');
  }
}

async function decryptCredential(envelopeText: string): Promise<string> {
  const envelope = JSON.parse(envelopeText) as Record<string, Object>;
  if (Object.keys(envelope).length !== 2 || typeof envelope['nonce'] !== 'string' || typeof envelope['data'] !== 'string') throw new Error('Invalid credential envelope.');
  const nonce = fromHex(envelope['nonce'] as string), encrypted = fromHex(envelope['data'] as string);
  if (nonce.length !== 12 || encrypted.length < 16 || encrypted.length > 65_536) throw new Error('Invalid credential envelope.');
  const exists = await huks.isKeyItemExist(CREDENTIAL_KEY_ALIAS, { properties: [] });
  if (!exists) throw new Error('Credential key is unavailable.');
  const tag = encrypted.slice(encrypted.length - 16);
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const options: huks.HuksOptions = { properties: aesProperties(huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT, nonce, tag), inData: ciphertext };
  let handle: number = -1;
  try {
    const initialized = await huks.initSession(CREDENTIAL_KEY_ALIAS, options);
    handle = initialized.handle;
    const finished = await huks.finishSession(handle, options);
    return util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(finished.outData as Uint8Array);
  } catch (_error) {
    if (handle >= 0) { try { await huks.abortSession(handle, { properties: [] }); } catch (_abortError) {} }
    throw new Error('Credential decryption failed.');
  }
}

function utf8ByteLength(value: string): number {
  let bytes: number = 0;
  for (let index: number = 0; index < value.length; index += 1) {
    const code: number = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next: number = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export class LifelineNativeProxy {
  private static queue: Promise<void> = Promise.resolve();
  private static sessionRecoveryRequired: Set<string> = new Set<string>();
  private static credentialQueue: Promise<void> = Promise.resolve();
  private static credentialRecoveryRequired: boolean = false;
  private static activeShareIds: Set<string> = new Set<string>();
  private static activeImportId: string = '';
  private get activeShareIds(): Set<string> { return LifelineNativeProxy.activeShareIds; }
  private get activeImportId(): string { return LifelineNativeProxy.activeImportId; }
  private set activeImportId(value: string) { LifelineNativeProxy.activeImportId = value; }
  private readonly requestGenerations: Map<string, number> = new Map<string, number>();
  private readonly multiReplyRequests: Set<string> = new Set<string>();
  private activeShareFiles: Set<string> = new Set<string>();
  private static hapticInFlight: boolean = false;
  private readonly store: preferences.Preferences;
  private readonly controller: webview.WebviewController;
  private readonly context: common.UIAbilityContext;
  private readonly currentGeneration: () => number;
  private readonly openTutorialHost: (targetUrl: string) => boolean;

  constructor(
    store: preferences.Preferences,
    controller: webview.WebviewController,
    context: common.UIAbilityContext,
    currentGeneration: () => number = () => 0,
    openTutorialHost: (targetUrl: string) => boolean = (_targetUrl: string) => false
  ) {
    this.store = store;
    this.controller = controller;
    this.context = context;
    this.currentGeneration = currentGeneration;
    this.openTutorialHost = openTutorialHost;
  }

  callNative(requestId: string, operation: string, key: string, value: string): void {
    if (!new RegExp('^[a-f0-9]{16}\\.[0-9]{1,12}$').test(requestId)) return;
    if (!this.isTrustedCallingFrame()) {
      console.warn('Rejected native bridge call from an untrusted WebView frame.');
      return;
    }
    const acceptedGeneration = this.currentGeneration();
    if (acceptedGeneration < 0) return;
    this.requestGenerations.set(requestId, acceptedGeneration);
    if (operation === 'getNetworkStatus' || operation === 'startNetworkStatus' || operation === 'stopNetworkStatus') {
      if ((operation === 'getNetworkStatus' && (key !== '' || value !== ''))
        || (operation !== 'getNetworkStatus' && (key !== '' || !new RegExp('^[a-f0-9]{16}\\.[0-9]{1,12}$').test(value)))) {
        this.reply(requestId, { ok: false, error: 'Invalid network status request.' });
        return;
      }
      const pageNonce = requestId.split('.')[0];
      const subscriptionId = value;
      const generation = this.currentGeneration();
      void this.executeNetworkStatus(operation, pageNonce, subscriptionId, generation).then(
        (result: NetworkStatusSnapshot | null) => this.reply(requestId, { ok: true, result: result as NativeResult }),
        () => this.reply(requestId, { ok: false, error: 'Network status operation failed.' })
      );
      return;
    }
    if (operation === 'requestMoveHaptic') {
      if (key !== '' || value !== '') {
        this.reply(requestId, { ok: false, error: 'Invalid haptics request.' });
        return;
      }
      if (LifelineNativeProxy.hapticInFlight) {
        this.reply(requestId, { ok: true, result: { status: 'suppressed' } });
        return;
      }
      LifelineNativeProxy.hapticInFlight = true;
      const generation = this.currentGeneration();
      void this.executeMoveHaptic(generation).then(
        (result: NativeResult) => this.reply(requestId, { ok: true, result }),
        (_error: Error) => this.reply(requestId, { ok: true, result: { status: 'suppressed' } })
      ).finally(() => {
        LifelineNativeProxy.hapticInFlight = false;
      });
      return;
    }
    if (operation === 'openTutorial') {
      const generation = this.currentGeneration();
      try {
        const source = new url.URL(this.controller.getUrl());
        const target = new url.URL(value);
        const tutorialValues = target.searchParams.getAll('tutorial');
        if (key !== '' || generation < 0 || !WebControllerRegistry.isForeground()
          || !WebControllerRegistry.isCurrentGeneration(this.controller, generation)
          || source.origin !== TRUSTED_ORIGIN || source.username !== '' || source.password !== ''
          || target.protocol !== 'https:' || target.origin !== TRUSTED_ORIGIN
          || target.username !== '' || target.password !== ''
          || !['/', '/index.html'].includes(target.pathname)
          || target.hash !== '' || target.searchParams.toString() !== 'tutorial=1'
          || tutorialValues.length !== 1 || tutorialValues[0] !== '1') {
          this.reply(requestId, { ok: false, error: 'The tutorial URL is not allowed.' });
          return;
        }
        if (!this.openTutorialHost(target.href)) throw new Error('Tutorial overlay is unavailable.');
        if (!WebControllerRegistry.isCurrentGeneration(this.controller, generation)) return;
        this.reply(requestId, { ok: true, result: { status: 'opened' } });
      } catch (_error) {
        this.reply(requestId, { ok: false, error: 'The tutorial page could not be opened.' });
      }
      return;
    }
    if (operation === 'shareReplay') {
      this.multiReplyRequests.add(requestId);
      if (this.activeShareIds.size >= 1) {
        this.multiReplyRequests.delete(requestId);
        this.reply(requestId, {
          ok: false,
          error: '系统分享状态仍未确认。请先关闭分享面板；若仍无法导出，请完全退出应用后重试。'
        });
        return;
      }
      this.activeShareIds.add(requestId);
      void this.executeShareReplay(requestId, value).catch((error: Error) => {
        this.activeShareIds.delete(requestId);
        this.reply(requestId, { ok: false, error: error.message });
      }).finally(() => {
        this.multiReplyRequests.delete(requestId);
        this.requestGenerations.delete(requestId);
      });
      return;
    }
    if (operation === 'importReplay') {
      if (key !== '' || value !== '') {
        this.reply(requestId, { ok: false, error: 'Invalid replay import request.' });
        return;
      }
      if (this.activeImportId !== '') {
        this.reply(requestId, { ok: false, error: 'Replay file selection is already active.' });
        return;
      }
      const generation = this.currentGeneration();
      if (generation < 0) return;
      this.activeImportId = requestId;
      void this.executeImportReplay(generation).then((result: NativeResult) => {
        if (this.activeImportId !== requestId || !WebControllerRegistry.isCurrentGeneration(this.controller, generation)) return;
        this.reply(requestId, { ok: true, result });
      }, () => {
        if (this.activeImportId !== requestId || !WebControllerRegistry.isCurrentGeneration(this.controller, generation)) return;
        this.reply(requestId, { ok: false, error: 'Could not read the selected replay file. Please choose it again.' });
      }).finally(() => {
        if (this.activeImportId === requestId) this.activeImportId = '';
        this.requestGenerations.delete(requestId);
      });
      return;
    }
    if (operation === 'getAppInfo' || operation === 'getCapabilities') {
      const run: Promise<string> = this.executeReadOnly(operation, key, value);
      void run.then(
        (result: string) => this.reply(requestId, { ok: true, result: JSON.parse(result) as NativeResult }),
        (error: Error) => this.reply(requestId, { ok: false, error: error.message })
      );
      return;
    }
    if (['claimCredentialOwner', 'loadCredential', 'saveCredential', 'clearCredential'].includes(operation)) {
      if (key !== '') { this.reply(requestId, { ok: false, error: 'Invalid credential request.' }); return; }
      const requestEpoch = WebControllerRegistry.credentialEpoch(this.controller);
      if (operation === 'claimCredentialOwner') {
        try {
          const input = JSON.parse(value) as Record<string, Object>;
          const expected = input['expectedOwnerGeneration'];
          const challenge = input['documentChallenge'];
          if (Object.keys(input).length !== 2 || typeof expected !== 'number' || typeof challenge !== 'string' || challenge.length < 32) throw new Error('invalid');
          void this.verifyCurrentDocumentChallenge(requestEpoch, challenge).then((verified: boolean) => {
            if (!verified) throw new Error('stale');
            const owner = WebControllerRegistry.claimCredentialOwner(this.controller, requestEpoch, challenge, expected);
            if (owner < 0) throw new Error('stale');
            const claimResult: NativeResult = {
              pageEpoch: requestEpoch,
              ownerGeneration: owner,
              documentNonce: WebControllerRegistry.credentialNonce(this.controller),
            };
            const reply: NativeReply = { ok: true, result: claimResult };
            this.reply(requestId, reply);
          }).catch(() => this.reply(requestId, { ok: false, error: 'Credential owner claim failed.' }));
        } catch (_error) { this.reply(requestId, { ok: false, error: 'Credential owner claim failed.' }); }
        return;
      }
      const operationPromise = LifelineNativeProxy.credentialQueue.then(() => this.executeCredential(operation, value, requestEpoch));
      LifelineNativeProxy.credentialQueue = operationPromise.then(() => undefined, () => undefined);
      void operationPromise.then(
        (result: string) => this.reply(requestId, { ok: true, result: JSON.parse(result) as NativeResult }),
        () => this.reply(requestId, { ok: false, error: operation === 'clearCredential' ? 'Credential clear barrier failed.' : 'Credential operation failed.' })
      );
      return;
    }
    const requestGeneration = acceptedGeneration;
    const run: Promise<string> = LifelineNativeProxy.queue.then(() => this.execute(operation, key, value, requestGeneration));
    LifelineNativeProxy.queue = run.then(() => undefined, () => undefined);
    void run.then(
      (result: string) => this.reply(requestId, { ok: true, result: JSON.parse(result) as NativeResult }),
      (error: Error) => this.reply(requestId, { ok: false, error: error.message })
    ).finally(() => this.requestGenerations.delete(requestId));
  }

  private async executeNetworkStatus(operation: string, pageNonce: string, subscriptionId: string, generation: number): Promise<NetworkStatusSnapshot | null> {
    if (operation === 'getNetworkStatus') return generation < 0 ? NetworkStatusMonitor.unknown() : NetworkStatusMonitor.getStatus();
    if (operation === 'stopNetworkStatus') {
      await NetworkStatusMonitor.stop(pageNonce, subscriptionId);
      return null;
    }
    if (generation < 0) throw new Error('Web page is no longer active.');
    return NetworkStatusMonitor.start(pageNonce, subscriptionId, (status, nonce, id) => {
      if (nonce !== pageNonce || id !== subscriptionId || !WebControllerRegistry.isCurrentGeneration(this.controller, generation)) return;
      const eventJson: string = JSON.stringify({ pageNonce: nonce, subscriptionId: id, status });
      const script: string = `globalThis.__lifelineNetworkStatusEvent?.(${JSON.stringify(eventJson)})`;
      void this.controller.runJavaScript(script).catch(() => {});
    }, () => WebControllerRegistry.isCurrentGeneration(this.controller, generation));
  }

  private async verifyCurrentDocumentChallenge(requestEpoch: number, requestedChallenge: string): Promise<boolean> {
    const beforeUrl = this.controller.getUrl();
    if (!beforeUrl || new url.URL(beforeUrl).origin !== TRUSTED_ORIGIN) return false;
    const rawResult = await this.controller.runJavaScript("String(globalThis.__LIFELINE_DOCUMENT_CHALLENGE__||'')");
    const challenge = String(rawResult).replace(/^['\"]|['\"]$/g, '');
    const afterUrl = this.controller.getUrl();
    return challenge === requestedChallenge && beforeUrl === afterUrl
      && new url.URL(afterUrl).origin === TRUSTED_ORIGIN
      && WebControllerRegistry.credentialEpoch(this.controller) === requestEpoch;
  }

  private async executeReadOnly(operation: string, key: string, value: string): Promise<string> {
    if (key !== '') throw new Error('Invalid read-only request.');
    if (operation === 'getAppInfo') {
      if (value !== '') throw new Error('Invalid app info request.');
      const info = await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      return JSON.stringify({ version: info.versionName ?? '', build: String(info.versionCode ?? '') });
    }
    if (operation === 'getCapabilities') {
      if (value !== '{"schemaVersion":1}') throw new Error('Unsupported capability schema version.');
      const capability = (support: string, implementation: string): NativeCapability => ({ support, implementation });
      const capabilities: NativeCapabilities = {
        sessionStorage: capability('implemented', 'native'),
        credentialStorage: capability('implemented', 'native'),
        replayShare: capability('implemented', 'native'),
        replayImport: capability('implemented', 'native'),
        tutorialHost: capability('implemented', 'native'),
        appInfo: capability('implemented', 'native'),
        background: capability('implemented', 'native'),
        backEvents: capability('implemented', 'native'),
        appLifecycle: capability('implemented', 'native'),
        systemNetwork: capability('implemented', 'native'),
        haptics: capability('implemented', 'native'),
        channelLogin: capability('not-implemented', 'none'),
        realName: capability('not-implemented', 'none'),
      };
      return JSON.stringify({
        schemaVersion: 1,
        platform: 'harmonyos',
        source: 'harmony-native',
        capabilities,
      });
    }
    throw new Error('Unsupported read-only operation.');
  }

  private isTrustedCallingFrame(): boolean {
    try {
      const frame = new url.URL(this.controller.getLastJavascriptProxyCallingFrameUrl());
      return frame.protocol === 'https:' && frame.origin === TRUSTED_ORIGIN
        && frame.username === '' && frame.password === '';
    } catch (_error) {
      return false;
    }
  }

  private async executeMoveHaptic(generation: number): Promise<NativeResult> {
    if (generation < 0 || !WebControllerRegistry.isForeground()
      || !WebControllerRegistry.isCurrentGeneration(this.controller, generation)) {
      return { status: 'suppressed' };
    }
    await vibrator.startVibration({ type: 'time', duration: 24 }, { usage: 'touch' });
    return { status: 'requested' };
  }

  private async executeImportReplay(generation: number): Promise<NativeResult> {
    const documentPicker = new picker.DocumentViewPicker(this.context);
    let selectedUris: Array<string>;
    try {
      selectedUris = await documentPicker.select({ fileSuffixFilters: ['.json'], maxSelectNumber: 1 });
    } catch (_error) {
      throw new Error('Replay file selection failed.');
    }
    if (!WebControllerRegistry.isCurrentGeneration(this.controller, generation)) throw new Error('Replay owner changed.');
    if (!selectedUris || selectedUris.length === 0) return { status: 'cancelled' };
    if (selectedUris.length !== 1 || typeof selectedUris[0] !== 'string' || selectedUris[0].length === 0) {
      throw new Error('Replay selection was invalid.');
    }

    let file: fileIo.File | null = null;
    try {
      const metadata = await fileIo.stat(selectedUris[0]);
      if (!Number.isFinite(metadata.size) || metadata.size < 0) throw new Error('Replay file size was unavailable.');
      if (metadata.size > REPLAY_IMPORT_LIMIT_BYTES) return { status: 'too-large' };
      file = await fileIo.open(selectedUris[0], fileIo.OpenMode.READ_ONLY);
      const bytes = new Uint8Array(REPLAY_IMPORT_LIMIT_BYTES + 1);
      let total: number = 0;
      while (total <= REPLAY_IMPORT_LIMIT_BYTES) {
        const chunkLength: number = Math.min(64 * 1024, REPLAY_IMPORT_LIMIT_BYTES + 1 - total);
        const chunk = new ArrayBuffer(chunkLength);
        const readCount: number = await fileIo.read(file.fd, chunk, { offset: total, length: chunkLength });
        if (readCount === 0) break;
        if (total + readCount > REPLAY_IMPORT_LIMIT_BYTES) return { status: 'too-large' };
        bytes.set(new Uint8Array(chunk, 0, readCount), total);
        total += readCount;
      }
      if (!WebControllerRegistry.isCurrentGeneration(this.controller, generation)) throw new Error('Replay owner changed.');
      const text: string = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(bytes.slice(0, total));
      return { status: 'selected', text };
    } finally {
      if (file !== null) {
        try { await fileIo.close(file.fd); } catch (_closeError) {}
      }
    }
  }

  private async execute(operation: string, key: string, value: string, requestGeneration: number): Promise<string> {
    if (!this.isCurrentRequest(requestGeneration)) throw new Error('The page changed before the native request could run.');
    if (operation === 'moveToBackground') {
      if (key !== '' || value !== '') throw new Error('Invalid background request.');
      if (requestGeneration < 0 || this.currentGeneration() !== requestGeneration) {
        throw new Error('The page changed before the background request could run.');
      }
      await this.context.moveAbilityToBackground();
      return JSON.stringify({ moved: true });
    }
    if (!['loadRecord', 'saveRecord', 'removeRecord'].includes(operation)) throw new Error('Invalid native operation.');
    if (key !== SESSION_KEY && key !== TOPOLOGY_SESSION_KEY) throw new Error('Unsupported session key.');
    if (LifelineNativeProxy.sessionRecoveryRequired.has(key)) throw new Error('Saved-game storage requires recovery; restart the app before continuing.');

    if (operation === 'loadRecord') {
      const stored = await this.readSessionValue(key);
      if (!this.isCurrentRequest(requestGeneration)) throw new Error('The page changed while reading the saved game.');
      return JSON.stringify({ value: stored.value.length === 0 || stored.value === TOMBSTONE ? null : stored.value });
    }

    if (operation === 'saveRecord') {
      const previous = await this.readSessionValue(key);
      if (!this.isCurrentRequest(requestGeneration)) throw new Error('The page changed before saving the game.');
      if (typeof value !== 'string' || value.length === 0 || value.length > 5_000_000) {
        throw new Error('Native session payload is empty or too large.');
      }
      JSON.parse(value);
      if (!this.isCurrentRequest(requestGeneration)) throw new Error('The page changed before saving the game.');
      await this.store.put(key, value);
      if (!this.isCurrentRequest(requestGeneration)) {
        await this.rollbackSessionMutation(key, previous);
        throw new Error('The page changed while saving the game.');
      }
      await this.store.flush();
      if (!this.isCurrentRequest(requestGeneration)) {
        await this.rollbackSessionMutation(key, previous);
        throw new Error('The page changed while saving the game.');
      }
      let cached: SessionSnapshot;
      try { cached = await this.readSessionValue(key); } catch (_error) {
        await this.rollbackSessionMutation(key, previous);
        throw new Error('Saved-game verification failed after the page changed.');
      }
      if (!this.isCurrentRequest(requestGeneration)) {
        await this.rollbackSessionMutation(key, previous);
        throw new Error('The page changed while verifying the saved game.');
      }
      if (!cached.exists || cached.value !== value) throw new Error('Native session cache consistency check failed after flush.');
      return JSON.stringify({ flushed: true });
    }

    if (operation === 'removeRecord') {
      const previous = await this.readSessionValue(key);
      if (!this.isCurrentRequest(requestGeneration)) throw new Error('The page changed before clearing the saved game.');
      await this.store.put(key, TOMBSTONE);
      if (!this.isCurrentRequest(requestGeneration)) {
        await this.rollbackSessionMutation(key, previous);
        throw new Error('The page changed while clearing the saved game.');
      }
      await this.store.flush();
      if (!this.isCurrentRequest(requestGeneration)) {
        await this.rollbackSessionMutation(key, previous);
        throw new Error('The page changed while clearing the saved game.');
      }
      let cached: SessionSnapshot;
      try { cached = await this.readSessionValue(key); } catch (_error) {
        await this.rollbackSessionMutation(key, previous);
        throw new Error('Saved-game clear verification failed after the page changed.');
      }
      if (!this.isCurrentRequest(requestGeneration)) {
        await this.rollbackSessionMutation(key, previous);
        throw new Error('The page changed while verifying the cleared game.');
      }
      if (!cached.exists || cached.value !== TOMBSTONE) throw new Error('Native clear cache consistency check failed after flush.');
      return JSON.stringify({ flushed: true });
    }

    throw new Error('Unsupported native storage operation.');
  }

  private async readSessionValue(key: string): Promise<SessionSnapshot> {
    const exists = await this.store.has(key);
    if (typeof exists !== 'boolean') throw new Error('Native session presence has an invalid type.');
    if (!exists) return { exists: false, value: '' };
    const stored = await this.store.get(key, SESSION_READ_SENTINEL);
    if (typeof stored !== 'string' || stored === SESSION_READ_SENTINEL) {
      throw new Error('Native session value has an invalid type or could not be read.');
    }
    return { exists: true, value: stored };
  }

  private async rollbackSessionMutation(key: string, previous: SessionSnapshot): Promise<void> {
    try {
      if (previous.exists) await this.store.put(key, previous.value);
      else await this.store.delete(key);
      await this.store.flush();
      const restored = await this.readSessionValue(key);
      if (restored.exists !== previous.exists || (previous.exists && restored.value !== previous.value)) {
        throw new Error('readback mismatch');
      }
    } catch (_error) {
      LifelineNativeProxy.sessionRecoveryRequired.add(key);
      throw new Error('Saved-game rollback failed. Restart the app before using this session again.');
    }
  }

  private async executeCredential(operation: string, value: string, requestEpoch: number): Promise<string> {
    const input = JSON.parse(value) as Record<string, Object>;
    const pageEpoch = input['pageEpoch'];
    const ownerGeneration = input['ownerGeneration'];
    const documentNonce = input['documentNonce'];
    const expectedKeys: Array<string> = operation === 'saveCredential'
      ? ['pageEpoch', 'ownerGeneration', 'documentNonce', 'credential']
      : ['pageEpoch', 'ownerGeneration', 'documentNonce'];
    if (Object.keys(input).length !== expectedKeys.length
      || Object.keys(input).some((key) => !expectedKeys.includes(key))
      || typeof pageEpoch !== 'number' || typeof ownerGeneration !== 'number'
      || typeof documentNonce !== 'string'
      || pageEpoch !== requestEpoch
      || !WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)) {
      throw new Error('Credential lease is stale.');
    }
    if (operation === 'clearCredential') {
      if (!WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)) throw new Error('Credential lease is stale.');
      await this.store.put(CREDENTIAL_BARRIER_KEY, 'cleared');
      if (!WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)) throw new Error('Credential lease is stale.');
      await this.store.flush();
      if (!WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)) throw new Error('Credential lease is stale.');
      const clearedBarrier = await this.store.get(CREDENTIAL_BARRIER_KEY, '');
      if (!WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)
        || clearedBarrier !== 'cleared') throw new Error('Credential clear barrier readback failed.');
      LifelineNativeProxy.credentialRecoveryRequired = false;
      return JSON.stringify({ durable: true });
    }
    if (operation === 'loadCredential') {
      if (LifelineNativeProxy.credentialRecoveryRequired) throw new Error('Credential recovery required.');
      const barrier = await this.store.get(CREDENTIAL_BARRIER_KEY, '');
      if (!WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)) throw new Error('Credential lease is stale.');
      if (barrier === 'cleared') return JSON.stringify({ state: 'cleared' });
      if (barrier !== '' && barrier !== 'present') throw new Error('Credential barrier is invalid.');
      const encrypted = await this.store.get(CREDENTIAL_KEY, '');
      if (!WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)) throw new Error('Credential lease is stale.');
      if (typeof encrypted !== 'string' || encrypted.length > 65_536) throw new Error('Credential record is invalid.');
      if (encrypted.length === 0) {
        if (barrier === 'present') throw new Error('Credential ciphertext is missing.');
        return JSON.stringify({ state: 'missing' });
      }
      const plaintext = await decryptCredential(encrypted);
      if (!WebControllerRegistry.isCredentialOwnerCurrent(this.controller, pageEpoch, ownerGeneration)) throw new Error('Credential lease is stale.');
      const credential = JSON.parse(plaintext) as Record<string, Object>;
      const token = credential['token'], username = credential['username'];
      if (Object.keys(credential).length !== 2 || typeof token !== 'string' || token.length === 0 || token.length > 16_384
        || typeof username !== 'string' || username.trim().length === 0 || unicodeCodePointCount(username) > 50) throw new Error('Credential schema is invalid.');
      return JSON.stringify({ state: 'present', credential });
    }
    if (operation === 'saveCredential') {
      const credential = input['credential'] as Record<string, Object>;
      if (!credential || typeof credential !== 'object' || Array.isArray(credential)
        || Object.keys(credential).length !== 2 || Object.keys(credential).some((key) => !['token', 'username'].includes(key))) throw new Error('Credential schema is invalid.');
      const token = credential['token'], username = credential['username'];
      if (typeof token !== 'string' || token.length === 0 || token.length > 16_384
        || typeof username !== 'string' || username.trim().length === 0 || unicodeCodePointCount(username) > 50) throw new Error('Credential fields exceed their limits.');
      const encrypted = await encryptCredential(JSON.stringify(credential));
      if (!WebControllerRegistry.isCredentialOwnerCurrent(this.controller, pageEpoch, ownerGeneration)) throw new Error('Credential lease is stale.');
      if (LifelineNativeProxy.credentialRecoveryRequired) throw new Error('Credential recovery required.');
      // The queue serializes readers and writers. A durable pending barrier
      // suppresses a partially committed replacement across a restart.
      try {
      await this.store.put(CREDENTIAL_BARRIER_KEY, 'pending');
      await this.store.flush();
      if (!WebControllerRegistry.isCredentialOwnerCurrent(this.controller, pageEpoch, ownerGeneration)
        || await this.store.get(CREDENTIAL_BARRIER_KEY, '') !== 'pending') throw new Error('Credential pending barrier failed.');
      await this.store.put(CREDENTIAL_KEY, encrypted);
      if (!WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)) throw new Error('Credential lease is stale.');
      await this.store.flush();
      if (!WebControllerRegistry.isCredentialOwnerCurrent(this.controller, pageEpoch, ownerGeneration)
        || await this.store.get(CREDENTIAL_KEY, '') !== encrypted) throw new Error('Credential ciphertext readback failed.');
      await this.store.put(CREDENTIAL_BARRIER_KEY, 'present');
      if (!WebControllerRegistry.isCredentialDocumentCurrent(this.controller, pageEpoch, ownerGeneration, documentNonce)) throw new Error('Credential lease is stale.');
      await this.store.flush();
      if (!WebControllerRegistry.isCredentialOwnerCurrent(this.controller, pageEpoch, ownerGeneration)
        || await this.store.get(CREDENTIAL_BARRIER_KEY, '') !== 'present') throw new Error('Credential commit barrier failed.');
      } catch (failedCommit) {
        LifelineNativeProxy.credentialRecoveryRequired = true;
        // The final flush/readback may fail after mutation; suppress it again
        // when storage remains writable. Explicit clear releases recovery.
        try { await this.store.put(CREDENTIAL_BARRIER_KEY, 'pending'); await this.store.flush(); } catch (_ignored) {}
        throw new Error('Credential commit failed; recovery required.');
      }
      return JSON.stringify({ durable: true });
    }
    throw new Error('Unsupported credential operation.');
  }

  private async executeShareReplay(requestId: string, value: string): Promise<void> {
    const requestGeneration = this.requestGenerations.get(requestId) ?? -1;
    if (!this.isCurrentRequest(requestGeneration)) throw new Error('The page changed before replay sharing could start.');
    if (typeof value !== 'string' || value.length === 0 || utf8ByteLength(value) > SHARE_JSON_LIMIT_BYTES) {
      throw new Error('Replay payload is empty or too large to share.');
    }
    const replay = JSON.parse(value) as ReplayDocument;
    if (!replay || Array.isArray(replay) || replay.format !== 'lifeline-replay' || replay.schemaVersion !== 1) {
      throw new Error('Unsupported replay document.');
    }

    if (!this.isCurrentRequest(requestGeneration)) throw new Error('The page changed before replay sharing could start.');
    const cacheDirectory = `${this.context.cacheDir}/${SHARE_DIRECTORY}`;
    if (!fileIo.accessSync(cacheDirectory)) fileIo.mkdirSync(cacheDirectory);
    const now = Date.now();
    const cachedNames = fileIo.listFileSync(cacheDirectory);
    let ownedFiles: CachedReplayFile[] = [];
    let cachedBytes: number = 0;
    for (const name of cachedNames) {
      const match = new RegExp('^replay-(\\d{13})-[a-f0-9]{16}-\\d{1,12}\\.json$').exec(name);
      if (!match) continue;
      const createdAt = Number(match[1]);
      const filePath = `${cacheDirectory}/${name}`;
      if (!Number.isFinite(createdAt)) continue;
      const markerPath = `${filePath}.active`;
      const pinned = this.activeShareFiles.has(filePath) || fileIo.accessSync(markerPath);
      if (now >= createdAt && now - createdAt > SHARE_FILE_MAX_AGE_MS && !this.activeShareFiles.has(filePath)) {
        fileIo.unlinkSync(filePath);
        if (fileIo.accessSync(markerPath)) fileIo.unlinkSync(markerPath);
      } else {
        const size = fileIo.statSync(filePath).size;
        ownedFiles.push({ name, createdAt, size, pinned });
        cachedBytes += size;
      }
    }
    const payloadBytes: number = utf8ByteLength(value);
    while (ownedFiles.length >= SHARE_FILE_LIMIT || cachedBytes + payloadBytes > SHARE_CACHE_TOTAL_BYTES_LIMIT) {
      const reusable = ownedFiles
        .filter((item) => !item.pinned && now >= item.createdAt && now - item.createdAt >= SHARE_FILE_MIN_RETENTION_MS)
        .sort((left, right) => left.createdAt - right.createdAt);
      if (reusable.length === 0) {
        throw new Error('棋谱分享缓存暂满（最多 32 个文件/128 MiB）。请稍后重试；未确认的分享请先关闭面板，或完全退出应用后重试。');
      }
      const oldest = reusable[0];
      const oldestPath = `${cacheDirectory}/${oldest.name}`;
      fileIo.unlinkSync(oldestPath);
      const markerPath = `${oldestPath}.active`;
      if (fileIo.accessSync(markerPath)) fileIo.unlinkSync(markerPath);
      ownedFiles = ownedFiles.filter((item) => item.name !== oldest.name);
      cachedBytes -= oldest.size;
    }

    const safeRequestPart = requestId.replace('.', '-');
    const fileName = `replay-${now}-${safeRequestPart}.json`;
    if (!new RegExp('^replay-\\d{13}-[a-f0-9]{16}-\\d{1,12}\\.json$').test(fileName)) {
      throw new Error('Could not create a safe replay file name.');
    }
    const filePath = `${cacheDirectory}/${fileName}`;
    let openFile: fileIo.File | null = null;
    try {
      openFile = fileIo.openSync(filePath, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
      const writtenBytes: number = fileIo.writeSync(openFile.fd, value, { encoding: 'utf-8' });
      if (writtenBytes !== payloadBytes) throw new Error('Replay file write was incomplete.');
      fileIo.closeSync(openFile.fd);
      openFile = null;
    } catch (error) {
      if (openFile !== null) {
        try { fileIo.closeSync(openFile.fd); } catch (_closeError) {}
      }
      try { fileIo.unlinkSync(filePath); } catch (_unlinkError) {}
      if (error instanceof Error) throw error;
      throw new Error('Replay file write failed.');
    }

    const type = utd.getUniformDataTypeByFilenameExtension('.json', utd.UniformDataType.TEXT);
    const data = new systemShare.SharedData({
      utd: type,
      uri: fileUri.getUriFromPath(filePath),
      title: 'LIFELINE replay',
      description: 'LIFELINE replay JSON file',
    });
    const shareController = new systemShare.ShareController(data);
    const markerPath = `${filePath}.active`;
    let markerFile: fileIo.File | null = null;
    try {
      markerFile = fileIo.openSync(markerPath, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
      fileIo.closeSync(markerFile.fd);
      markerFile = null;
    } catch (error) {
      if (markerFile !== null) {
        try { fileIo.closeSync(markerFile.fd); } catch (_closeError) {}
      }
      try { fileIo.unlinkSync(markerPath); } catch (_unlinkError) {}
      try { fileIo.unlinkSync(filePath); } catch (_unlinkError) {}
      if (error instanceof Error) throw error;
      throw new Error('Replay share marker creation failed.');
    }
    this.activeShareFiles.add(filePath);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled: boolean = false;
        let opened: boolean = false;
        let handshakeReported: boolean = false;
        let unknownReported: boolean = false;
        let timeout: number = 0;
        const release = () => {
          clearTimeout(timeout);
          shareController.off('dismiss', onDismiss);
          this.activeShareIds.delete(requestId);
          this.activeShareFiles.delete(filePath);
          try { fileIo.unlinkSync(markerPath); } catch (_error) {}
        };
        const reportUnknown = () => {
          if (settled || unknownReported) return;
          unknownReported = true;
          this.reply(requestId, { ok: true, result: { status: 'timedOut' } });
        };
        const onDismiss = () => {
          if (settled) return;
          settled = true;
          release();
          if (opened) this.reply(requestId, { ok: true, result: { status: 'dismissed' } });
          else this.reply(requestId, { ok: false, error: 'The share panel closed before opening could be confirmed.' });
          resolve();
        };
        timeout = setTimeout(() => {
          if (settled || opened || handshakeReported) return;
          handshakeReported = true;
          this.reply(requestId, {
            ok: false,
            error: '未能确认系统分享面板是否打开；面板仍可能出现。请先关闭分享面板；若仍无法导出，请完全退出应用后重试。'
          });
          timeout = setTimeout(reportUnknown, SHARE_DISMISS_TIMEOUT_MS);
        }, SHARE_OPEN_TIMEOUT_MS);
        try {
          if (!this.isCurrentRequest(requestGeneration)) throw new Error('The page changed before opening the share panel.');
          shareController.on('dismiss', onDismiss);
          shareController.show(this.context, {
            selectionMode: systemShare.SelectionMode.SINGLE,
            previewMode: systemShare.SharePreviewMode.DEFAULT,
          }).then(() => {
            if (settled) return;
            opened = true;
            clearTimeout(timeout);
            this.reply(requestId, { ok: true, result: { status: 'opened' } });
            timeout = setTimeout(reportUnknown, SHARE_DISMISS_TIMEOUT_MS);
          }).catch((error: Error) => {
            if (settled) return;
            settled = true;
            release();
            if (handshakeReported) resolve();
            else reject(error);
          });
        } catch (error) {
          if (settled) return;
          settled = true;
          release();
          reject(error as Error);
        }
      });
    } finally {
      this.activeShareFiles.delete(filePath);
    }
  }

  private isCurrentRequest(generation: number): boolean {
    return generation >= 0 && this.currentGeneration() === generation
      && WebControllerRegistry.currentGeneration(this.controller) === generation;
  }

  private reply(requestId: string, response: NativeReply): void {
    if (!new RegExp('^[a-f0-9]{16}\\.[0-9]{1,12}$').test(requestId)) return;
    const generation = this.requestGenerations.get(requestId);
    if (generation === undefined || !this.isCurrentRequest(generation)) { this.requestGenerations.delete(requestId); return; }
    if (!this.multiReplyRequests.has(requestId)) this.requestGenerations.delete(requestId);
    const responseJson: string = JSON.stringify(response);
    const script: string = `globalThis.__lifelineNativeComplete?.(${JSON.stringify(requestId)}, ${JSON.stringify(responseJson)})`;
    void this.controller.runJavaScript(script).catch((error: Error) => {
      console.error(`Could not return native storage result: ${error.message}`);
    });
  }
}
