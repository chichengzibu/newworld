/**
 * ErrorLedger 单元测试 — 本地错误台账(P0 工程规范可观测性)
 *
 * 覆盖: append 落盘 / 5s 同 message 去重 / 500 条 FIFO 裁剪 /
 *       kind 计数聚合 / registerIpcHandlers 通道注册与 handler 行为。
 * electron 以 vi.mock 注入(app.getPath 指向每用例独立的 temp 目录)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { ipcHandlers, userDataDir } = vi.hoisted(() => {
  // vi.hoisted 内不能引用顶层 import(初始化顺序) —— 用纯字符串拼临时目录,
  // 目录创建放 beforeEach(走顶层 import 的 fs)。
  const userDataDir = process.cwd().replace(/[\\/]+$/, '') + '/.tmp-error-ledger-test-' + process.pid
  const ipcHandlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {}
  return { ipcHandlers, userDataDir }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers[channel] = handler
    }),
    removeHandler: vi.fn((channel: string) => {
      delete ipcHandlers[channel]
    }),
  },
}))

const ledgerFile = join(userDataDir, 'error-ledger.json')

async function freshLedger() {
  // 动态 import: 每次拿到全新实例(模块级单例状态通过 vi.resetModules 隔离)
  vi.resetModules()
  const mod = await import('../../electron/core/ErrorLedger')
  return mod
}

describe('ErrorLedger — 本地错误台账', () => {
  beforeEach(() => {
    for (const k of Object.keys(ipcHandlers)) delete ipcHandlers[k]
    mkdirSync(userDataDir, { recursive: true })
    if (existsSync(ledgerFile)) rmSync(ledgerFile)
  })

  it('append 落盘: 记录写入 userData/error-ledger.json', async () => {
    const { ErrorLedger } = await freshLedger()
    const ledger = new ErrorLedger()
    ledger.append({ kind: 'auth', message: '401 bad key', source: 'vue' })

    const raw = JSON.parse(readFileSync(ledgerFile, 'utf8')) as {
      records: Array<{ kind: string; message: string; source: string }>
      counts: Record<string, number>
    }
    expect(raw.records).toHaveLength(1)
    expect(raw.records[0]).toMatchObject({ kind: 'auth', message: '401 bad key', source: 'vue' })
    expect(raw.counts.auth).toBe(1)
  })

  it('5s 窗口内同 message 去重(防 console.error 循环打爆台账)', async () => {
    const { ErrorLedger } = await freshLedger()
    const ledger = new ErrorLedger()
    ledger.append({ kind: 'network', message: 'ECONNREFUSED' })
    ledger.append({ kind: 'network', message: 'ECONNREFUSED' })
    ledger.append({ kind: 'network', message: 'ECONNREFUSED 2' })

    const raw = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    expect(raw.records).toHaveLength(2)
  })

  it('500 条 FIFO 裁剪: 超限丢最老, 不丢最新', async () => {
    const { ErrorLedger } = await freshLedger()
    const ledger = new ErrorLedger()
    for (let i = 0; i < 505; i++) {
      ledger.append({ kind: 'stress', message: `err-${i}` })
    }
    const raw = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    expect(raw.records).toHaveLength(500)
    expect(raw.records[0].message).toBe('err-5')
    expect(raw.records.at(-1)?.message).toBe('err-504')
  })

  it('registerIpcHandlers: error:report 通道可调用, error:summary 返回聚合', async () => {
    const { ErrorLedger } = await freshLedger()
    const ledger = new ErrorLedger()
    ledger.registerIpcHandlers()

    const report = ipcHandlers['error:report'] as (e: unknown, rec: Record<string, string>) => { success: boolean }
    const summary = ipcHandlers['error:summary'] as (e: unknown) => { success: boolean; data?: { total: number; counts: Record<string, number> } }

    expect(report({}, { kind: 'oom', message: 'heap out of memory', source: 'vue' })).toMatchObject({ success: true })
    const s = summary({})
    expect(s.success).toBe(true)
    expect(s.data?.total).toBe(1)
    expect(s.data?.counts.oom).toBe(1)
  })

  it('重复 registerIpcHandlers 走 removeHandler 覆盖语义, 不抛 "second handler"', async () => {
    const { ErrorLedger } = await freshLedger()
    const ledger = new ErrorLedger()
    expect(() => {
      ledger.registerIpcHandlers()
      ledger.registerIpcHandlers()
    }).not.toThrow()
    expect(ipcHandlers['error:report']).toBeTruthy()
  })

  it('文件损坏/首次运行: 从空台账开始, 不抛错', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(ledgerFile, '{corrupted json!!', 'utf8')
    const { ErrorLedger } = await freshLedger()
    const ledger = new ErrorLedger()
    expect(() => ledger.append({ kind: 'x', message: 'after corruption' })).not.toThrow()
    const raw = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    expect(raw.records).toHaveLength(1)
    expect(raw.records[0].message).toBe('after corruption')
  })
})
