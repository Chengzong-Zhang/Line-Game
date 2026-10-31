import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

const LEGAL_ORIGIN = 'https://localhost';
const LEGAL_PATH = '/legal/THIRD_PARTY_NOTICES.html';

function reportBackError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown back-navigation error.');
  const event = new CustomEvent('lifeline:back-error', { cancelable: true, detail: { message } });
  globalThis.dispatchEvent(event);
  if (!event.defaultPrevented && typeof globalThis.alert === 'function') {
    globalThis.alert(`系统返回未完成：${message}`);
  }
}

export async function installNativeBackBootstrap() {
  if (!Capacitor.isNativePlatform()) return false;
  await App.addListener('backButton', ({ canGoBack }) => {
    const event = new CustomEvent('lifeline:back', {
      cancelable: true,
      detail: { canGoBack: canGoBack === true },
    });
    globalThis.dispatchEvent(event);
    if (event.defaultPrevented) return;
    const legalPage = globalThis.location?.origin === LEGAL_ORIGIN
      && globalThis.location?.pathname === LEGAL_PATH;
    if (legalPage && canGoBack === true) {
      try {
        globalThis.history.back();
        return;
      } catch (_error) {
        // Fall through to the platform-supported background action.
      }
    }
    void App.minimizeApp().catch(reportBackError);
  });
  return true;
}

void installNativeBackBootstrap().catch(reportBackError);
