/**
 * New World — i18n key 审计测试
 * ═══════════════════════════════════════════════════════════════
 * 【这个测试是为哪件事加的】
 * 实际跑起应用看控制台,发现:
 *   Not found 'nav.search' key in 'zh' locale messages.  (SideNav.vue)
 *   Not found 'nav.voice'  key in 'zh' locale messages.  (SideNav.vue)
 *
 * 两个侧边栏图标(搜索 / 语音)的 tooltip 与 aria-label **没有文案** ——
 * 路由是存在的、图标是画得出来的,唯独文案是空的。
 *
 * 【为什么这类问题容易漏】
 * 1. 不报错、不崩 —— 只是少一行文案
 * 2. **动态 key 扫不出来** —— SideNav 用的是 `t(item.titleKey)`,
 *    字面量 grep 完全看不见;只有把 titleKey 的**取值**收集起来才能查
 * 3. 语言包是嵌套对象 —— 用扁平字符串比对会漏掉一大半(全是假警报)
 *
 * 故本测试直接 **import 语言包** 拿到真实结构,再把源码里用到的
 * key(字面量 + 动态取值)全部核对一遍。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import zhCN from '../../src/locales/zh-CN'
import enUS from '../../src/locales/en-US'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'src')

/** 嵌套对象 → 扁平 key 路径 */
function flatten(obj: any, prefix = ''): Set<string> {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key).forEach(x => out.add(x))
    else out.add(key)
  }
  return out
}

/** 收集 src/ 里用到的所有 i18n key */
function collectUsedKeys(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>()
  const add = (k: string, file: string) => {
    if (!used.has(k)) used.set(k, new Set())
    used.get(k)!.add(file)
  }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!full.includes(`${path.sep}locales`)) walk(full)
        continue
      }
      if (!/\.(vue|ts)$/.test(entry.name)) continue
      const src = fs.readFileSync(full, 'utf-8')
      const file = path.relative(ROOT, full)
      // 字面量 t('...') / $t('...')
      for (const m of src.matchAll(/\b\$?t\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) add(m[1], file)
      // 动态 key 的取值来源:titleKey / labelKey / i18nKey / messageKey / nameKey
      for (const m of src.matchAll(/(?:titleKey|labelKey|i18nKey|messageKey|nameKey)\s*:\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
        add(m[1], file)
      }
    }
  }
  walk(SRC)
  return used
}

describe('i18n key 审计', () => {
  const zh = flatten(zhCN)
  const en = flatten(enUS)
  const used = collectUsedKeys()

  it('zh-CN 覆盖了源码里用到的所有 key', () => {
    const missing: string[] = []
    for (const [key, files] of used) {
      if (!zh.has(key)) missing.push(`${key}  ← ${[...files].join(', ')}`)
    }
    expect(missing, `zh-CN 缺 key(界面会显示空文案/原始 key):\n${missing.join('\n')}`).toEqual([])
  })

  it('en-US 覆盖了源码里用到的所有 key', () => {
    const missing: string[] = []
    for (const [key, files] of used) {
      if (!en.has(key)) missing.push(`${key}  ← ${[...files].join(', ')}`)
    }
    expect(missing, `en-US 缺 key:\n${missing.join('\n')}`).toEqual([])
  })

  it('两种语言的 key 集合一致(没有只翻一边的)', () => {
    const onlyZh = [...zh].filter(k => !en.has(k)).sort()
    const onlyEn = [...en].filter(k => !zh.has(k)).sort()
    expect({ onlyZh, onlyEn }, '两种语言 key 集合应一致').toEqual({ onlyZh: [], onlyEn: [] })
  })

  it('审计本身是有效的(能抓到确实缺 key 的情况)', () => {
    // 护栏:如果上面的收集逻辑坏了(比如只收集字面量、漏掉动态 key),
    // 这个用例会通过而真正的问题抓不到 → 审计就形同虚设。
    // 用一个**真实存在过**的缺失 key 做对照:nav.search / nav.voice / common.ok
    // (它们在应用实际跑起来时被控制台报出来过)
    expect(used.has('nav.search')).toBe(true)      // 动态 key 也被收集到了
    expect(used.has('nav.voice')).toBe(true)
    expect(used.has('common.ok')).toBe(true)
    // 且它们现在都在语言包里
    expect(zh.has('nav.search')).toBe(true)
    expect(en.has('nav.search')).toBe(true)
  })
})
