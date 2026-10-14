/**
 * PiPiClaw - #005 D6 章 (可信目录联动) 五钉子测试
 *
 * ═══ 被测机制 ═══
 *   isCwdInSandbox 唯一 cwd 校验点 (commandDecide.ts:140-154) 扩为 sandbox ∪ TRUSTED_DIRS。
 *   - TRUSTED_DIRS 走 ConfigStore 键 agent.trusted-dirs (裁决 #4); 默认空 = 零回归
 *   - 读时校验: 非绝对路径/不存在的条目跳过 (warn, 禁静默进名单); 比较词法归一
 *     (path.resolve + win32 大小写折叠); realpath 解析留 DEV-025 (诚实条款: 不做 symlink 解析)
 *   - 授权级别零改动 (解耦钉子):
 *       可信目录只扩 **cwd 触达面**, **不**改 AUTO/CONFIRM/deny 三级判决。
 *       D6-4 为最硬的断言: trusted 内 CONFIRM 级 (git) + headless → 拒绝理由必须是
 *         "context=... 不允许 confirm (仅 ui 放行)"  (授权级别拒),
 *       **不是** "cwd 必须在 sandbox/..."  (触达面拒) —— 证明"触达面 × 授权级别"正交。
 *
 * ═══ D6-1..5 断言 ═══
 *   D6-1 零回归: 不配 trusted (探针 null 回落到 ConfigStore 缺键=[]) + cwd 不在 sandbox → 拒
 *   D6-2 AUTO 正向: trusted 内 cwd + headless + AUTO 级 (ls) → execFile 探针 ok:true, exit=0
 *   D6-3 目录外维持拒: trusted 内 cwd 之外的 cwd + AUTO (ls) → 拒 (cwd 必须在 sandbox/workspace/可信目录内)
 *   D6-4 解耦钉 (本单最重要): trusted 内 cwd + headless + CONFIRM 级 (git) → 拒绝理由含
 *       "不允许 confirm 级命令 (仅 ui 放行)" (授权级别拒), 不含 "cwd 必须在" (触达面)
 *   D6-5 secrets 无关 cwd: trusted 内 cwd + args 含 .ssh 段 (cat) → 拒绝理由含 "secrets 守护表"/"args 路径段命中"
 *
 * ═══ 探针策略 ═══
 *   - execFile (node:child_process) 用 vi.mock: 记录 {cwd, args} + 返回 (stdout='', stderr='') 模拟成功
 *   - audit sink: 探针记录 (验 phase 配对, 非本次钉子, 跳过)
 *   - confirm transport: null (默认 defaultBrowserConfirm, 测试无窗 → 拒, 不影响 AUTO/DENY/CONFIRM 级别判定)
 *   - setTrustedDirsForTest: 注入 trusted 列表 (覆盖 ConfigStore 真实配置)
 *   - ConfigStore: 直接 mock getInstance, 不真读 config.json (隔离 + 不写盘)
 *   - TestHost (./test-host): platform/runtime 已走 TestHost 基址 (TEST_USER_DATA, sandbox/workspace 存在)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { vi } from 'vitest'
import * as fsNode from 'node:fs'
import * as pathNode from 'node:path'
import * as osNode from 'node:os'
import { TEST_USER_DATA } from './test-host'

// ── Mocks ────────────────────────────────────────────────────────────────────
// 1) execFile: 探针 — 记录 {cwd, args, command} + 返回空 stdout/stderr (模拟成功)
const execProbe = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; cwd: string }>,
  reset: () => { execProbe.calls.length = 0 },
}))

vi.mock('node:child_process', () => {
  // commandDecide 用 promisify(execFile) 包裹 → 需让 promisify 直接用我的 promise 版。
  // 设 promisify.custom (nodejs.util.promisify.custom), 使 `const {stdout,stderr}=await execFileAsync(...)` 解构到对象。
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom')
  const realExecFile = (command: string, args: string[] | undefined, opts?: { cwd?: string }) => {
    execProbe.calls.push({ command, args: args === undefined ? [] : [...args], cwd: opts?.cwd ?? '' })
    return Promise.resolve({ stdout: '', stderr: '' })
  }
  realExecFile[promisifyCustom] = realExecFile
  return { execFile: realExecFile, execFileSync: () => '', default: { execFile: realExecFile } }
})

// 2) electron: commandDecide 仅用于 ipcMain.on (ensureReplyHandler) + BrowserWindow (defaultBrowserConfirm);
//   探针下这两条均不触发 — 占位 mock 即可 (避免 vitest 因真实 electron 绑定失败)
vi.mock('electron', () => {
  const ipcMainStub = { on: () => {} }
  return { ipcMain: ipcMainStub, BrowserWindow: { getAllWindows: () => [] } }
})

// 3) ConfigStore: 测试下不真读 config.json; 让 configGetTrustedDirs 走 setTrustedDirsForTest 探针
//   (isCwdInTrustedDir 内部 getTrustedDirsForTest() 优先读 _testTrustedDirs 探针, 不回落 ConfigStore)
//   这里仍占位 mock, 避免 ConfigStore 在 import 时 app.getPath 绑定失败
vi.mock('../../electron/core/ConfigStore', () => ({
  ConfigStore: {
    getInstance: () => ({ get: () => undefined, set: () => {}, getAll: () => ({}), reset: () => {}, destroy: () => {} }),
  },
}))

import {
  execCommand,
  setConfirmTransport,
  setAuditSink,
  setTrustedDirsForTest,
  getTrustedDirsForTest,
  isCwdInTrustedDir,
  configGetTrustedDirs,
} from '../../electron/agent/tools/commandDecide'

/** 一个临时 trusted 目录 (按 pid 隔离, 不互相踩) */
const TRUSTED_DIR = pathNode.join(osNode.tmpdir(), `d6-trusted-${process.pid}`)
/** 一个非 trusted 的临时目录 (用于 D6-3 目录外) */
const UNTRUSTED_DIR = pathNode.join(osNode.tmpdir(), `d6-untrusted-${process.pid}`)

