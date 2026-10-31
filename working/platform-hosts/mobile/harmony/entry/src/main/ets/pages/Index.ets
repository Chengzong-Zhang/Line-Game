import { preferences } from '@kit.ArkData';
import { common, Want } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { url } from '@kit.ArkTS';
import { PACKAGED_WEB_FILES } from '../generated/AssetManifest';
import { LifelineNativeProxy } from '../bridge/LifelineNativeProxy';
import { WebControllerRegistry } from '../bridge/WebControllerRegistry';
import { NetworkStatusMonitor } from '../bridge/NetworkStatusMonitor';
import { MainWebRecoveryPolicy } from '../bridge/MainWebRecoveryPolicy';

const LOCAL_ORIGIN: string = 'https://lifeline.appassets.invalid';
const STARTUP_WATCHDOG_MS: number = 30_000;
const PACKAGED_FILE_SET: Set<string> = new Set(PACKAGED_WEB_FILES);

const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif', '.css': 'text/css', '.f32': 'application/octet-stream',
  '.gif': 'image/gif', '.html': 'text/html', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.js': 'application/javascript', '.json': 'application/json',
  '.md': 'text/markdown', '.mjs': 'application/javascript', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.tex': 'text/plain', '.txt': 'text/plain', '.wasm': 'application/wasm', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.xml': 'application/xml'
};

@Entry
@Component
struct Index {
  @State private controller: webview.WebviewController = new webview.WebviewController();
  private readonly mainPageRecoveryPolicy: MainWebRecoveryPolicy = new MainWebRecoveryPolicy();
  private tutorialController: webview.WebviewController = new webview.WebviewController();
  private tutorialGeneration: number = 0;
  private tutorialOwnerGeneration: number = -1;
  private store: preferences.Preferences | null = null;
  private nativeProxy: LifelineNativeProxy | null = null;
  private hostContext: common.UIAbilityContext | null = null;
  private initializationPromise: Promise<void> | null = null;
  private startupWatchdog: number = -1;
  private attemptGeneration: number = 0;
  private active: boolean = false;
  private backgroundTransitionPending: boolean = false;
  @State private ready: boolean = false;
  @State private mainPageFailed: boolean = false;
  @State private mainPageFailureMessage: string = '';
  @State private startupPhase: string = 'loading';
  @State private startupMessage: string = '';
  @State private backNavigationError: string = '';
  @State private externalNavigationError: string = '';
  @State private tutorialUrl: string = '';
  @State private tutorialError: string = '';
  private externalOpenPending: boolean = false;
  private externalOpenSequence: number = 0;

  aboutToAppear(): void {
    this.active = true;
    WebControllerRegistry.attach(this.controller);
    if (this.ready) return;
    this.attemptGeneration += 1;
    const priorAttempt = this.initializationPromise;
    if (priorAttempt === null) this.startHostInitialization(this.attemptGeneration);
    else this.waitForPriorInitialization(this.attemptGeneration, priorAttempt);
  }

  aboutToDisappear(): void {
    this.active = false;
    this.attemptGeneration += 1;
    this.closeTutorialOverlay();
    this.externalOpenPending = false;
    this.clearStartupWatchdog();
    void NetworkStatusMonitor.stop().catch(() => {});
    WebControllerRegistry.detach(this.controller);
  }

  private isCurrentMainWeb(controller: webview.WebviewController, generation: number): boolean {
    return this.active && this.controller === controller && this.mainPageRecoveryPolicy.isCurrent(generation);
  }

  private recoverMainPage(reason: string, controller: webview.WebviewController, generation: number, manual: boolean = false): void {
    if (!this.isCurrentMainWeb(controller, generation)) return;
    const nextGeneration = manual
      ? this.mainPageRecoveryPolicy.beginManualRetry(generation)
      : this.mainPageRecoveryPolicy.beginAutomaticRecovery(generation);
    if (nextGeneration === 'stale' || nextGeneration === -1) return;
    if (nextGeneration === 'exhausted') {
      this.mainPageFailed = true;
      this.mainPageFailureMessage = `${reason} 自动恢复仍未成功。棋局存档会保留；可以手动重试。`;
      WebControllerRegistry.detach(controller);
      this.closeTutorialOverlay();
      this.externalOpenSequence += 1;
      this.externalOpenPending = false;
      void NetworkStatusMonitor.stop().catch(() => {});
      return;
    }
    this.mainPageFailed = false;
    this.externalOpenSequence += 1;
    this.externalOpenPending = false;
    this.closeTutorialOverlay();
    void NetworkStatusMonitor.stop().catch(() => {});
    WebControllerRegistry.detach(controller);
    this.controller = new webview.WebviewController();
    WebControllerRegistry.attach(this.controller);
    if (this.store !== null && this.hostContext !== null) {
      const currentController = this.controller;
      this.nativeProxy = new LifelineNativeProxy(
        this.store, currentController, this.hostContext,
        () => WebControllerRegistry.currentGeneration(currentController),
        (targetUrl: string) => this.openTutorialOverlay(targetUrl)
      );
    }
    this.mainPageFailureMessage = reason;
  }

