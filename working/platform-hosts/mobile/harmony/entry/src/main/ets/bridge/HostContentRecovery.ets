import { window } from '@kit.ArkUI';

const MAIN_PAGE: string = 'pages/Index';
const RECOVERY_PAGE: string = 'pages/HostRecovery';
const MAIN_PAGE_LOAD_TIMEOUT_MS: number = 15_000;
const RECOVERY_PAGE_LOAD_TIMEOUT_MS: number = 10_000;

interface LoadFailure {
  code?: number;
  message?: string;
}

interface RecoveryObserver {
  id: number;
  callback: () => void;
}

/** Owns one WindowStage's main-page load and its single non-recursive fallback. */
class HostContentRecovery {
  private stage: window.WindowStage | null = null;
  private generation: number = 0;
  private nextRequestId: number = 0;
  private activeRequestId: number = 0;
  private loadWatchdog: number = -1;
  private pending: boolean = false;
  private recoveryAttempted: boolean = false;
  private failureMessage: string = '';
  private nextObserverId: number = 0;
  private observers: Array<RecoveryObserver> = [];

  start(stage: window.WindowStage): void {
    if (this.stage === stage) return;
    this.cancelActiveLoad();
    this.generation += 1;
    this.stage = stage;
    this.recoveryAttempted = false;
    this.failureMessage = '';
    this.loadMainPage(stage, this.generation);
  }

  destroyStage(): void {
    this.cancelActiveLoad();
    this.generation += 1;
    this.stage = null;
    this.recoveryAttempted = false;
    this.notifyObservers();
  }

  retryMainPage(): boolean {
    const stage = this.stage;
    if (stage === null || this.pending) return false;
    this.cancelActiveLoad();
    this.recoveryAttempted = false;
    this.loadMainPage(stage, this.generation);
    return true;
  }

  isPending(): boolean {
    return this.pending;
  }

  message(): string {
    return this.failureMessage;
  }

  subscribe(callback: () => void): number {
    const id = ++this.nextObserverId;
    this.observers.push({ id, callback });
    return id;
  }

  unsubscribe(id: number): void {
    this.observers = this.observers.filter((observer) => observer.id !== id);
  }

  private notifyObservers(): void {
    const snapshot = this.observers.slice();
    for (const observer of snapshot) {
      if (!this.observers.some((active) => active.id === observer.id)) continue;
      try {
        observer.callback();
      } catch (_error) {
        this.unsubscribe(observer.id);
      }
    }
  }

  private isCurrent(stage: window.WindowStage, generation: number, requestId: number): boolean {
    return this.stage === stage && this.generation === generation && this.activeRequestId === requestId;
  }

  private clearLoadWatchdog(): void {
    if (this.loadWatchdog >= 0) {
      clearTimeout(this.loadWatchdog);
      this.loadWatchdog = -1;
    }
  }

  private cancelActiveLoad(): void {
    this.clearLoadWatchdog();
    this.pending = false;
    this.activeRequestId = 0;
  }

  private armMainPageWatchdog(stage: window.WindowStage, generation: number, requestId: number): void {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      if (!this.isCurrent(stage, generation, requestId)) return;
      this.loadWatchdog = -1;
      this.pending = false;
      this.activeRequestId = 0;
      this.failureMessage = `主页面加载超时（${MAIN_PAGE_LOAD_TIMEOUT_MS / 1000} 秒内系统未返回结果）。正在打开恢复页面。`;
      this.notifyObservers();
      this.loadRecoveryPage(stage, generation);
    }, MAIN_PAGE_LOAD_TIMEOUT_MS);
  }

  private armRecoveryPageWatchdog(stage: window.WindowStage, generation: number, requestId: number): void {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      if (!this.isCurrent(stage, generation, requestId)) return;
      this.loadWatchdog = -1;
      this.pending = false;
      this.activeRequestId = 0;
      this.failureMessage = `恢复页面加载超时（${RECOVERY_PAGE_LOAD_TIMEOUT_MS / 1000} 秒内系统未返回结果）。本次启动已结束；若仍看到此页面，可以重试，否则请关闭并重新打开应用。`;
      this.notifyObservers();
      console.error('LIFELINE recovery page load timed out.');
    }, RECOVERY_PAGE_LOAD_TIMEOUT_MS);
  }

  private describeFailure(label: string, error: LoadFailure): string {
    const detail = error.code === undefined ? error.message : `错误码 ${error.code}`;
    return `${label}（${detail || '未知错误'}）。可以重试；若仍失败，请关闭并重新打开应用。`;
  }

  private loadMainPage(stage: window.WindowStage, generation: number): void {
    if (this.stage !== stage || this.generation !== generation || this.pending) return;
    const requestId = ++this.nextRequestId;
    this.activeRequestId = requestId;
    this.pending = true;
    this.armMainPageWatchdog(stage, generation, requestId);
    this.notifyObservers();
    if (!this.isCurrent(stage, generation, requestId)) return;
    try {
      stage.loadContent(MAIN_PAGE, (error) => {
        if (!this.isCurrent(stage, generation, requestId)) return;
        this.clearLoadWatchdog();
        this.pending = false;
        this.activeRequestId = 0;
        if (error.code === 0) {
          this.failureMessage = '';
          this.notifyObservers();
          return;
        }
        this.failureMessage = this.describeFailure('主页面加载失败', error);
        this.notifyObservers();
        this.loadRecoveryPage(stage, generation);
      });
    } catch (error) {
      if (!this.isCurrent(stage, generation, requestId)) return;
      this.clearLoadWatchdog();
      this.pending = false;
      this.activeRequestId = 0;
      this.failureMessage = this.describeFailure('主页面加载失败', error as LoadFailure);
      this.notifyObservers();
      this.loadRecoveryPage(stage, generation);
    }
  }

  private loadRecoveryPage(stage: window.WindowStage, generation: number): void {
    if (this.stage !== stage || this.generation !== generation || this.pending || this.recoveryAttempted) return;
    this.recoveryAttempted = true;
    const requestId = ++this.nextRequestId;
    this.activeRequestId = requestId;
    this.pending = true;
    this.armRecoveryPageWatchdog(stage, generation, requestId);
    this.notifyObservers();
    if (!this.isCurrent(stage, generation, requestId)) return;
    try {
      stage.loadContent(RECOVERY_PAGE, (error) => {
        if (!this.isCurrent(stage, generation, requestId)) return;
        this.clearLoadWatchdog();
        this.pending = false;
        this.activeRequestId = 0;
        if (error.code !== 0) {
          this.failureMessage = this.describeFailure('恢复页面加载失败，本次启动已结束', error);
          console.error(`LIFELINE recovery page could not load: ${error.code}`);
        }
        this.notifyObservers();
      });
    } catch (error) {
      if (!this.isCurrent(stage, generation, requestId)) return;
      this.clearLoadWatchdog();
      this.pending = false;
      this.activeRequestId = 0;
      this.failureMessage = this.describeFailure('恢复页面加载失败，本次启动已结束', error as LoadFailure);
      this.notifyObservers();
      console.error(`LIFELINE recovery page could not load: ${String(error)}`);
    }
  }
}

export const hostContentRecovery = new HostContentRecovery();
