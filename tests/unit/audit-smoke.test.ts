/**
 * PART 4 步骤 6: 审计文件人工查验 (真实跑 execCommand 后读文件 + 样例 + 校验)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as fsNode from 'node:fs'
import * as path from 'node:path'
import { TEST_USER_DATA } from './test-host'
import {
  execCommand,
  setConfirmTransport,
  setAuditSink,
} from '../../electron/agent/tools/commandDecide'

const auditFile = path.join(TEST_USER_DATA, 'audit', 'openclaw.audit.jsonl')

describe('PART4-6: 审计文件人工查验 (真实 sink 落盘)', () => {
  beforeEach(() => {
    setAuditSink(null)
    setConfirmTransport(null)
    if (fsNode.existsSync(path.dirname(auditFile))) fsNode.rmSync(path.dirname(auditFile), { recursive: true, force: true })
  })

  it('4 条覆盖: 正向(ui 2 行)+deny(rm)+secrets+headless-confirm → 全合法 JSON + start/finish 配对', async () => {
    setConfirmTransport(async () => true)
    await execCommand({ command: 'node', args: ['-e', 'console.log(1)'], contextKind: 'ui' })
    let headlessReject: any
    headlessReject = await execCommand({ command: 'node', args: ['-e', 'console.log(2)'], contextKind: 'headless' })
    expect(headlessReject.denied).toBe(true)
    // headless 拒 → 只 1 行 deny
    expect(headlessReject.humanConfirm).toMatch(/false|not-required/)
    const rmReject = await execCommand({ command: 'rm', args: ['-rf', '/'], contextKind: 'ui' })
    expect(rmReject.denied).toBe(true)
    await execCommand({ command: 'cat', args: ['/home/u/.ssh/id_rsa'], contextKind: 'ui' })

    const content = fsNode.readFileSync(auditFile, 'utf-8')
    const lines = content.trim().split('\n').map(l => JSON.parse(l))
    console.log('\n===== 审计样例行 =====')
    lines.forEach((l, i) => console.log(`[${i+1}]`, JSON.stringify(l)))

    // 1) node ui: start (pending+humanConfirm=true) + finish
    expect(lines[0].phase).toBe('start')
    expect(lines[0].exit).toBe('pending')
    expect(lines[0].humanConfirm).toBe('true')
    expect(lines[0].contextKind).toBe('ui')
    expect(lines[0].baseCmd).toBe('node')
    expect(lines[1].phase).toBe('finish')
    expect(lines[1].opId).toBe(lines[0].opId)
    // 2) node headless: deny 行
    expect(lines[2].phase).toBe('deny')
    expect(lines[2].denied).toBe(true)
    // 3) rm ui: deny 行 (名单外层)
    expect(lines[3].phase).toBe('deny')
    expect(lines[3].denied).toBe(true)
    // 4) cat .ssh/id_rsa: deny 行 (secrets guard)
    expect(lines[4].phase).toBe('deny')
    expect(lines[4].denied).toBe(true)
    expect(lines[4].denialReason).toMatch(/secrets/i)
    expect(lines.length).toBe(5)
  })
})