  private isCurrentAttempt(generation: number): boolean {
    return this.active && generation === this.attemptGeneration;
  }

  private clearStartupWatchdog(): void {
    if (this.startupWatchdog >= 0) {
      clearTimeout(this.startupWatchdog);
      this.startupWatchdog = -1;
    }
  }

  private startHostInitialization(generation: number): void {
    if (!this.isCurrentAttempt(generation) || this.initializationPromise !== null || this.ready) return;
    this.startupPhase = 'loading';
    this.startupMessage = '正在初始化本地存档…';
    this.externalOpenPending = false;
    this.startupWatchdog = setTimeout(() => {
      if (!this.isCurrentAttempt(generation) || this.startupPhase !== 'loading') return;
      this.startupPhase = 'waiting';
      this.startupMessage = '存储初始化仍在等待，尚未确认失败。此请求无法取消，请继续等待；若长时间无响应，请完全退出应用后重新打开。';
    }, STARTUP_WATCHDOG_MS);

    let attempt: Promise<void>;
    attempt = Promise.resolve().then(async () => {
      if (!this.isCurrentAttempt(generation)) return;
      let context = this.hostContext;
      if (context === null) {
        const hostContext = this.getUIContext().getHostContext();
        if (hostContext === undefined) throw new Error('Harmony application context is unavailable.');
        context = hostContext as common.UIAbilityContext;
        this.hostContext = context;
      }
      const store = await preferences.getPreferences(context, 'lifeline-session-v1');
      if (!this.isCurrentAttempt(generation)) return;
      this.store = store;
      const currentController = this.controller;
      this.nativeProxy = new LifelineNativeProxy(
        store,
        currentController,
        context,
        () => WebControllerRegistry.currentGeneration(currentController),
        (targetUrl: string) => this.openTutorialOverlay(targetUrl)
      );
      this.ready = true;
      this.startupPhase = 'ready';
      this.startupMessage = '';
    }).catch((error: Error) => {
      if (!this.isCurrentAttempt(generation)) return;
      this.startupPhase = 'failed';
      this.startupMessage = `本地存档初始化失败：${error.message}。请重试初始化；若问题持续，请完全退出应用后重新打开。`;
    }).finally(() => {
      if (this.initializationPromise === attempt) this.initializationPromise = null;
      if (!this.isCurrentAttempt(generation)) return;
      this.clearStartupWatchdog();
    });
    this.initializationPromise = attempt;
  }

  private waitForPriorInitialization(generation: number, priorAttempt: Promise<void>): void {
    this.startupPhase = 'waiting';
    this.startupMessage = '上一次存储初始化仍未结束。为避免并发访问，本页会等它返回后再重试；若长时间无响应，请完全退出应用后重新打开。';
    this.startupWatchdog = setTimeout(() => {
      if (!this.isCurrentAttempt(generation) || this.startupPhase !== 'waiting') return;
      this.startupMessage = '存储初始化仍在等待，尚未确认失败。此请求无法取消；请继续等待，或完全退出应用后重新打开。';
    }, STARTUP_WATCHDOG_MS);
    void priorAttempt.then(() => {
      if (!this.isCurrentAttempt(generation) || this.ready || this.initializationPromise !== null) return;
      this.clearStartupWatchdog();
      this.startHostInitialization(generation);
    });
  }

  private retryHostInitialization(): void {
    if (!this.isCurrentAttempt(this.attemptGeneration) || this.initializationPromise !== null || this.ready) return;
    this.startHostInitialization(this.attemptGeneration);
  }

  private openTutorialOverlay(targetUrl: string): boolean {
    if (!this.active || !this.ready || WebControllerRegistry.currentGeneration(this.controller) < 0) return false;
    if (this.tutorialUrl.length > 0) return this.tutorialUrl === targetUrl;
    if (!this.isAllowedTutorialTarget(targetUrl)) return false;
    this.tutorialGeneration += 1;
    this.tutorialOwnerGeneration = this.tutorialGeneration;
    this.tutorialController = new webview.WebviewController();
    this.tutorialError = '';
    this.tutorialUrl = targetUrl;
    return true;
  }

