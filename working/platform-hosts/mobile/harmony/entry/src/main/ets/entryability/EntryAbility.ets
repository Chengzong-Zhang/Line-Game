import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { WebControllerRegistry } from '../bridge/WebControllerRegistry';
import { hostContentRecovery } from '../bridge/HostContentRecovery';
import { NetworkStatusMonitor } from '../bridge/NetworkStatusMonitor';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want): void {
    console.info('LIFELINE HarmonyOS host created.');
  }

  onForeground(): void {
    NetworkStatusMonitor.setForeground(true);
    WebControllerRegistry.dispatchLifecycle('lifeline:foreground');
  }

  onBackground(): void {
    NetworkStatusMonitor.setForeground(false);
    WebControllerRegistry.dispatchLifecycle('lifeline:background');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hostContentRecovery.start(windowStage);
  }

  onWindowStageDestroy(): void {
    void NetworkStatusMonitor.stop().catch(() => {});
    hostContentRecovery.destroyStage();
  }
}
