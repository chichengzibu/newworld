/**
 * New World - 鸿蒙 PC 主 Ability
 *
 * 说明:在官方 OHOS Electron runtime 下,真正的 UI 由 Electron 渲染进程
 * (ArkWeb)承载,本 Ability 主要负责窗口宿主与生命周期桥接。
 * pages/Index 仅作为 runtime 尚未接管窗口时的占位/启动页,
 * 一旦 runtime 接管,应改为由 runtime 提供的窗口内容(见下方 TODO)。
 */

import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN: number = 0xF001;
const TAG: string = 'New WorldAbility';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate, launchReason=%{public}d', launchParam.launchReason);
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageCreate');

    // ================================================================
    // TODO(需官方 OHOS Electron runtime 确认):把窗口交给 Electron
    // ----------------------------------------------------------------
    // 鸿蒙 PC Electron runtime 需要拿到 WindowStage 才能创建 BrowserWindow
    // 对应的原生窗口(ArkWeb 承载)。官方 API 未知,不臆造调用。
    // 预期形如:
    //   ElectronRuntime.attachWindowStage(this.context, windowStage);
    // 接管成功后应跳过下面的 loadContent,否则占位页会盖住 Electron 内容。
    // ================================================================

    windowStage.loadContent('pages/Index', (err: BusinessError) => {
      if (err.code !== 0) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent succeeded');
    });

    // 鸿蒙 PC(2in1)默认窗口尺寸。
    // TODO(需 DevEco 真机确认): 与 WindowManager 的默认尺寸(桌面端)对齐,
    // 并处理多显示器 / 高 DPI 缩放。
    windowStage.getMainWindow((err: BusinessError, win: window.Window) => {
      if (err.code !== 0) {
        hilog.warn(DOMAIN, TAG, 'getMainWindow failed: %{public}s', JSON.stringify(err));
        return;
      }
      win.resize(1280, 800, (resizeErr: BusinessError) => {
        if (resizeErr.code !== 0) {
          hilog.warn(DOMAIN, TAG, 'resize failed: %{public}s', JSON.stringify(resizeErr));
        }
      });
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
  }
}