  private closeTutorialOverlay(): void {
    this.tutorialGeneration += 1;
    this.tutorialOwnerGeneration = -1;
    this.tutorialUrl = '';
    this.tutorialError = '';
    this.tutorialController = new webview.WebviewController();
  }

  private isCurrentTutorial(generation: number, controller: webview.WebviewController): boolean {
    return this.active && this.tutorialUrl.length > 0
      && this.tutorialGeneration === generation && this.tutorialOwnerGeneration === generation
      && this.tutorialController === controller;
  }

  private isAllowedTutorialTarget(targetUrl: string): boolean {
    try {
      const candidate = new url.URL(targetUrl);
      return candidate.protocol === 'https:' && candidate.origin === LOCAL_ORIGIN
        && candidate.username === '' && candidate.password === ''
        && ['/','/index.html'].includes(candidate.pathname) && candidate.hash === ''
        && candidate.searchParams.toString() === 'tutorial=1'
        && candidate.searchParams.getAll('tutorial').length === 1
        && candidate.searchParams.get('tutorial') === '1';
    } catch (_error) {
      return false;
    }
  }

  private interceptTutorialRequest(requestUrl: string): WebResourceResponse {
    try {
      const candidate = new url.URL(requestUrl);
      if (candidate.protocol === 'https:' && candidate.origin === LOCAL_ORIGIN
        && candidate.username === '' && candidate.password === '') {
        const localResponse = this.interceptLocalRequest(requestUrl);
        if (localResponse !== null) return localResponse;
      }
    } catch (_error) { }
    return this.createResponse(403, 'Forbidden', 'text/plain', 'Tutorial network access is disabled.');
  }

  private async moveToBackgroundAfterUnhandledBack(error?: Error): Promise<void> {
    if (this.backgroundTransitionPending) return;
    this.backgroundTransitionPending = true;
    try {
      const context = this.hostContext;
      if (context === null) throw new Error('Harmony application context is unavailable.');
      await context.moveAbilityToBackground();
      this.backNavigationError = '';
    } catch (backgroundError) {
      const detail = error?.message || (backgroundError as Error).message || '未知错误';
      this.backNavigationError = `系统返回未完成：${detail}。当前页面仍保留，可重试返回或继续使用。`;
      this.startupMessage = `无法安全返回桌面：${detail}。当前页面仍保留，请重试或继续使用。`;
      console.error(`Could not move the ability to background: ${detail}`);
    } finally {
      this.backgroundTransitionPending = false;
    }
  }

  onBackPress(): boolean {
    if (!this.active) return false;
    if (this.tutorialUrl.length > 0) {
      this.closeTutorialOverlay();
      return true;
    }
    if (this.backgroundTransitionPending) return true;
    if (!this.ready) {
      void this.moveToBackgroundAfterUnhandledBack();
      return true;
    }
    if (!WebControllerRegistry.dispatchBack(this.controller, (error?: Error) => {
      if (this.active && this.ready) void this.moveToBackgroundAfterUnhandledBack(error);
    })) {
      void this.moveToBackgroundAfterUnhandledBack();
    }
    return true;
  }

  private createResponse(status: number, reason: string, mime: string, data: string | number | Resource | ArrayBuffer): WebResourceResponse {
    const response = new WebResourceResponse();
    response.setResponseData(data);
    response.setResponseEncoding('utf-8');
    response.setResponseMimeType(mime);
    response.setResponseCode(status);
    response.setReasonMessage(reason);
    response.setResponseIsReady(true);
    return response;
  }

  private interceptLocalRequest(requestUrl: string): WebResourceResponse | null {
    let parsed: url.URL;
    try {
      const rawPath = requestUrl.slice(LOCAL_ORIGIN.length).split(new RegExp('[?#]'))[0];
      const decodedRawPath = decodeURIComponent(rawPath);
      if (decodedRawPath.split('/').some((part: string) => part === '.' || part === '..')
        || decodedRawPath.includes('\\')) {
        return this.createResponse(404, 'Not Found', 'text/plain', 'Resource is not in the mobile asset manifest.');
      }
      parsed = new url.URL(requestUrl);
    } catch (_error) {
      return this.createResponse(404, 'Not Found', 'text/plain', 'Malformed local resource URL.');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== LOCAL_ORIGIN || parsed.username !== '' || parsed.password !== '') {
      return null;
    }

    let relativePath: string;
    try {
      relativePath = decodeURIComponent(parsed.pathname).replace(new RegExp('^/'), '');
    } catch (_error) {
      return this.createResponse(404, 'Not Found', 'text/plain', 'Malformed local resource path.');
    }
    if (!PACKAGED_FILE_SET.has(relativePath)) {
      return this.createResponse(404, 'Not Found', 'text/plain', 'Resource is not in the mobile asset manifest.');
    }
    const dot = relativePath.lastIndexOf('.');
    const extension = dot >= 0 ? relativePath.slice(dot).toLowerCase() : '';
    const mime = MIME_TYPES[extension] ?? 'application/octet-stream';
    return this.createResponse(200, 'OK', mime, $rawfile(`web/${relativePath}`));
  }

