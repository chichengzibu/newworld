/**
 * New World - i18n 国际化入口
 */

import { createI18n } from 'vue-i18n';
import zhCN from './zh-CN';
import enUS from './en-US';

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

export const LOCALE_STORAGE_KEY = 'nw:locale';

function resolveInitialLocale(): SupportedLocale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
      return stored as SupportedLocale;
    }
  } catch {
    // localStorage may not be available in tests
  }
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language?.toLowerCase() ?? '';
    if (lang.startsWith('zh')) return 'zh-CN';
  }
  return 'zh-CN';
}

/**
 * 【CSP 加固】消息形态选择:
 * - 优先用构建期预编译的 AST(见 vite.config.mts precompileI18nPlugin) —
 *   运行时走 JIT 解释路径, 零 new Function, CSP 无需 unsafe-eval
 * - generated/*.ast.json 不存在时(测试环境/预编译失败)回退字符串消息 —
 *   Node 环境无 CSP, 字符串路径天然可用
 * 注意: 中英必须同为 AST 或同为字符串, 混用会让 fallback 语言走 eval。
 */
const astModules = import.meta.glob('./generated/*.ast.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const astZh = astModules['./generated/zh-CN.ast.json'];
const astEn = astModules['./generated/en-US.ast.json'];
const useAst = Boolean(astZh && astEn);

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: resolveInitialLocale(),
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': (useAst ? astZh : zhCN) as Record<string, unknown>,
    'en-US': (useAst ? astEn : enUS) as Record<string, unknown>
  }
});

export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

export default i18n;