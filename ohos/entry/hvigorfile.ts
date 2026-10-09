import { hapTasks } from '@ohos/hvigor-ohos-plugin';

/**
 * entry 模块级 hvigor 构建脚本。
 * 请勿手工改动 system 字段;自定义任务放入 plugins 数组。
 *
 * TODO(需官方 OHOS Electron runtime / DevEco 确认):
 *   把 entry/assets/app/(由 ohos/scripts/sync-assets.mjs 生成,含 dist/ 与
 *   dist-electron/)注入 HAP 的方式有两条路,取决于官方 runtime 的加载约定:
 *     A. 复制进 src/main/resources/rawfile/,运行时用 resourceManager 解出;
 *     B. 由官方 hvigor 插件声明为 app 资源目录,runtime 直接以文件路径加载。
 *   当前 sync-assets.mjs 默认走 A 的暂存形态(entry/assets),真实注入点待确认。
 */
export default {
  system: hapTasks,
  plugins: []
};
