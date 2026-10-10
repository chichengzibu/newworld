/**
 * Vite `define` 注入的构建期常量声明 (v4.5+)
 *
 * vite.config.mts 的 define 段会在编译期把这两个裸标识符替换为字符串字面量:
 *   __APP_VERSION__ → JSON.stringify(npm_package_version)
 *   __BUILD_TIME__  → JSON.stringify(new Date().toLocaleString('zh-CN'))
 *
 * 渲染端代码 (src/stores/perf.ts) 直接引用它们读构建信息。
 * 本声明文件给 vue-tsc 提供 ambient 类型, 避免每处 use 点都要 @ts-ignore。
 *
 * 为什么不在 `src/stores/perf.ts` 里写 `declare const`:
 *   - esbuild 的 define 替换发生在值位置, 若同名 declare 在模块作用域,
 *     替换产物 (const 声明 vs 声明语句) 可能语法冲突, 已知不稳。
 *   - 模块顶层用 `const APP_VERSION: string = __APP_VERSION__;` 赋值最稳:
 *     define 替换后 = `const APP_VERSION: string = "4.5.0";`, 零风险。
 *
 * 红线: 本文件只声明 vite define 注入的两个常量。 不要在这里声明其它全局,
 *       避免与 electron preload 注入的 window.electronAPI 等真运行时对象撞名。
 */

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
