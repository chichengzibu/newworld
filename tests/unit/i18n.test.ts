import { describe, it, expect } from 'vitest';
import { createI18n } from 'vue-i18n';
import { baseCompile } from '@intlify/message-compiler';
import zhCN from '../../src/locales/zh-CN';
import enUS from '../../src/locales/en-US';

/**
 * 【CSP 加固】vue-i18n 已 alias 到 runtime-only bundle(不支持字符串消息编译)。
 * 测试里把字符串语言包现场编译成 AST —— 与生产路径(构建期 precompileI18nPlugin
 * 产出 AST → runtime bundle JIT 解释)保持一致。
 */
function toAst(obj: unknown, locale: string): unknown {
  if (typeof obj === 'string') return baseCompile(obj, { locale }).ast;
  if (Array.isArray(obj)) return obj.map((v) => toAst(v, locale));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = toAst(v, locale);
    return out;
  }
  return obj;
}

function flattenKeys(obj: any, prefix = ''): string[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== 'object') return [];
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') return [path];
    if (value && typeof value === 'object') return flattenKeys(value, path);
    return [];
  });
}

function lookup(obj: any, path: string): unknown {
  return path.split('.').reduce<any>((acc, segment) => acc?.[segment], obj);
}

describe('i18n locale parity', () => {
  it('zh-CN and en-US have identical key paths', () => {
    const zhKeys = new Set(flattenKeys(zhCN));
    const enKeys = new Set(flattenKeys(enUS));

    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));

    expect(missingInEn, `Missing in en-US: ${missingInEn.join(', ')}`).toEqual([]);
    expect(missingInZh, `Missing in zh-CN: ${missingInZh.join(', ')}`).toEqual([]);
  });

  it('no empty string values in either locale', () => {
    for (const [name, locale] of [
      ['zh-CN', zhCN],
      ['en-US', enUS]
    ] as const) {
      const flat = flattenKeys(locale);
      for (const key of flat) {
        const val = lookup(locale, key);
        expect(val, `${name}.${key} should not be empty`).toBeTruthy();
        expect(typeof val, `${name}.${key} should be a string`).toBe('string');
        expect((val as string).trim().length, `${name}.${key} should have non-whitespace content`).toBeGreaterThan(0);
      }
    }
  });

  it('vue-i18n composes both locales and switches correctly', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'zh-CN',
      fallbackLocale: 'en-US',
      messages: {
        'zh-CN': toAst(zhCN, 'zh-CN'),
        'en-US': toAst(enUS, 'en-US')
      }
    });

    expect(i18n.global.t('common.save')).toBe('保存');
    expect(i18n.global.t('common.save')).not.toBe('Save');

    i18n.global.locale.value = 'en-US';
    expect(i18n.global.t('common.save')).toBe('Save');

    expect(i18n.global.t('nav.settings')).toBe('Settings');

    const interpolated = i18n.global.t('chat.selectedCount', { count: 5 });
    expect(interpolated).toContain('5');
  });

  it('interpolation tokens are present on both sides', () => {
    const zhKeys = new Set(flattenKeys(zhCN));
    const enKeys = new Set(flattenKeys(enUS));
    const tokenRegex = /\{(\w+)\}/g;

    const sampleWithTokens = ['chat.selectedCount', 'models.modelsCount', 'models.providerCount', 'models.latencyMs'];

    for (const key of sampleWithTokens) {
      expect(zhKeys.has(key), `zh-CN missing ${key}`).toBe(true);
      expect(enKeys.has(key), `en-US missing ${key}`).toBe(true);

      const zhVal = lookup(zhCN, key) as string;
      const enVal = lookup(enUS, key) as string;

      const zhTokens = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = tokenRegex.exec(zhVal))) {
        zhTokens.add(m[1]);
      }
      const enTokens = new Set<string>();
      while ((m = tokenRegex.exec(enVal))) {
        enTokens.add(m[1]);
      }

      expect([...zhTokens].sort()).toEqual([...enTokens].sort());
    }
  });

  it('contains the required namespaces', () => {
    // 注: tasks 命名空间已随 Tasks.vue 下线删除(/tasks 现重定向到 /schedule)
    const required = ['common', 'nav', 'settings', 'chat', 'skills', 'schedule', 'permissions', 'models', 'about'];
    for (const ns of required) {
      expect((zhCN as any)[ns], `zh-CN missing namespace "${ns}"`).toBeDefined();
      expect((enUS as any)[ns], `en-US missing namespace "${ns}"`).toBeDefined();
    }
  });
});