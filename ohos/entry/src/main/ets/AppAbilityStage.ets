/**
 * New World - 鸿蒙 PC AbilityStage(进程级入口)
 *
 * 职责:
 *   1. 进程创建时做一次性初始化(日志域、app 资源目录解析)。
 *   2. 作为官方 OHOS Electron runtime 主进程的挂载点 —— Electron 主进程
 *      (dist-electron/main.js)由 runtime 拉起,本文件负责把 HAP 内的
 *      app 资源目录与环境变量传给它。
 *
 * 与既有代码的对接关系:
 *   - electron/main.ts 第 0 步调用 initHost(),内部 detect.ts 依次检查
 *       process.env.NW_PLATFORM === 'ohos'
 *       process.platform === 'ohos'
 *       /etc/os-release 含 HarmonyOS/OpenHarmony/OHOS
 *     只要 runtime 能注入 NW_PLATFORM=ohos,HarmonyHost 即生效,
 *     Tray / GlobalShortcut / AutoUpdater / MiniWindow 自动降级为 no-op。
 *   - HarmonyHost 还会读取 NW_APP_PATH / NW_USER_DATA /
 *     NW_VERSION,分别对应 app 资源根、可写数据目录、版本号。
 */

import { AbilityStage } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xF001;
const TAG: string = 'NWStage';

export default class AppAbilityStage extends AbilityStage {
  onCreate(): void {
    hilog.info(DOMAIN, TAG, 'AbilityStage onCreate');

    // HAP 内的只读资源目录与应用私有可写目录。
    // filesDir 对应 HarmonyHost.getPath('userData') 期望的可写根。
    const filesDir: string = this.context.filesDir;
    const cacheDir: string = this.context.cacheDir;
    hilog.info(DOMAIN, TAG, 'filesDir=%{public}s cacheDir=%{public}s', filesDir, cacheDir);

    // ================================================================
    // TODO(需官方 OHOS Electron runtime 确认):在此启动 Electron 主进程
    // ----------------------------------------------------------------
    // 官方鸿蒙 PC Electron runtime v34.6.3-20260105.1 的初始化 API 未知,
    // 不臆造调用。取得官方 SDK 后,此处大致需要完成三件事:
    //
    //   1) 解出 app 资源:把 HAP 内的 app 目录(dist/ + dist-electron/,
    //      由 ohos/scripts/sync-assets.mjs 生成)释放到 filesDir 下,
    //      例如 `${filesDir}/app`。若 runtime 支持直接读 rawfile 则可跳过。
    //
    //   2) 注入环境变量,供 electron/platform/detect.ts 与 HarmonyHost 读取:
    //        NW_PLATFORM = 'ohos'          // 决定 initHost() 选 HarmonyHost
    //        NW_APP_PATH = `${filesDir}/app`
    //        NW_USER_DATA = filesDir
    //        NW_VERSION  = <AppScope/app.json5 versionName>
    //
    //   3) 以 `${filesDir}/app/dist-electron/main.js` 为入口启动主进程。
    //      渲染进程加载 dist/index.html —— vite 已设 base:'./',相对路径
    //      在 HAP 内不会白屏。preload 产物为 CJS,符合鸿蒙 runtime 要求。
    //
    // 伪代码(仅示意,勿直接使用):
    //   ElectronRuntime.start({
    //     appDir: `${filesDir}/app`,
    //     main: 'dist-electron/main.js',
    //     env: { NW_PLATFORM: 'ohos', NW_APP_PATH: `${filesDir}/app` }
    //   });
    // ================================================================
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'AbilityStage onDestroy');
    // TODO(需官方 OHOS Electron runtime 确认): 通知 runtime 优雅退出。
    // HarmonyHost 通过 process 的 SIGINT/SIGTERM 桥接 before-quit/quit 事件,
    // 因此 runtime 只要向主进程发送 SIGTERM,既有生命周期监听即可触发。
  }
}
