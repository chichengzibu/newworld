/**
 * New World - 平台检测(纯 TS,不依赖 Electron)
 *
 * 关键坑:鸿蒙 PC 的 Node 运行时通常仍把 process.platform 报告为 'linux',
 * 因此仅靠 process.platform 无法区分鸿蒙。这里用多重信号判定:
 *   1. 显式环境变量 NW_PLATFORM=ohos(测试 / 打包注入)
 *   2. 未来 node 直接支持 'ohos'(保险)
 *   3. /etc/os-release 含 HarmonyOS / OpenHarmony / OHOS
 */

import { existsSync, readFileSync } from 'node:fs'
import type { PlatformId } from './PlatformHost'

/** 是否为鸿蒙 PC。多信号判定,标准 Electron 平台恒为 false。 */
export function isOhos(): boolean {
  if (process.env.NW_PLATFORM === 'ohos') return true
  if ((process.platform as string) === 'ohos') return true
  try {
    if (existsSync('/etc/os-release')) {
      const content = readFileSync('/etc/os-release', 'utf-8')
      if (/HarmonyOS|OpenHarmony|OHOS/i.test(content)) return true
    }
  } catch {
    // 忽略读取失败,按非鸿蒙处理
  }
  return false
}

/** 解析当前平台标识 */
export function detectPlatformId(): PlatformId {
  if (isOhos()) return 'ohos'
  const p = process.platform as string
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p as PlatformId
  return 'linux'
}
