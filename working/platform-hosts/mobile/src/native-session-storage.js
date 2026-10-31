import { createSerializedSessionMirror } from './session-mirror.js';
import { selectSessionRecovery } from './session-recovery.js';
import { parseLocalGameSessionRecord } from '../../web/web前端/LocalGameSession.js?v=20261023-l28a1';

const SESSION_KEY = 'lifeline-local-game-session-v1';
const CLEAR_KEY = 'lifeline-local-game-session-cleared-v1';

export async function initializeNativeSessionStorage({ plugin, storage, eventTarget = globalThis, reportStatus }) {
  const mirror = createSerializedSessionMirror({
    write: async (value) => {
      const result = await plugin.saveRecord({ key: SESSION_KEY, value });
      if (result?.durable !== true) throw new Error('Native storage did not confirm durable save.');
    },
    remove: async () => {
      const result = await plugin.removeRecord({ key: SESSION_KEY });
      if (result?.durable !== true) throw new Error('Native storage did not confirm durable clear.');
    },
  });

  try {
    const wasCleared = storage.getItem(CLEAR_KEY) === '1';
    const localValue = storage.getItem(SESSION_KEY);
    const { value: nativeValue } = await plugin.loadRecord({ key: SESSION_KEY });
    const recovery = selectSessionRecovery({ wasCleared, localValue, nativeValue, parse: parseLocalGameSessionRecord });
    if (recovery.action === 'clear') {
      await mirror.clear();
      reportStatus('cleared');
    } else if (recovery.action === 'save-local-to-native') {
      await mirror.save(recovery.value);
      reportStatus('confirmed');
    } else if (recovery.action === 'restore-native-to-local') {
      storage.setItem(SESSION_KEY, recovery.value);
      reportStatus('restored');
    } else reportStatus(recovery.action);
  } catch (error) {
    reportStatus('error', 'Native session storage failed.');
  }

  eventTarget.addEventListener('lifeline:session-saved', (event) => {
    if (typeof event.detail?.value !== 'string') return;
    storage.removeItem(CLEAR_KEY);
    reportStatus('pending');
    const operation = mirror.save(event.detail.value);
    void operation.then(
      () => { if (operation.isCurrent()) reportStatus('confirmed'); },
      () => { if (operation.isCurrent()) reportStatus('error', 'Native session storage failed.'); },
    );
  });
  eventTarget.addEventListener('lifeline:session-cleared', () => {
    storage.setItem(CLEAR_KEY, '1');
    reportStatus('pending');
    const operation = mirror.clear();
    void operation.then(
      () => { if (operation.isCurrent()) reportStatus('cleared'); },
      () => { if (operation.isCurrent()) reportStatus('error', 'Native session storage failed.'); },
    );
  });

  return Object.freeze({ flushSessionMirror: () => mirror.settled() });
}
