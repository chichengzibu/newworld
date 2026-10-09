import { appTasks } from '@ohos/hvigor-ohos-plugin';

/**
 * 工程级 hvigor 构建脚本。
 * 请勿手工改动 system 字段;自定义任务放入 plugins 数组。
 *
 * TODO(需官方 OHOS Electron runtime / DevEco 确认):
 *   官方鸿蒙 PC Electron runtime 可能提供 hvigor 插件,
 *   用于把 Electron 二进制与 app 资源(dist/ + dist-electron/)注入 HAP。
 *   拿到官方包后在此处 plugins 中注册,例如:
 *     import { electronPlugin } from '@ohos/electron-hvigor-plugin'
 *     plugins: [electronPlugin({ appDir: './entry/assets/app' })]
 */
export default {
  system: appTasks,
  plugins: []
};
