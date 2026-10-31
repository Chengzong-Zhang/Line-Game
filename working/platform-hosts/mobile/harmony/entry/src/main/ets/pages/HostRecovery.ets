import { hostContentRecovery } from '../bridge/HostContentRecovery';
import { common } from '@kit.AbilityKit';

@Entry
@Component
struct HostRecovery {
  @State private pending: boolean = false;
  @State private failureMessage: string = '';
  private observerId: number = -1;
  @State private backError: string = '';

  aboutToAppear(): void {
    this.refreshState();
    this.observerId = hostContentRecovery.subscribe(() => this.refreshState());
  }

  aboutToDisappear(): void {
    if (this.observerId >= 0) {
      hostContentRecovery.unsubscribe(this.observerId);
      this.observerId = -1;
    }
  }

  private refreshState(): void {
    this.pending = hostContentRecovery.isPending();
    this.failureMessage = hostContentRecovery.message();
  }

  private async moveToBackground(): Promise<void> {
    try {
      const hostContext = this.getUIContext().getHostContext();
      if (hostContext === undefined) throw new Error('应用上下文不可用');
      await (hostContext as common.UIAbilityContext).moveAbilityToBackground();
      this.backError = '';
    } catch (error) {
      this.backError = `无法返回桌面：${(error as Error).message || '未知错误'}。当前恢复页面仍保留。`;
    }
  }

  onBackPress(): boolean {
    void this.moveToBackground();
    return true;
  }

  build() {
    Column({ space: 18 }) {
      Text('暂时无法打开生命线')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
      Text(this.failureMessage)
        .fontSize(16)
        .textAlign(TextAlign.Center)
      if (this.backError.length > 0) {
        Text(this.backError)
          .fontSize(14)
          .textAlign(TextAlign.Center)
          .fontColor('#B42318')
      }
      Text(this.pending
        ? '系统尚未返回本次请求结果，当前调用无法取消；重试会在结果返回后重新开放。若一直没有返回，请关闭并重新打开应用。'
        : '若重试后仍无法打开，请关闭并重新打开应用。')
        .fontSize(14)
        .textAlign(TextAlign.Center)
        .fontColor('#667085')
      Button(this.pending ? '正在加载…' : '重试打开')
        .enabled(!this.pending)
        .onClick(() => {
          hostContentRecovery.retryMainPage();
        })
    }
    .width('100%')
    .height('100%')
    .padding(28)
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#F7F8FA')
  }
}
