import { connection } from '@kit.NetworkKit';

export interface NetworkStatusSnapshot {
  schemaVersion: number;
  source: string;
  revision: number;
  availability: string;
  validation: string;
  reason?: string;
}

export class NetworkStatusMonitor {
  private static readonly STOP_TIMEOUT_MS: number = 3_000;
  private static connection: connection.NetConnection | null = null;
  private static ownerNonce: string = '';
  private static subscriptionId: string = '';
  private static cancelledSubscriptions: Set<string> = new Set<string>();
  private static generation: number = 0;
  private static querySequence: number = 0;
  private static registrationPending: boolean = false;
  private static registrationCompletion: Promise<void> | null = null;
  private static startQueue: Promise<void> = Promise.resolve();
  private static stopQueue: Promise<void> = Promise.resolve();
  private static revision: number = 0;
  private static available: string = 'unknown';
  private static validation: string = 'unknown';
  private static currentNetId: number = -1;
  private static observer: ((status: NetworkStatusSnapshot, nonce: string, id: string) => void) | null = null;
  private static foreground: boolean = true;

  static setForeground(value: boolean): void {
    NetworkStatusMonitor.foreground = value;
    if (!value) void NetworkStatusMonitor.stop().catch(() => {});
  }

  static unknown(reason: string = 'unavailable'): NetworkStatusSnapshot {
    return {
      schemaVersion: 1, source: 'harmony-native', revision: NetworkStatusMonitor.revision,
      availability: 'unknown', validation: 'unknown',
      reason: reason === 'background' ? 'background' : 'unavailable'
    };
  }

  static getStatus(): Promise<NetworkStatusSnapshot> {
    if (!NetworkStatusMonitor.foreground) return Promise.resolve(NetworkStatusMonitor.unknown('background'));
    return NetworkStatusMonitor.readSnapshot(NetworkStatusMonitor.generation);
  }

