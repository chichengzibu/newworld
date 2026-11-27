/**
 * New World — 侧栏信息架构契约测试 (v4.7 四层分组)
 * ═══════════════════════════════════════════════════════════════
 * v4.6 只锁「rail 5 个 + 覆盖 14 路由」。v4.7 把信息架构按用户心智
 * 重组成四层（工作对象 / 输入能力 / 配置容器 / 内容浏览），契约随之升级：
 *
 *   · rail 只放 3 个「工作对象」，不再有模型/IM 这类配置页
 *   · 输入能力在 ChatInput、配置页在 Settings、浏览项在「更多」，各归其位
 *   · 四层路径加起来恰好覆盖全部生产路由，无重复、无遗漏
 *   · 覆盖清单与 router/index.ts 真实声明一致
 *   · 每个入口的 i18n key 在中英文案里都存在
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PRIMARY_NAV, PRIMARY_DIVIDER_AFTER, INPUT_TOOLS, SETTINGS_LINKS, SETTINGS_EMBEDDED_PATHS,
  MORE_GROUPS, MORE_ITEMS, SETTINGS_PATH, PRODUCTION_ROUTES, ALL_NAV_PATHS,
} from '../../src/components/layout/nav-config'
import zhCN from '../../src/locales/zh-CN'
import enUS from '../../src/locales/en-US'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function flatten(obj: unknown, prefix = ''): Set<string> {
  const out = new Set<string>()
  for (const [k, v] of Object.entries((obj ?? {}) as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key).forEach((x) => out.add(x))
    else out.add(key)
  }
  return out
}

/** 从 router/index.ts 解析「生产可用路由」,跳过 redirect 与 devOnly */
function productionRoutesFromRouter(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'src/router/index.ts'), 'utf-8')
  // 每个顶层路由以 "\n  {\n" 开始(兼容 CRLF;{2} 避免 no-regex-spaces)
  const blocks = src.split(/\r?\n {2}\{\r?\n/).slice(1)
  const out: string[] = []
  for (const block of blocks) {
    const m = block.match(/path:\s*'(\/[^']*)'/)
    if (!m) continue
    if (/\bredirect\s*:/.test(block)) continue
    if (/\bdevOnly\s*:\s*true/.test(block)) continue
    out.push(m[1])
  }
  return out
}

describe('侧栏信息架构契约 (v4.7)', () => {
  it('rail 只放 3 个工作对象，第一项仍是对话', () => {
    expect(PRIMARY_NAV).toHaveLength(3)
    expect(PRIMARY_NAV.map((i) => i.path)).toEqual(['/chat', '/skills', '/schedule'])
    expect(PRIMARY_DIVIDER_AFTER).toBe(1)
    // 配置类页面不得再占一级导航
    const configPaths = ['/models', '/im-management', '/permissions', '/remote-control']
    for (const p of configPaths) {
      expect(PRIMARY_NAV.map((i) => i.path), `${p} 是配置页,不应在 rail 上`).not.toContain(p)
    }
  })

  it('四层各司其职，且不含已下线的路由', () => {
    expect(INPUT_TOOLS.map((i) => i.path)).toEqual(['/search', '/voice'])
    expect(SETTINGS_LINKS.map((i) => i.path)).toEqual([
      '/im-management', '/permissions', '/remote-control', '/settings/im-accounts',
    ])
    // 模型管理是设置页内建 tab，不得在配置中心重复列出（否则左侧出现两个「模型管理」）
    expect(SETTINGS_EMBEDDED_PATHS).toEqual(['/models'])
    expect(SETTINGS_LINKS.map((i) => i.path)).not.toContain('/models')
    expect(MORE_ITEMS.map((i) => i.path)).toEqual(['/clawhub'])
    expect(MORE_GROUPS).toHaveLength(1)

    // v4.9：模型对比 / 帮助中心已按用户要求下线，不得回潮
    const retired = ['/dashboard', '/tasks', '/plugin-market', '/settings/llm-config', '/model-compare', '/help']
    for (const p of retired) {
      expect(ALL_NAV_PATHS, `${p} 已下线,不应再出现在导航里`).not.toContain(p)
    }
  })

  it('「更多」不再混装输入能力与配置管理', () => {
    const morePaths = new Set(MORE_ITEMS.map((i) => i.path))
    for (const p of ['/search', '/voice', '/models', '/permissions', '/remote-control', '/settings/im-accounts']) {
      expect(morePaths.has(p), `${p} 不该留在杂物抽屉里`).toBe(false)
    }
  })

  it('四层路径唯一，且恰好覆盖全部生产路由', () => {
    expect(new Set(ALL_NAV_PATHS).size, '入口 path 不得重复').toBe(ALL_NAV_PATHS.length)
    expect([...ALL_NAV_PATHS].sort()).toEqual([...PRODUCTION_ROUTES].sort())
  })

  it('覆盖清单与 router/index.ts 的实际声明一致', () => {
    const fromRouter = productionRoutesFromRouter().sort()
    expect(fromRouter.length, 'router 解析结果为空,检查解析正则是否失效').toBeGreaterThan(10)
    expect([...PRODUCTION_ROUTES].sort()).toEqual(fromRouter)
  })

  it('设置容器路径存在且所有配置入口都归位（配置中心 4 + 内嵌 tab 1）', () => {
    expect(SETTINGS_PATH).toBe('/settings')
    expect(ALL_NAV_PATHS).toContain(SETTINGS_PATH)
    expect(SETTINGS_LINKS).toHaveLength(4)
    expect(SETTINGS_EMBEDDED_PATHS).toEqual(['/models'])
    for (const g of MORE_GROUPS) {
      expect(g.items.length, `分组 ${g.key} 不能为空`).toBeGreaterThan(0)
      expect(g.labelKey).toMatch(/^nav\./)
    }
  })

  it('每个入口的 i18n key 在 zh / en 都存在(界面不会显示原始 key)', () => {
    const zh = flatten(zhCN)
    const en = flatten(enUS)
    const keys = [
      ...PRIMARY_NAV.map((i) => i.titleKey),
      ...INPUT_TOOLS.flatMap((i) => [i.titleKey, i.descKey]),
      ...SETTINGS_LINKS.flatMap((i) => [i.titleKey, i.descKey]),
      ...MORE_ITEMS.flatMap((i) => [i.titleKey, i.descKey]),
      ...MORE_GROUPS.map((g) => g.labelKey),
      'nav.settings', 'nav.more', 'nav.moreHint', 'settings.configNavTitle',
    ]
    for (const k of keys) {
      expect(zh.has(k), `zh-CN 缺 ${k}`).toBe(true)
      expect(en.has(k), `en-US 缺 ${k}`).toBe(true)
    }
  })
})
