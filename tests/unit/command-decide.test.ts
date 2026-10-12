/**
 * PiPiClaw - #002-v3 命令咽喉 + 四钉子 + MCP 窄项 (T1-T12)
 *
 * 策略:
 *   - T1-T5  纯逻辑级 (constants: 集合迭代 / 归一化 / find/secrets 例外 / context 规则)
 *   - T6-T8  咽喉集成 (execCommand: contextKind 贯穿 / 拒绝语义 / 审计)
 *   - T9-T10 四钉子 (哨兵 pending / phase 配对 / 孤儿检测 / 分段失败①②)
 *   - T11    MCP 窄项 (mcpCallAudit 同 sink)
 *   - T12    全链正向 (ui stub 允许 → ok, 审计 humanConfirm='true')
 *
 * 隔离:
 *   electron mock (electron-setup.ts) + TestHost (per-worker 沙箱目录).
 *   每用例前 afterEach 复原 setCommandContext + setConfirmTransport.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import * as fsNode from 'node:fs'
import * as path from 'node:path'

import {
  decideCommand,
  normalizeCommand,
  isSecretsSegmentHit,
  contextAllowsConfirm,
  COMMAND_AUTO_ALLOWLIST,
  COMMAND_CONFIRM_LIST,
  FIND_DENY_FLAGS,
  SECRETS_GUARD_PATTERNS,
} from '../../electron/agent/tools/constants'
import {
  execCommand,
  setCommandContext,
  setConfirmTransport,
  setAuditSink,
  mcpCallAudit,
} from '../../electron/agent/tools/commandDecide'
import { TEST_USER_DATA } from './test-host'

// 复原 — 每用例后 (模块态 + transport stub + audit sink)
afterEach(() => {
  setCommandContext('headless')
  setConfirmTransport(null)
  setAuditSink(null)
})

// 选择性失败 sink: 命中 phase 的写入抛错, 其余走真 sink (写文件). 用于四钉子分段失败测试.
function failSinkOn(phase: 'start' | 'finish') {
  const defaultSink = (e: Record<string, unknown>) => {
    const file = path.join(TEST_USER_DATA, 'audit', 'openclaw.audit.jsonl')
    fsNode.mkdirSync(path.dirname(file), { recursive: true })
    fsNode.appendFileSync(file, JSON.stringify(e) + '\n', 'utf8')
  }
  return (e: Record<string, unknown>) => {
    if (e.phase === phase) throw new Error(`forced ${phase} write fail (probe)`)
    defaultSink(e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// T1  三层名单集合迭代 (v3 规格 #2)
// ─────────────────────────────────────────────────────────────────────────────
describe('T1: 三层名单集合 (v3 规格 + 5 裁决)', () => {
  it('AUTO = 13 项 (env 已移出), 且全部为纯只读命令', () => {
    // 集合为唯一事实源; 数字从 .size 派生 (禁手写)
    expect([...COMMAND_AUTO_ALLOWLIST].sort()).toEqual([
      'cat', 'date', 'echo', 'find', 'grep', 'head', 'ls', 'pwd',
      'tail', 'tree', 'uname', 'wc', 'whoami',
    ])
    // env 不在 AUTO (v3 规格修正)
    expect(COMMAND_AUTO_ALLOWLIST.has('env')).toBe(false)
  })

  it('CONFIRM = 20 项 (shell7+网络2+运行时9+env1+git1)', () => {
    const shell = new Set(['bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'])
    const net = new Set(['curl', 'wget'])
    const runtime = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3'])
    const env = new Set(['env'])
    const git = new Set(['git'])
    const all = new Set([...shell, ...net, ...runtime, ...env, ...git])
    expect([...COMMAND_CONFIRM_LIST].sort()).toEqual([...all].sort())
  })

  it('AUTO 与 CONFIRM 不重叠 (集合语义红线)', () => {
    const auto = new Set(COMMAND_AUTO_ALLOWLIST)
    const overlap = [...COMMAND_CONFIRM_LIST].filter(c => auto.has(c))
    expect(overlap).toEqual([])
  })

  it('deny 默认: 未知 baseCmd 全拒 (rm/tar/nc/docker 等)', () => {
    for (const cmd of ['rm', 'cp', 'mv', 'mkdir', 'tar', 'nc', 'ssh', 'docker', 'make', 'cargo', 'wsl', 'printenv']) {
      expect(decideCommand(cmd, []).kind).toBe('deny')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2  find 危险参数封禁 (v3 终版)
// ─────────────────────────────────────────────────────────────────────────────
describe('T2: find 危险参数 → deny (AUTO 例外)', () => {
  it('find -exec / -delete / -okdir 等危险参数命中 → deny', () => {
    for (const flag of [...FIND_DENY_FLAGS]) {
      const d = decideCommand('find', [flag, 'true', '-name', '*.ts'])
      expect(d.kind, `find ${flag} 应 deny`).toBe('deny')
    }
  })
  it('find 普通参数 → auto', () => {
    expect(decideCommand('find', ['-name', '*.ts']).kind).toBe('auto')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3  归一化四连 (v3 规格 #1)
// ─────────────────────────────────────────────────────────────────────────────
describe('T3: 归一化 — basename + 剥后缀 + 小写', () => {
  const cases: Array<[string, string]> = [
    ['BASH', 'bash'],
    ['/bin/bash', 'bash'],
    ['C:\\Windows\\System32\\cmd.exe', 'cmd'],
    ['python.exe', 'python'],
    ['PYTHON', 'python'],
    ['  npm  ', 'npm'],
    ['./node', 'node'],
    ['/usr/local/bin/node', 'node'],
  ]
  for (const [raw, norm] of cases) {
    it(`'${raw}' → '${norm}'`, () => {
      expect(normalizeCommand(raw)).toBe(norm)
    })
  }

  it('归一化后 decideCommand 命中 (Bash/bash/bash.exe 都 → confirm)', () => {
    for (const raw of ['Bash', 'bash', 'Bash.exe', '/usr/bin/bash', 'C:\\Windows\\bash.cmd']) {
      expect(decideCommand(raw, []).kind, raw).toBe('confirm')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4  secrets guard (裁决 #2: 段感知)
// ─────────────────────────────────────────────────────────────────────────────
describe('T4: secrets 段感知 (禁裸子串)', () => {
  it('命中: 任一路径段 == 表项 → deny', () => {
    expect(decideCommand('cat', ['/home/user/.ssh/id_rsa']).kind).toBe('deny')
    expect(decideCommand('head', ['C:\\Users\\admin\\.aws\\credentials']).kind).toBe('deny')
    expect(decideCommand('cat', ['/home/user/.pipiclaw-secrets']).kind).toBe('deny')
    expect(decideCommand('cat', ['clawhub-dev-ed25519.key']).kind).toBe('deny')
  })
  it('未命中: 裸子串不同段 (my-ssh-config / sshtest) → 不 deny', () => {
    expect(decideCommand('cat', ['my-ssh-config.txt']).kind).toBe('auto')
    expect(decideCommand('cat', ['sshtest/foo']).kind).toBe('auto')
    // 关键: 段名不同 ≠ 子串相同
    expect(isSecretsSegmentHit('ssh-id_rsa')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5  contextAllowsConfirm (v3 #4: 仅 ui)
// ─────────────────────────────────────────────────────────────────────────────
describe('T5: contextAllowsConfirm', () => {
  it("ui → true, 其余全 false", () => {
    expect(contextAllowsConfirm('ui')).toBe(true)
    expect(contextAllowsConfirm('headless')).toBe(false)
    expect(contextAllowsConfirm('im_inbound')).toBe(false)
    expect(contextAllowsConfirm('scheduler')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T6  contextKind 贯穿 (v3 #4)
// ─────────────────────────────────────────────────────────────────────────────
describe('T6: execCommand contextKind 贯穿', () => {
  it('confirm 级 node + ctx=headless → 拒 (不执行, 不弹窗)', async () => {
    const r = await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'headless' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.denialReason).toMatch(/headless|confirm/)
  })
  it('confirm 级 node + ctx=scheduler → 拒 (scheduler 不允许 confirm)', async () => {
    const r = await execCommand({ command: 'node', args: ['-e', '1'], contextKind: 'scheduler' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
  })
  it('confirm 级 node + ctx=im_inbound → 拒 (W4 预留, 目前仍拒)', async () => {
    const r = await execCommand({ command: 'node', args: ['-e', '1'], contextKind: 'im_inbound' })
    expect(r.ok).toBe(false)
  })
  it('AUTO 级命令 (ls) + ctx=headless → 执行 (auto 不受 context 限制)', async () => {
    const r = await execCommand({ command: 'ls', args: [], contextKind: 'headless' })
    // ls 是 auto, headless 也放行; 实际执行结果依环境而定 (Windows 沙箱目录存在)
    // 这里只验"不被 context 拒"
    expect(r.denied).not.toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T7  四钉子 (v3 #6 + GLM 预审 #1)
// ─────────────────────────────────────────────────────────────────────────────
describe('T7: 四颗审计钉子', () => {
  const auditFile = path.join(TEST_USER_DATA, 'audit', 'openclaw.audit.jsonl')

  beforeEach(() => {
    // 每用例清审计文件
    if (fsNode.existsSync(auditFile)) fsNode.rmSync(auditFile)
  })

  it('钉子①[哨兵 pending] + ②[phase 配对] + 成功路径', async () => {
    setCommandContext('ui')
    setConfirmTransport(async () => true)
    const r = await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'ui' })
    expect(r.ok).toBe(true)

    // 审计文件: 至少 2 行 (start + finish), 同一 opId
    const lines = fsNode.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const startRows = lines.filter(l => l.phase === 'start')
    const finishRows = lines.filter(l => l.phase === 'finish')
    expect(startRows.length).toBe(1)
    expect(finishRows.length).toBe(1)
    expect(startRows[0].opId).toBe(finishRows[0].opId)
    // 钉子① 哨兵 pending: start 行 exit 必为 'pending' (非 0)
    expect(startRows[0].exit).toBe('pending')
    // 钉子② phase 配对: finish 行 exit 为真实值
    expect(finishRows[0].exit).not.toBe('pending')
  })

  it('钉子③[孤儿可检测]: start 成功但进程未产生 finish → 可被扫描识别', async () => {
    // 让 finish 写失败 (探针 sink): start 写完, finish 抛错 → 只剩 start 行 (孤儿).
    setCommandContext('ui')
    setConfirmTransport(async () => true)
    setAuditSink(failSinkOn('finish'))
    const r = await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'ui' })
    // 执行成功 (命令已跑), finish 写失败被升级 b 的 console.error 捕获 — 命令结果不改判
    expect(r.ok).toBe(true)

    // 审计: 只有 start 行 (孤儿, 无 finish 配对)
    if (fsNode.existsSync(auditFile)) {
      const lines = fsNode.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const orphans = lines.filter(l => l.phase === 'start' && !lines.find(x => x.phase === 'finish' && x.opId === l.opId))
      expect(orphans.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('钉子④[分段失败①]: start 写失败 → 命令拒 (execFile 不跑)', async () => {
    // 让 start 写抛错 (探针 sink) → fail-closed, 命令直接拒
    setCommandContext('ui')
    setConfirmTransport(async () => true)
    setAuditSink(failSinkOn('start'))
    const r = await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.denialReason).toMatch(/audit-unavailable/)
    // execFile 没跑 → 不应有 finish 行
    if (fsNode.existsSync(auditFile)) {
      const lines = fsNode.readFileSync(auditFile, 'utf8').trim().split('\n')
      expect(lines.filter(l => l.includes('"phase":"finish"')).length).toBe(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T8  拒绝语义 (v3 #9: 统一通道)
// ─────────────────────────────────────────────────────────────────────────────
describe('T8: 拒绝语义 + 审计落一行', () => {
  const auditFile = path.join(TEST_USER_DATA, 'audit', 'openclaw.audit.jsonl')
  beforeEach(() => {
    if (fsNode.existsSync(auditFile)) fsNode.rmSync(auditFile)
  })

  it('deny 级 (rm) → 拒 + 审计 phase=deny', async () => {
    setCommandContext('ui')
    const r = await execCommand({ command: 'rm', args: ['-rf', '/'], contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    if (fsNode.existsSync(auditFile)) {
      const lines = fsNode.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines).toHaveLength(1)
      expect(lines[0].phase).toBe('deny')
      expect(lines[0].denialReason).toMatch(/不在自动\/确认名单/)
    }
  })
  it('headless + confirm → 拒 + 审计 reason 含 headless', async () => {
    setCommandContext('headless')
    const r = await execCommand({ command: 'node', args: ['-e', '1'], contextKind: 'headless' })
    expect(r.ok).toBe(false)
    expect(r.denialReason).toMatch(/headless/)
  })
  it('metacharacter → 拒 + reason 含 非法字符', async () => {
    const r = await execCommand({ command: 'ls; rm -rf /', args: [], contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.denialReason).toMatch(/非法字符|metachar/i)
  })
  it('args null byte → 拒 + reason 含 null byte', async () => {
    const r = await execCommand({ command: 'ls', args: ['a\u0000b'], contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.denialReason).toMatch(/null byte/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T9  secrets 段感知 (T4 已验, 这里测 execCommand 路径)
// ─────────────────────────────────────────────────────────────────────────────
describe('T9: execCommand + secrets 段感知', () => {
  it('cat .ssh/id_rsa → deny', async () => {
    const r = await execCommand({ command: 'cat', args: ['/home/u/.ssh/id_rsa'], contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.denialReason).toMatch(/secrets/i)
  })
  it('cat plain.txt → auto 执行', async () => {
    const r = await execCommand({ command: 'echo', args: ['ok'], contextKind: 'ui' })
    // echo 是 auto, 应直接执行 — 结果依环境, 但不应 denied
    expect(r.denied).not.toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T10  升级 b (finish 写失败 = 真 warn 非注释)
// ─────────────────────────────────────────────────────────────────────────────
describe('T10: 升级 b (finish warn 必须是 console.error 真代码)', () => {
  it('finish 写失败仍让命令成功 (已跑不改判) + console.error 被调', async () => {
    setCommandContext('ui')
    setConfirmTransport(async () => true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // finish 写抛错 (探针 sink), start 照常 → 触发升级 b 的 console.error (真代码非注释)
    setAuditSink(failSinkOn('finish'))
    const r = await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'ui' })
    expect(r.ok).toBe(true)
    // 升级 b 钉子: console.error 真的被调用 (不是注释)
    expect(spy).toHaveBeenCalled()
    // 调用消息含 opId + orphan 语义
    const calls = spy.mock.calls.map(c => String(c[0])).join('\n')
    expect(calls).toMatch(/orphan/i)
    vi.restoreAllMocks()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T11  MCP 窄项 (裁决 #1)
// ─────────────────────────────────────────────────────────────────────────────
describe('T11: mcpCallAudit 同 sink + fail-closed', () => {
  const auditFile = path.join(TEST_USER_DATA, 'audit', 'openclaw.audit.jsonl')
  beforeEach(() => {
    if (fsNode.existsSync(auditFile)) fsNode.rmSync(auditFile)
  })

  it('mcpCallAudit 写一行, phase=record + 含 mcpServer/mcpTool/mcpArgKeys', () => {
    expect(() => mcpCallAudit('my-server', 'my-tool', ['a', 'b'])).not.toThrow()
    const lines = fsNode.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0].phase).toBe('record')
    expect(lines[0].mcpServer).toBe('my-server')
    expect(lines[0].mcpTool).toBe('my-tool')
    expect(lines[0].mcpArgKeys).toEqual(['a', 'b'])
  })

  it('fail-closed: 写失败 throw, 调用方据此失败', () => {
    // 探针 sink: 任何写入都抛 → mcpCallAudit 的 auditAppendSync 向外传 → 调用方捕获
    setAuditSink(() => { throw new Error('force audit fail (probe)') })
    expect(() => mcpCallAudit('srv', 'tool', [])).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T12  全链正向 (升级 a 最终验收: brain→咽喉→确认→执行→审计 humanConfirm=true)
// ─────────────────────────────────────────────────────────────────────────────
describe('T12: 全链正向 (stub+ui 免费用例)', () => {
  const auditFile = path.join(TEST_USER_DATA, 'audit', 'openclaw.audit.jsonl')
  beforeEach(() => {
    if (fsNode.existsSync(auditFile)) fsNode.rmSync(auditFile)
  })

  it('brain→BashTool→咽喉→确认→执行→审计: 一条龙', async () => {
    setCommandContext('ui')
    setConfirmTransport(async (req) => {
      expect(req.command).toBe('node')
      return true
    })
    const r = await execCommand({ command: 'node', args: ['-e', 'console.log(7)'], contextKind: 'ui' })
    expect(r.ok).toBe(true)
    expect(r.humanConfirm).toBe('true')

    // 审计 start 行 humanConfirm 必须是 'true'
    const lines = fsNode.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const startLine = lines.find(l => l.phase === 'start')
    expect(startLine?.humanConfirm).toBe('true')
    expect(startLine?.contextKind).toBe('ui')
    expect(startLine?.confirmChannel).toBe('ui')
  })

  it('用户拒绝 → humanConfirm="false" + command 没跑', async () => {
    setCommandContext('ui')
    setConfirmTransport(async () => false)
    const r = await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'ui' })
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(r.humanConfirm).toBe('false')
    // 审计不应有 start 行 (因为用户拒, 还没到 exec 阶段)
    const lines = fsNode.existsSync(auditFile)
      ? fsNode.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      : []
    expect(lines.find(l => l.phase === 'start')).toBeUndefined()
    // 但有 deny 行
    expect(lines.find(l => l.phase === 'deny')).toBeDefined()
  })
})