  static start(nonce: string, subscriptionId: string, observer: (status: NetworkStatusSnapshot, nonce: string, id: string) => void,
    isPageCurrent: () => boolean): Promise<NetworkStatusSnapshot> {
    const result = NetworkStatusMonitor.startQueue.then(() => NetworkStatusMonitor.runStart(nonce, subscriptionId, observer, isPageCurrent));
    NetworkStatusMonitor.startQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private static async runStart(nonce: string, subscriptionId: string, observer: (status: NetworkStatusSnapshot, nonce: string, id: string) => void,
    isPageCurrent: () => boolean): Promise<NetworkStatusSnapshot> {
    if (!NetworkStatusMonitor.foreground) throw new Error('Network monitoring is unavailable in the background.');
    if (NetworkStatusMonitor.cancelledSubscriptions.has(subscriptionId)) throw new Error('Network subscription was cancelled.');
    const pending = NetworkStatusMonitor.registrationCompletion;
    if (pending !== null) {
      try { await pending; } catch (_error) {}
      if (NetworkStatusMonitor.cancelledSubscriptions.has(subscriptionId)) throw new Error('Network subscription was cancelled.');
    }
    if (NetworkStatusMonitor.connection !== null && NetworkStatusMonitor.ownerNonce === nonce
      && NetworkStatusMonitor.subscriptionId === subscriptionId) {
      return NetworkStatusMonitor.readSnapshot(NetworkStatusMonitor.generation);
    }
    await NetworkStatusMonitor.stop();
    if (!NetworkStatusMonitor.foreground || !isPageCurrent()
      || NetworkStatusMonitor.cancelledSubscriptions.has(subscriptionId)) throw new Error('Network subscription is no longer active.');
    const ownGeneration = ++NetworkStatusMonitor.generation;
    const netConnection = connection.createNetConnection();
    NetworkStatusMonitor.connection = netConnection;
    NetworkStatusMonitor.ownerNonce = nonce;
    NetworkStatusMonitor.subscriptionId = subscriptionId;
    NetworkStatusMonitor.observer = observer;
    NetworkStatusMonitor.available = 'unknown';
    NetworkStatusMonitor.validation = 'unknown';
    NetworkStatusMonitor.currentNetId = -1;

    let registrationCleaned: boolean = false;
    netConnection.on('netAvailable', (handle) => {
      if (!NetworkStatusMonitor.isCurrent(ownGeneration)) return;
      NetworkStatusMonitor.currentNetId = handle.netId;
      NetworkStatusMonitor.available = 'available';
      NetworkStatusMonitor.validation = 'unknown';
      NetworkStatusMonitor.publish();
    });
    netConnection.on('netUnavailable', () => {
      if (!NetworkStatusMonitor.isCurrent(ownGeneration)) return;
      NetworkStatusMonitor.currentNetId = -1;
      NetworkStatusMonitor.available = 'unavailable';
      NetworkStatusMonitor.validation = 'unknown';
      NetworkStatusMonitor.publish();
    });
    netConnection.on('netLost', (handle) => {
      if (!NetworkStatusMonitor.isCurrent(ownGeneration) || handle.netId !== NetworkStatusMonitor.currentNetId) return;
      NetworkStatusMonitor.currentNetId = -1;
      NetworkStatusMonitor.available = 'unavailable';
      NetworkStatusMonitor.validation = 'unknown';
      NetworkStatusMonitor.publish();
    });
    netConnection.on('netCapabilitiesChange', (info) => {
      if (!NetworkStatusMonitor.isCurrent(ownGeneration) || info.netHandle.netId !== NetworkStatusMonitor.currentNetId) return;
      const capabilities = info.netCap?.networkCap;
      NetworkStatusMonitor.available = 'available';
      NetworkStatusMonitor.validation = capabilities === undefined ? 'unknown'
        : capabilities.includes(connection.NetCap.NET_CAPABILITY_VALIDATED) ? 'validated' : 'unvalidated';
      NetworkStatusMonitor.publish();
    });

    const registration = new Promise<void>((resolve, reject) => {
      netConnection.register((error) => {
        if (!NetworkStatusMonitor.isCurrent(ownGeneration)) {
          void NetworkStatusMonitor.unregisterOne(netConnection).then(() => {
            if (NetworkStatusMonitor.connection === netConnection) {
              NetworkStatusMonitor.connection = null;
              NetworkStatusMonitor.ownerNonce = '';
              NetworkStatusMonitor.subscriptionId = '';
            }
            registrationCleaned = true;
            resolve();
          }, reject);
          return;
        }
        if (error) {
          NetworkStatusMonitor.observer = null;
          void NetworkStatusMonitor.unregisterOne(netConnection).then(() => {
            if (NetworkStatusMonitor.connection === netConnection) {
              NetworkStatusMonitor.connection = null;
              NetworkStatusMonitor.ownerNonce = '';
              NetworkStatusMonitor.subscriptionId = '';
            }
            registrationCleaned = true;
            reject(new Error('Network monitoring registration failed.'));
          }, () => reject(new Error('Network monitoring registration cleanup failed.')));
          return;
        }
        resolve();
      });
    });
    NetworkStatusMonitor.registrationPending = true;
    NetworkStatusMonitor.registrationCompletion = registration;
    try { await registration; }
    finally {
      if (NetworkStatusMonitor.registrationCompletion === registration) {
        NetworkStatusMonitor.registrationPending = false;
        NetworkStatusMonitor.registrationCompletion = null;
      }
    }
    if (!NetworkStatusMonitor.isCurrent(ownGeneration)) {
      if (!registrationCleaned) void NetworkStatusMonitor.unregisterOne(netConnection);
      return NetworkStatusMonitor.snapshot();
    }
    return NetworkStatusMonitor.readSnapshot(ownGeneration);
  }

  static stop(nonce: string = '', subscriptionId: string = ''): Promise<void> {
    if (subscriptionId !== '') {
      NetworkStatusMonitor.cancelledSubscriptions.add(subscriptionId);
      if (NetworkStatusMonitor.cancelledSubscriptions.size > 64) {
        let first: string | undefined = undefined;
        for (const cancelled of NetworkStatusMonitor.cancelledSubscriptions) {
          first = cancelled;
          break;
        }
        if (first !== undefined) NetworkStatusMonitor.cancelledSubscriptions.delete(first);
      }
    }
    const ownsCurrent = (nonce === '' || NetworkStatusMonitor.ownerNonce === nonce)
      && (subscriptionId === '' || NetworkStatusMonitor.subscriptionId === subscriptionId);
    if (ownsCurrent) {
      // Invalidate callbacks and queries before waiting behind any unregister work.
      NetworkStatusMonitor.generation += 1;
      NetworkStatusMonitor.querySequence += 1;
      NetworkStatusMonitor.observer = null;
    }
    const result = NetworkStatusMonitor.stopQueue.then(() => NetworkStatusMonitor.runStop(nonce, subscriptionId));
    NetworkStatusMonitor.stopQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private static async runStop(nonce: string, subscriptionId: string): Promise<void> {
    if ((nonce !== '' && NetworkStatusMonitor.ownerNonce !== nonce)
      || (subscriptionId !== '' && NetworkStatusMonitor.subscriptionId !== subscriptionId)) return;
    if (NetworkStatusMonitor.registrationPending && NetworkStatusMonitor.registrationCompletion !== null) {
      await NetworkStatusMonitor.registrationCompletion;
      NetworkStatusMonitor.currentNetId = -1;
      NetworkStatusMonitor.available = 'unknown';
      NetworkStatusMonitor.validation = 'unknown';
      return;
    }
    const prior = NetworkStatusMonitor.connection;
    if (prior !== null) {
      await NetworkStatusMonitor.unregisterOne(prior);
      if (NetworkStatusMonitor.connection === prior) {
        NetworkStatusMonitor.connection = null;
        NetworkStatusMonitor.ownerNonce = '';
        NetworkStatusMonitor.subscriptionId = '';
      }
    }
    NetworkStatusMonitor.currentNetId = -1;
    NetworkStatusMonitor.available = 'unknown';
    NetworkStatusMonitor.validation = 'unknown';
  }

  private static async readSnapshot(expectedGeneration: number): Promise<NetworkStatusSnapshot> {
    const ownQuery = ++NetworkStatusMonitor.querySequence;
    const isCurrentQuery = (): boolean => NetworkStatusMonitor.generation === expectedGeneration
      && NetworkStatusMonitor.querySequence === ownQuery;
    try {
      const hasDefault = await connection.hasDefaultNet();
      if (!isCurrentQuery()) return NetworkStatusMonitor.snapshot();
      let nextAvailability: string = 'unavailable';
      let nextValidation: string = 'unknown';
      if (hasDefault) {
        const handle = await connection.getDefaultNet();
        const capabilities = await connection.getNetCapabilities(handle);
        if (!isCurrentQuery()) return NetworkStatusMonitor.snapshot();
        NetworkStatusMonitor.currentNetId = handle.netId;
        nextAvailability = 'available';
        nextValidation = capabilities.networkCap === undefined ? 'unknown'
          : capabilities.networkCap.includes(connection.NetCap.NET_CAPABILITY_VALIDATED) ? 'validated' : 'unvalidated';
      } else {
        NetworkStatusMonitor.currentNetId = -1;
      }
      NetworkStatusMonitor.available = nextAvailability;
      NetworkStatusMonitor.validation = nextValidation;
      NetworkStatusMonitor.revision += 1;
      return NetworkStatusMonitor.snapshot();
    } catch (_error) {
      if (!isCurrentQuery()) return NetworkStatusMonitor.snapshot();
      NetworkStatusMonitor.available = 'unknown';
      NetworkStatusMonitor.validation = 'unknown';
      NetworkStatusMonitor.revision += 1;
      return NetworkStatusMonitor.snapshot();
    }
  }

  private static isCurrent(generation: number): boolean {
    return NetworkStatusMonitor.connection !== null && NetworkStatusMonitor.generation === generation;
  }

  private static snapshot(): NetworkStatusSnapshot {
    return {
      schemaVersion: 1, source: 'harmony-native', revision: NetworkStatusMonitor.revision,
      availability: NetworkStatusMonitor.available, validation: NetworkStatusMonitor.validation
    };
  }

  private static publish(): void {
    NetworkStatusMonitor.revision += 1;
    NetworkStatusMonitor.querySequence += 1;
    const observer = NetworkStatusMonitor.observer;
    const nonce = NetworkStatusMonitor.ownerNonce;
    const subscriptionId = NetworkStatusMonitor.subscriptionId;
    if (observer !== null && nonce !== '' && subscriptionId !== '') observer(NetworkStatusMonitor.snapshot(), nonce, subscriptionId);
  }

  private static unregisterOne(target: connection.NetConnection): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Network monitor cleanup timed out.'));
      }, NetworkStatusMonitor.STOP_TIMEOUT_MS);
      target.unregister((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(new Error('Network monitor cleanup failed.'));
        else resolve();
      });
    });
  }
}
