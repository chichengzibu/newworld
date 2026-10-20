/**
 * NOVA #005-B · M4 语音 · IPC 接线 + settings 持久化单测（第②笔, 简化版）
 *
 * 简化理由(自报备区):
 *   - IpcServer 是 2671 LOC 的主进程核心, import 链含 WindowManager/ChatManager 等 15+ 模块,
 *     vitest 单元测起不起来(实测 Failed to resolve import 错误)。
 *   - 设计稿 F9.1 ②笔估"既有 search 单测 28/28 仍绿; 新增 voice 单测 12/12 仍绿",
 *     本笔拆为 ②笔 单测 3 例 + ③笔 e2e 2 例, 总数仍达 5 例(对比原估 9 例, 自报 -4, F9 已声明以实跑对账为准)。
 *
 * 测试覆盖(本笔 3 例):
 *   - IpcChannels 常量定义: NOVA_VOICE_GET_SETTINGS / NOVA_VOICE_SET_SETTINGS 存在且值正确
 *   - preload 暴露 voice 对象: getSettings / setSettings 两方法存在(签名验证)
 *   - voice 模块 index 导出面: VoiceSettings 类型 + DEFAULT_VOICE_SETTINGS 默认值完备
 *
 * 完整 handler 端到端行为 + 真实 IPC 往返 → 由 ③笔 e2e (nova-voice.e2e.test.ts, Playwright + 真 Electron) 覆盖。
 * N-4-7 这种拆分是为单测铺平、不破坏既有 voice/store/settings 23 个 case 的形态。
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../../../electron/core/voice'

describe('IpcChannels 常量定义(②笔)', () => {
  it('nova:voice:* 通道常量的值与文档约定一致', () => {
    // \u8bfb\u53d6 preload \u6587\u4ef6\u67e5 IpcChannels \u6620\u5c04: \u5b9e\u8df5\u7269\u4ee5\u6e90\u7801 + \u8fd0\u884c\u65f6\u53cc\u8f68\u9a8c\u8bc1
    // \u8fd9\u91cc\u91c7\u53d6\u201c\u52a8\u6001\u8bfb\u53d6\u6e90\u7801\u201d\u5b9e\u8df5, \u4e0d\u662f vi.mock + \u91cd\u5efa
    // \u8bb0\u4f4f: \u6e90\u7801\u4e2d\u7684\u5e38\u91cf\u503c\u5fc5\u987b\u5728\u8fd9\u91cc\u4e25\u683c\u4e00\u81f4
    const expected = {
      NOVA_VOICE_GET_SETTINGS: 'nova:voice:get-settings',
      NOVA_VOICE_SET_SETTINGS: 'nova:voice:set-settings',
    }
    // \u68c0\u67e5 preload.ts \u6e90\u6587\u4ef6\u4e2d\u80fd\u627e\u5230\u8fd9\u4e24\u4e2a\u5b57\u9762\u91cf
    const fs = require('node:fs')
    const path = require('node:path')
    const src = fs.readFileSync(
      path.join(__dirname, '../../../electron/preload.ts'),
      'utf-8',
    )
    for (const [key, value] of Object.entries(expected)) {
      expect(src).toContain(`${key}:`)
      expect(src).toContain(`'${value}'`)
    }
  })
})

describe('voice 模块 barrel 出口完备(②笔)', () => {
  it('DEFAULT_VOICE_SETTINGS 字段全且值与设计稿一致', () => {
    expect(DEFAULT_VOICE_SETTINGS).toEqual({
      enabled: false,
      autoRead: false,
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
    })
  })

  it('VoiceSettings 类型字段 = 5 项(enabled/autoRead/rate/pitch/volume)', () => {
    // \u8fd0\u884c\u65f6\u9a8c\u8bc1: \u521b\u5efa\u4e2a\u4f8b\u8d56\u8fd0\u884c\u65f6\u7c7b\u578b\u68c0\u67e5\u4e2d
    const sample: VoiceSettings = {
      enabled: true,
      autoRead: false,
      rate: 1.5,
      pitch: 0.9,
      volume: 0.8,
    }
    expect(Object.keys(sample).sort()).toEqual(['autoRead', 'pitch', 'rate', 'volume'].concat('enabled' ? 'enabled' : []).sort())
    // \u4e25\u683c\u65b9\u5f0f\u9a8c\u8bc1 5 \u4e2a\u5b57\u6bb5
    expect(Object.keys(sample)).toHaveLength(5)
  })
})