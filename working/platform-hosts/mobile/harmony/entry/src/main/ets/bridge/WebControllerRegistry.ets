import { webview } from '@kit.ArkWeb';
import { url } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

export class WebControllerRegistry {
  private static controller: webview.WebviewController | null = null;
  private static webReady: boolean = false;
  private static latestLifecycleEvent: string = '';
  private static foreground: boolean = false;
  private static stateGeneration: number = 0;
  private static dispatchGeneration: number = 0;
  private static backSequence: number = 0;
  private static activeBackRequest: number = 0;
  private static credentialDocumentEpoch: number = 1;
  private static credentialOwnerGeneration: number = 0;
  private static credentialDocumentNonce: string = '';

  private static rotateCredentialDocument(): void {
    const bytes = cryptoFramework.createRandom().generateRandomSync(24).data;
    let nonce: string = '';
    for (let i: number = 0; i < bytes.length; i++) nonce += bytes[i].toString(16).padStart(2, '0');
    WebControllerRegistry.credentialDocumentNonce = nonce;
  }

  static attach(controller: webview.WebviewController): void {
    WebControllerRegistry.controller = controller;
    WebControllerRegistry.credentialDocumentEpoch += 1;
    WebControllerRegistry.credentialOwnerGeneration += 1;
    WebControllerRegistry.rotateCredentialDocument();
    WebControllerRegistry.webReady = false;
    WebControllerRegistry.stateGeneration += 1;
    WebControllerRegistry.dispatchGeneration += 1;
    WebControllerRegistry.activeBackRequest = 0;
  }

  static markLoading(controller: webview.WebviewController): void {
    if (WebControllerRegistry.controller !== controller) return;
    WebControllerRegistry.webReady = false;
    WebControllerRegistry.credentialDocumentEpoch += 1;
    WebControllerRegistry.credentialOwnerGeneration += 1;
    WebControllerRegistry.rotateCredentialDocument();
    WebControllerRegistry.stateGeneration += 1;
    WebControllerRegistry.dispatchGeneration += 1;
    WebControllerRegistry.activeBackRequest = 0;
  }

  static markReady(controller: webview.WebviewController): void {
    if (WebControllerRegistry.controller !== controller) return;
    WebControllerRegistry.webReady = true;
    WebControllerRegistry.stateGeneration += 1;
    WebControllerRegistry.dispatchGeneration += 1;
    WebControllerRegistry.activeBackRequest = 0;
    WebControllerRegistry.dispatchLatest();
  }

  static detach(controller: webview.WebviewController): void {
    if (WebControllerRegistry.controller !== controller) return;
    WebControllerRegistry.controller = null;
    WebControllerRegistry.credentialDocumentEpoch += 1;
    WebControllerRegistry.credentialOwnerGeneration += 1;
    WebControllerRegistry.credentialDocumentNonce = '';
    WebControllerRegistry.webReady = false;
    WebControllerRegistry.stateGeneration += 1;
    WebControllerRegistry.dispatchGeneration += 1;
    WebControllerRegistry.activeBackRequest = 0;
  }

  static dispatchLifecycle(eventName: string): void {
    if (eventName !== 'lifeline:foreground' && eventName !== 'lifeline:background') return;
    WebControllerRegistry.latestLifecycleEvent = eventName;
    WebControllerRegistry.foreground = eventName === 'lifeline:foreground';
    WebControllerRegistry.dispatchLatest();
  }

  static isCurrentGeneration(controller: webview.WebviewController, generation: number): boolean {
    return WebControllerRegistry.controller === controller
      && WebControllerRegistry.webReady
      && WebControllerRegistry.stateGeneration === generation;
  }

  static currentGeneration(controller: webview.WebviewController): number {
    return WebControllerRegistry.controller === controller && WebControllerRegistry.webReady
      ? WebControllerRegistry.stateGeneration : -1;
  }

  static credentialEpoch(controller: webview.WebviewController): number {
    return WebControllerRegistry.controller === controller ? WebControllerRegistry.credentialDocumentEpoch : -1;
  }

  static credentialNonce(controller: webview.WebviewController): string {
    return WebControllerRegistry.controller === controller ? WebControllerRegistry.credentialDocumentNonce : '';
  }

  static claimCredentialOwner(controller: webview.WebviewController, requestEpoch: number, verifiedChallenge: string, expectedOwner: number): number {
    if (WebControllerRegistry.controller !== controller || requestEpoch < 0
      || requestEpoch !== WebControllerRegistry.credentialDocumentEpoch
      || verifiedChallenge.length === 0
      || (expectedOwner !== -1 && expectedOwner !== WebControllerRegistry.credentialOwnerGeneration)) return -1;
    WebControllerRegistry.credentialOwnerGeneration += 1;
    return WebControllerRegistry.credentialOwnerGeneration;
  }

