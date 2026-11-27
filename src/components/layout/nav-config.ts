/**
 * New World — 侧栏信息架构（IA）单一数据源 · v4.7
 * ═══════════════════════════════════════════════════════════════
 * 【v4.7 第二轮优化：从「形式收敛」到「语义重组」】
 * v4.6 只是把 7 个平级图标减到 5 个 + 一个「更多」抽屉，但抽屉里混装了
 * 输入能力（搜索/语音）、配置管理（权限/远程控制/IM 账号）和内容浏览，
 * 且 rail 上仍是「模型管理 / IM 管理」这类配置页占一级导航 —— 与
 * Claude（按内容对象分组）/ VS Code（按工作对象分组）的心智相反。
 *
 * 现在按用户心智分四层，**不删任何路由**：
 *
 *   1. 工作对象  PRIMARY_NAV   → rail 常驻（对话 / 技能 / 定时任务）
 *   2. 输入能力  INPUT_TOOLS   → ChatInput 工具条（搜索 / 语音）
 *   3. 配置容器  SETTINGS_*    → 设置页内的配置导航（模型 / IM / 权限 / 远程 / 账号）
 *   4. 内容浏览  MORE_GROUPS   → 「更多」面板（私有技能仓库）
 *
 * 命令面板 Ctrl+K 仍是全量兜底。设置入口留在 rail 底部（a.nav-icon），
 * 既满足「配置容器」的入口语义，又兼容大量既有 e2e 选择器。
 *
 * 【契约】PRODUCTION_ROUTES 必须与 router/index.ts 的生产路由一一对应；
 * 四层路径加起来必须恰好覆盖它、且无重复。由 tests/unit/nav-ia.test.ts 锁定。
 */
import type { Component } from 'vue'
import {
  ChatDotRound, Box, Calendar, ChatLineRound,
  Search, Microphone, Connection,
  Goods, Lock, User,
} from '@element-plus/icons-vue'

export interface PrimaryNavItem {
  path: string
  titleKey: string
  icon: Component
}

export interface NavLinkItem {
  path: string
  titleKey: string
  descKey: string
  icon: Component
}

export type MoreNavItem = NavLinkItem

export interface MoreNavGroup {
  key: string
  labelKey: string
  items: MoreNavItem[]
}

export const SETTINGS_PATH = '/settings'

/** 生产构建中全部可达页面（与 router/index.ts 对齐，devOnly 与重定向不计入） */
export const PRODUCTION_ROUTES = [
  '/chat',
  '/models',
  '/skills',
  '/schedule',
  '/im-management',
  '/search',
  '/voice',
  '/remote-control',
  '/clawhub',
  '/permissions',
  '/settings/im-accounts',
  '/settings',
] as const

/** 第 1 层：工作对象 —— rail 常驻。数量由契约锁定为 3。 */
export const PRIMARY_NAV: PrimaryNavItem[] = [
  { path: '/chat', titleKey: 'nav.chat', icon: ChatDotRound },
  { path: '/skills', titleKey: 'nav.skills', icon: Box },
  { path: '/schedule', titleKey: 'nav.schedule', icon: Calendar },
]

/** 「对话」是主入口，与「技能 / 定时任务」之间渲染一条细分隔线 */
export const PRIMARY_DIVIDER_AFTER = 1

/** 第 2 层：输入能力 —— 属于「我怎么输入」，下沉到 ChatInput 工具条 */
export const INPUT_TOOLS: NavLinkItem[] = [
  { path: '/search', titleKey: 'nav.search', descKey: 'nav.descSearch', icon: Search },
  { path: '/voice', titleKey: 'nav.voice', descKey: 'nav.descVoice', icon: Microphone },
]

/**
 * 第 3 层：配置容器 —— 从 rail / 更多里收编回设置页，不再散落三处。
 *
 * 【去重】模型管理原本既在设置页 navTabs(内嵌面板，有完整 CRUD)，又在本配置中心
 * 列了一次 → 设置页左侧出现两个「模型管理」。模型管理是设置页内建 tab，不在这里
 * 重复；配置中心只收纳 navTabs 里确实没有的配置入口。见 SETTINGS_EMBEDDED_PATHS。
 */
export const SETTINGS_LINKS: NavLinkItem[] = [
  { path: '/im-management', titleKey: 'nav.imManagement', descKey: 'nav.descImManagement', icon: ChatLineRound },
  { path: '/permissions', titleKey: 'nav.permissions', descKey: 'nav.descPermissions', icon: Lock },
  { path: '/remote-control', titleKey: 'nav.remoteControl', descKey: 'nav.descRemoteControl', icon: Connection },
  { path: '/settings/im-accounts', titleKey: 'nav.imAccounts', descKey: 'nav.descImAccounts', icon: User },
]

/**
 * 由设置页内嵌 tab 承载、不在配置中心重复列出的路由。
 * 仍计入 ALL_NAV_PATHS(路由可达契约)，但入口在 Settings.vue 的 navTabs 里。
 */
export const SETTINGS_EMBEDDED_PATHS: string[] = ['/models']

/** 第 4 层：内容浏览 —— 「更多」现在只剩同质的浏览项，不再是杂物抽屉 */
export const MORE_GROUPS: MoreNavGroup[] = [
  {
    key: 'browse',
    labelKey: 'nav.groupBrowse',
    items: [
      { path: '/clawhub', titleKey: 'nav.clawhub', descKey: 'nav.descClawhub', icon: Goods },
    ],
  },
]

/** 拍平，供「更多」按钮高亮判定与测试使用 */
export const MORE_ITEMS: MoreNavItem[] = MORE_GROUPS.flatMap((g) => g.items)

/** 四层合起来的完整可达清单（契约单测直接比对 PRODUCTION_ROUTES） */
export const ALL_NAV_PATHS: string[] = [
  ...PRIMARY_NAV.map((i) => i.path),
  ...INPUT_TOOLS.map((i) => i.path),
  ...SETTINGS_LINKS.map((i) => i.path),
  ...SETTINGS_EMBEDDED_PATHS,
  SETTINGS_PATH,
  ...MORE_ITEMS.map((i) => i.path),
]