  @Builder
  private tutorialOverlay(tutorialGeneration: number, tutorialController: webview.WebviewController) {
    if (this.tutorialUrl.length > 0) {
      Column() {
        Row({ space: 8 }) {
          if (this.tutorialError.length > 0) {
            Text(this.tutorialError).fontSize(12).fontColor('#B42318').layoutWeight(1);
          } else {
            Text('教学模式 / Tutorial').fontSize(14).layoutWeight(1);
          }
          Button('关闭 / Close').onClick(() => this.closeTutorialOverlay());
        }
        .width('100%')
        .height(48)
        .padding({ left: 8, right: 8 });
        Web({ src: this.tutorialUrl, controller: tutorialController })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          .onOverrideUrlLoading((event) => {
            if (!event || !this.isCurrentTutorial(tutorialGeneration, tutorialController)) return true;
            try {
              const candidate = new url.URL(event.getRequestUrl());
              return !this.isAllowedTutorialTarget(candidate.toString());
            } catch (_error) {
              return true;
            }
          })
          .onInterceptRequest((event) => {
            if (!event || !this.isCurrentTutorial(tutorialGeneration, tutorialController)) {
              return this.createResponse(403, 'Forbidden', 'text/plain', 'Tutorial generation is no longer active.');
            }
            return this.interceptTutorialRequest(event.request.getRequestUrl());
          })
          .onErrorReceive(() => {
            if (!this.isCurrentTutorial(tutorialGeneration, tutorialController)) return;
            this.tutorialError = '教学页加载失败 / Tutorial page failed to load.';
          })
          .width('100%')
          .layoutWeight(1);
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#ffffff');
    }
  }

  @Builder
  private mainPageWeb(controller: webview.WebviewController, generation: number, proxy: LifelineNativeProxy) {
        Web({ src: `${LOCAL_ORIGIN}/index.html`, controller: controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          .javaScriptProxy({ object: proxy, name: 'LifelineArkTS', methodList: ['callNative'], controller: controller })
          .onOverrideUrlLoading((event) => {
            if (!this.isCurrentMainWeb(controller, generation) || !event) return true;
            let requestUrl: string = '';
            let parsed: url.URL;
            try {
              requestUrl = event.getRequestUrl();
              parsed = new url.URL(requestUrl);
            } catch (_error) {
              return true;
            }
            if (parsed.protocol === 'https:' && parsed.origin === LOCAL_ORIGIN
              && parsed.username === '' && parsed.password === '') {
              this.externalOpenSequence += 1;
              this.externalOpenPending = false;
              return false;
            }

            // ArkWeb documents that POST, HTTP(S) iframe loads and programmatic loadUrl calls do not reach this callback.
            // A true return blocks every external navigation received by this callback in the bridge-enabled WebView.
            let currentPageUrl: url.URL;
            let method: string;
            let mainFrame: boolean;
            let requestGesture: boolean;
            let registryGeneration: number;
            try {
              currentPageUrl = new url.URL(controller.getUrl());
              method = event.getRequestMethod().toUpperCase();
              mainFrame = event.isMainFrame();
              requestGesture = event.isRequestGesture();
              registryGeneration = WebControllerRegistry.currentGeneration(controller);
            } catch (_error) {
              return true;
            }
            if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
              || parsed.hostname.length === 0 || parsed.username !== '' || parsed.password !== ''
              || method !== 'GET' || !mainFrame || !requestGesture
              || currentPageUrl.protocol !== 'https:' || currentPageUrl.origin !== LOCAL_ORIGIN
              || currentPageUrl.username !== '' || currentPageUrl.password !== ''
              || !this.active || !this.ready || this.hostContext === null
              || registryGeneration < 0 || !WebControllerRegistry.isForeground()
              || this.externalOpenPending) return true;

            this.externalOpenPending = true;
            this.externalNavigationError = '';
            const attemptGeneration = this.attemptGeneration;
            const sequence = ++this.externalOpenSequence;
            const want: Want = {
              action: 'ohos.want.action.viewData',
              entities: ['entity.system.browsable'],
              uri: requestUrl,
            };
            const finish = (failed: boolean): void => {
              if (!this.isCurrentAttempt(attemptGeneration) || !this.ready || sequence !== this.externalOpenSequence
                || WebControllerRegistry.currentGeneration(controller) !== registryGeneration) return;
              this.externalOpenPending = false;
              if (failed) this.externalNavigationError = '无法打开外部网页 / Unable to open the external page.';
            };
            try {
              this.hostContext.startAbility(want).then(
                () => finish(false),
                () => finish(true),
              );
            } catch (_error) {
              finish(true);
            }
            return true;
          })
          .onPageBegin(() => {
            if (!this.isCurrentMainWeb(controller, generation)) return;
            this.externalOpenSequence += 1;
            this.externalOpenPending = false;
            this.closeTutorialOverlay();
            void NetworkStatusMonitor.stop().catch(() => {});
            WebControllerRegistry.markLoading(controller);
          })
          .onPageEnd(() => {
            if (!this.isCurrentMainWeb(controller, generation)) return;
            WebControllerRegistry.markReady(controller);
            this.mainPageFailureMessage = '';
          })
          .onInterceptRequest((event) => {
            if (!this.isCurrentMainWeb(controller, generation) || !event) return null;
            const requestUrl = event.request.getRequestUrl();
            if (!requestUrl.startsWith(`${LOCAL_ORIGIN}/`) && requestUrl !== LOCAL_ORIGIN) return null;
            return this.interceptLocalRequest(requestUrl);
          })
          .onErrorReceive((event) => {
            if (!this.isCurrentMainWeb(controller, generation)) return;
            try {
              if (event && event.request.isMainFrame()) {
                this.recoverMainPage('主页面运行期加载失败 / Main page load failed', controller, generation);
              }
            } catch (_error) {}
          })
          .onHttpErrorReceive((event) => {
            if (!this.isCurrentMainWeb(controller, generation)) return;
            try {
              if (event && this.mainPageRecoveryPolicy.shouldRecoverHttpError(
                event.request.isMainFrame(), event.response.getResponseCode()
              )) {
                this.recoverMainPage('主页面收到 HTTP 错误响应 / Main page received an HTTP error response', controller, generation);
              }
            } catch (_error) {}
          })
          .onRenderExited(() => {
            if (!this.isCurrentMainWeb(controller, generation)) return;
            this.recoverMainPage('主页面渲染进程已退出 / Main page renderer exited', controller, generation);
          })
          .width('100%')
          .height('100%');
  }

  build() {
    Column() {
      if (this.ready && this.mainPageFailed) {
        Column({ space: 16 }) {
          Text('游戏页面暂时无法恢复 / The game page could not recover').fontSize(20).textAlign(TextAlign.Center);
          Text(this.mainPageFailureMessage).fontSize(14).textAlign(TextAlign.Center);
          Text('已保存的棋局会在页面恢复后重新载入。/ The saved game will load after recovery.').fontSize(14).textAlign(TextAlign.Center);
          Button('手动重试 / Retry').onClick(() => this.recoverMainPage('手动重试', this.controller, this.mainPageRecoveryPolicy.generation(), true));
        }.width('100%').height('100%').padding(28).justifyContent(FlexAlign.Center);
      } else if (this.ready && this.nativeProxy !== null) {
        if (this.externalNavigationError.length > 0) {
          Text(this.externalNavigationError)
            .fontSize(12)
            .fontColor('#B42318')
            .textAlign(TextAlign.Center)
            .width('100%')
            .padding({ left: 12, right: 12, top: 6, bottom: 6 });
        }
        if (this.backNavigationError.length > 0) {
          Row({ space: 8 }) {
            Text(this.backNavigationError)
              .fontSize(12)
              .fontColor('#B42318')
              .layoutWeight(1);
            Button('重试返回')
              .onClick(() => this.onBackPress());
          }
          .width('100%')
          .padding({ left: 12, right: 12, top: 6, bottom: 6 });
        }
        Stack() {
        this.mainPageWeb(this.controller, this.mainPageRecoveryPolicy.generation(), this.nativeProxy);
        this.tutorialOverlay(this.tutorialOwnerGeneration, this.tutorialController);
        }
        .width('100%')
        .layoutWeight(1);
      } else {
        Column() {
          Text(this.startupMessage)
            .fontSize(16)
            .fontColor('#315b4b')
            .textAlign(TextAlign.Center)
            .width('90%');
          if (this.startupPhase === 'failed') {
            Button('重试初始化')
              .onClick(() => this.retryHostInitialization())
              .margin({ top: 20 });
          }
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center);
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#fbfaf7');
  }
}