  static isCredentialOwnerCurrent(controller: webview.WebviewController, pageEpoch: number, ownerGeneration: number): boolean {
    return WebControllerRegistry.controller === controller
      && WebControllerRegistry.credentialDocumentEpoch === pageEpoch
      && WebControllerRegistry.credentialOwnerGeneration === ownerGeneration;
  }

  static isCredentialDocumentCurrent(controller: webview.WebviewController, pageEpoch: number, ownerGeneration: number, nonce: string): boolean {
    return WebControllerRegistry.isCredentialOwnerCurrent(controller, pageEpoch, ownerGeneration)
      && nonce.length > 0 && WebControllerRegistry.credentialDocumentNonce === nonce;
  }

  static isForeground(): boolean { return WebControllerRegistry.foreground; }

  static dispatchBack(controller: webview.WebviewController, onUnhandled: (error?: Error) => void): boolean {
    if (WebControllerRegistry.controller !== controller || !WebControllerRegistry.webReady) return false;
    if (WebControllerRegistry.activeBackRequest !== 0) return true;
    const generation = WebControllerRegistry.stateGeneration;
    try {
      const currentUrl = new url.URL(controller.getUrl());
      if (currentUrl.protocol === 'https:' && currentUrl.origin === 'https://lifeline.appassets.invalid'
        && currentUrl.pathname === '/legal/THIRD_PARTY_NOTICES.html') {
        if (controller.accessBackward()) controller.backward();
        else onUnhandled();
        return true;
      }
    } catch (error) {
      if (WebControllerRegistry.isCurrentGeneration(controller, generation)) onUnhandled(error as Error);
      return true;
    }

    const request = ++WebControllerRegistry.backSequence;
    WebControllerRegistry.activeBackRequest = request;
    const source = "(()=>{const e=new Event('lifeline:back',{cancelable:true});globalThis.dispatchEvent(e);return String(e.defaultPrevented)})()";
    try {
      void controller.runJavaScript(source).then((result: string) => {
        if (WebControllerRegistry.activeBackRequest !== request
          || !WebControllerRegistry.isCurrentGeneration(controller, generation)) return;
        WebControllerRegistry.activeBackRequest = 0;
        const response = String(result).trim();
        const withoutLeadingQuote = response.startsWith("'") || response.startsWith('\"')
          ? response.slice(1) : response;
        const normalizedResponse = withoutLeadingQuote.endsWith("'") || withoutLeadingQuote.endsWith('\"')
          ? withoutLeadingQuote.slice(0, -1) : withoutLeadingQuote;
        const handled = normalizedResponse === 'true';
        if (!handled) onUnhandled();
      }).catch((error: Error) => {
        if (WebControllerRegistry.activeBackRequest !== request
          || !WebControllerRegistry.isCurrentGeneration(controller, generation)) return;
        WebControllerRegistry.activeBackRequest = 0;
        onUnhandled(error);
      });
    } catch (error) {
      if (WebControllerRegistry.activeBackRequest === request
        && WebControllerRegistry.isCurrentGeneration(controller, generation)) {
        WebControllerRegistry.activeBackRequest = 0;
        onUnhandled(error as Error);
      }
    }
    return true;
  }

  private static dispatchLatest(): void {
    const controller = WebControllerRegistry.controller;
    const eventName = WebControllerRegistry.latestLifecycleEvent;
    if (controller === null || !WebControllerRegistry.webReady || eventName === '') return;
    const isActive = eventName === 'lifeline:foreground';
    const script = `globalThis.__LIFELINE_APP_ACTIVE__=${String(isActive)};globalThis.dispatchEvent(new Event(${JSON.stringify(eventName)}))`;
    const stateGeneration = WebControllerRegistry.stateGeneration;
    const dispatchGeneration = ++WebControllerRegistry.dispatchGeneration;
    try {
      void controller.runJavaScript(script).catch((error: Error) => {
        if (WebControllerRegistry.controller !== controller
          || WebControllerRegistry.stateGeneration !== stateGeneration
          || WebControllerRegistry.dispatchGeneration !== dispatchGeneration) return;
        console.error(`Could not dispatch ${eventName}: ${error.message}`);
      });
    } catch (error) {
      if (WebControllerRegistry.controller !== controller
        || WebControllerRegistry.stateGeneration !== stateGeneration
        || WebControllerRegistry.dispatchGeneration !== dispatchGeneration) return;
      console.error(`Could not dispatch ${eventName}: ${(error as Error).message}`);
    }
  }
}
