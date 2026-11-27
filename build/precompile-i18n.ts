/**
 * 【CSP 加固】vue-i18n 消息构建期预编译插件(共享模块)
 *
 * 被 vite.config.mts / vite.config.e2e.mts / vitest.config.ts 共用。
 *
 * 背景: vue-i18n 对「字符串消息」用 new Function 运行时编译 —— 需要 CSP 放开
 * unsafe-eval(Electron 安全警告 + 注入风险)。收紧 CSP 后必须把消息变成
 * 免 eval 形态: 构建期把语言包编译成 AST JSON, 运行时走 JIT 解释路径
 * (core-base 的 isMessageAST 分支, 零 new Function)。
 *
 * 配套: vue-i18n 必须同时 alias 到 runtime-only bundle
 * (vue-i18n/dist/vue-i18n.runtime.esm-bundler.js) —— full bundle 注册了
 * compileToFunction, 收到 AST 消息会抛 NOT_SUPPORT_NON_STRING_MESSAGE
 * 且被 onError 吞掉, translate 返回原始 AST 对象导致界面文案全坏。
 *
 * 实现(零新依赖): esbuild(vite 内置)转 TS → data-url import 加载 →
 * @intlify/message-compiler(vue-i18n 自带依赖)逐条 baseCompile → 写 AST JSON。
 * src/locales/index.ts 通过 import.meta.glob 优先取 AST, 缺文件时回退字符串。
 */
import { transformWithEsbuild } from 'vite';
import { baseCompile } from '@intlify/message-compiler';
import { resolve } from 'path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// 项目根: 配置文件会被 esbuild 打包(vite.config.mts 走 CJS、vitest.config.ts 走 ESM),
// 共享模块里 __dirname 在 ESM 打包下未定义 —— vite/vitest 恒从项目根启动, 用 cwd 最稳。
const projectRoot = process.cwd();

export function precompileI18nPlugin() {
  const locales = ['zh-CN', 'en-US'];
  const outDir = resolve(projectRoot, 'src/locales/generated');

  async function loadMessages(file: string): Promise<Record<string, unknown>> {
    // 注: 本版 vite 的 transformWithEsbuild 是 async
    const { code } = await transformWithEsbuild(readFileSync(file, 'utf-8'), file);
    const mod = await import(
      'data:text/javascript;base64,' + Buffer.from(code, 'utf-8').toString('base64')
    );
    return mod.default as Record<string, unknown>;
  }

  function toAst(obj: unknown, locale: string): unknown {
    if (typeof obj === 'string') {
      return baseCompile(obj, { locale }).ast;
    }
    if (Array.isArray(obj)) return obj.map((v) => toAst(v, locale));
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = toAst(v, locale);
      return out;
    }
    return obj;
  }

  return {
    name: 'newworld-precompile-i18n',
    async buildStart() {
      mkdirSync(outDir, { recursive: true });
      for (const locale of locales) {
        try {
          const msgs = await loadMessages(resolve(projectRoot, `src/locales/${locale}.ts`));
          const ast = toAst(msgs, locale);
          writeFileSync(resolve(outDir, `${locale}.ast.json`), JSON.stringify(ast));
        } catch (e) {
          // 预编译失败不阻塞构建 —— index.ts 会回退字符串消息(dev/测试无 CSP)
           
          console.warn(`[precompile-i18n] ${locale} 预编译失败, 回退字符串: ${(e as Error).message}`);
        }
      }
    },
  };
}

/** 【CSP 加固】vue-i18n → runtime-only bundle, 配合预编译 AST 消息走 JIT 解释路径 */
export const vueI18nRuntimeAlias = {
  'vue-i18n': resolve(projectRoot, 'node_modules/vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'),
};