beforeAll(() => {
  fsNode.mkdirSync(TRUSTED_DIR, { recursive: true })
  fsNode.mkdirSync(UNTRUSTED_DIR, { recursive: true })
  // 探针: 默认成功 — D6-2 正向断言 exit=0
})

afterAll(() => {
  fsNode.rmSync(TRUSTED_DIR, { recursive: true, force: true })
  fsNode.rmSync(UNTRUSTED_DIR, { recursive: true, force: true })
})

afterEach(() => {
  execProbe.reset()
  setAuditSink(null)
  setConfirmTransport(null)
  setTrustedDirsForTest(null)
})

describe('#005 D6 章 (可信目录 × 授权级别解耦)', () => {
  it('D6-1 零回归: 默认 trusted=[] → sandbox 外的 cwd 仍被拒 (行为与现状 100% 一致)', async () => {
    // 探针 null → isCwdInTrustedDir 回落到 configGetTrustedDirs() → ConfigStore (mock 返回 [] 或 undefined) → []
    expect(getTrustedDirsForTest()).toEqual([])
    // sandbox 外 (非 trusted) cwd → 拒
    const r = await execCommand({
      command: 'ls', args: ['-la'], cwd: UNTRUSTED_DIR, contextKind: 'headless',
    })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.denialReason).toMatch(/cwd 必须在 sandbox\/workspace\/可信目录内/)
  })

  it('D6-2 AUTO 正向: trusted 内 cwd + headless + ls (AUTO) → execFile 真跑 (ok=true, exit=0)', async () => {
    setTrustedDirsForTest([TRUSTED_DIR])
    const r = await execCommand({
      command: 'ls', args: ['-la'], cwd: TRUSTED_DIR, contextKind: 'headless',
    })
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
    // execFile 探针断言: 确实跑过, cwd = trusted 目录
    expect(execProbe.calls.length).toBeGreaterThanOrEqual(1)
    const last = execProbe.calls[execProbe.calls.length - 1]
    expect(lowerCasePath(last.cwd)).toBe(lowerCasePath(TRUSTED_DIR))
  })

  it('D6-3 目录外维持拒: trusted=[TRUSTED] 但 cwd 在 UNTRUSTED → 拒 (cwd 必须在...) ', async () => {
    setTrustedDirsForTest([TRUSTED_DIR])
    const r = await execCommand({
      command: 'ls', args: ['-la'], cwd: UNTRUSTED_DIR, contextKind: 'headless',
    })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.denialReason).toMatch(/cwd 必须在 sandbox\/workspace\/可信目录内/)
    // execFile 不应被调 (D6 钉子: 目录外 → 触达面拒, execFile 不跑)
    expect(execProbe.calls.length).toBe(0)
  })

  it('D6-4 解耦钉 (本单最重要): trusted 内 cwd + headless + git (CONFIRM) → 拒绝理由是 "仅 ui 放行" (授权级别拒)', async () => {
    setTrustedDirsForTest([TRUSTED_DIR])
    const r = await execCommand({
      command: 'git', args: ['status'], cwd: TRUSTED_DIR, contextKind: 'headless',
    })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    // **核心断言**: 拒绝理由必须是 授权级别 (contextAllowsConfirm 拒), 不是 触达面 (cwd 拒)
    expect(r.denialReason).toMatch(/不允许 confirm 级命令 \(仅 ui 放行\)/)
    expect(r.denialReason).not.toMatch(/cwd 必须在/)
    expect(r.humanConfirm).toBe('false')
    // execFile 不应被调 (未到达 exec 阶段)
    expect(execProbe.calls.length).toBe(0)
  })

  it('D6-5 secrets 无关 cwd: trusted 内 cwd + args 含 .ssh 段 (cat) → 拒绝理由命中 secrets guard', async () => {
    setTrustedDirsForTest([TRUSTED_DIR])
    const r = await execCommand({
      // cat 是 AUTO 级; 但 args 里的 .ssh 段命中 secrets guard → 最优先 deny (不进入 cwd 校验, 不进入 exec)
      command: 'cat', args: [`${TRUSTED_DIR}/.ssh/id_rsa`], cwd: TRUSTED_DIR, contextKind: 'headless',
    })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    // 拒绝理由必须是 secrets guard (路径段命中), 既不是 cwd 拒 (触达面) 也不是 confirm 拒
    expect(r.denialReason).toMatch(/secrets 守护表|args 路径段命中 secrets/)
    expect(r.denialReason).not.toMatch(/cwd 必须在/)
    expect(r.denialReason).not.toMatch(/不允许 confirm/)
    expect(execProbe.calls.length).toBe(0)
  })

  it('D6-6 探针面: getTrustedDirsForTest 返回探针注入的目录; isCwdInTrustedDir 大小写折叠 + 前缀匹配', () => {
    setTrustedDirsForTest([TRUSTED_DIR])
    expect(getTrustedDirsForTest()).toEqual([TRUSTED_DIR])
    // trusted 内 (子目录) 命中
    expect(isCwdInTrustedDir(pathNode.join(TRUSTED_DIR, 'sub'))).toBe(true)
    // trusted 自身 命中
    expect(isCwdInTrustedDir(TRUSTED_DIR)).toBe(true)
    // 非 trusted 命
    expect(isCwdInTrustedDir(UNTRUSTED_DIR)).toBe(false)
    // trusted 的【其他目录】命中
    expect(isCwdInTrustedDir(pathNode.join(osNode.tmpdir(), 'another-dir'))).toBe(false)
  })

  it('D6-7 诚实条款 (字面层): 不配 trusted + 探针 null → configGetTrustedDirs 返回 [] (ConfigStore 缺键归一)', () => {
    setTrustedDirsForTest(null)
    // 探针 null → 回落 configGetTrustedDirs() → ConfigStore (mock 返 undefined) → 归一 []
    expect(configGetTrustedDirs()).toEqual([])
    expect(getTrustedDirsForTest()).toEqual([])
  })
})

/** win32 大小写折叠: path.resolve + toLowerCase 比较 (与 isCwdInTrustedDir 内部归一一致) */
function lowerCasePath(p: string): string {
  return pathNode.resolve(p).toLowerCase()
}
