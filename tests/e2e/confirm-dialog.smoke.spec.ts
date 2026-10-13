/**
 * S2 冒烟自动化 — Playwright Electron 真回路验证 confirm 弹窗全链
 *
 * 用户指令 (2026-10-12 S2):
 *   "用户已解除人工点击要求, 确认回路冒烟改由 Playwright Electron 轨执行。
 *    测试侧新增, 零生产代码改动"
 *   "断言必须绑定本次调用 (行数差/opId), 禁只验'文件变长'"
 *   "两 spec 串行, 禁并行写同一审计文件"
 *   "若 _electron.launch 起不动 → BLOCKED 报卡点。禁降级成 DI stub 冒烟"
 *
 * 真回路覆盖 (本 spec 的全部价值):
 *   S1-allow:
 *     page.evaluate → window.electronAPI.openclaw.execute({operationType, params})
 *     → main IpcServer → gateway.executeOperation(request, source='ui')
 *     → gateway.runCommand(params, 'ui') → execCommand({contextKind:'ui'})
 *     → decideCommand('git') = confirm
 *     → contextAllowsConfirm('ui') = true
 *     → defaultBrowserConfirm → BrowserWindow.getAllWindows()[0].webContents.send('command:confirm-request')
 *     → 渲染 CommandConfirmDialog 订阅 → 弹窗
 *     → test 真点击「允许」→ respond(true) → api.command.replyConfirm(opId, true)
 *     → ipcRenderer.send('command:confirm-reply') → 主 ipcMain.on(...) → pending.resolve(true)
 *     → doExecFile → execFile('git', ['status'])
 *     → audit: start 行 (humanConfirm='true') + finish 行 (exit=0) 成对写入
 *     断言: res.success === true; audit 文件行数 +2 (start + finish);
 *          新行 baseCmd='git', humanConfirm='true', finish.exit===0
 *
 *   S2-deny:
 *     同触发, 真点击「拒绝」→ respond(false) → api.command.replyConfirm(opId, false)
 *     → 主 resolve(false) → 咽喉 deny 行 (humanConfirm='false', contextKind='ui', phase='deny')
 *     断言: res.success === false; audit 文件 +1; 新行 humanConfirm='false', phase='deny'
 *
 * 串行 (禁并发写同一审计文件):
 *   Playwright 同 worker 内 test 默认串行 (不并行);
 *   若 CI 配 workers>1, 本 spec 用 describe.sequential 或显式 test.describe.configure({mode:'serial'})
 *   防两个用例同时写 audit 导致行号解析混乱。
 *
 * 环境配方 (必须满足, 任一不满足 → BLOCKED 报卡点):
 *   1) 前置: npm run build (dist-electron/main.js 必须已产出)
 *   2) PLAYWRIGHT_BROWSERS_PATH=0 (钉死项目本地 chromium, 不依赖全局缓存)
 *   3) E2E_ELECTRON=1 (fixture 才启用 _electron.launch)
 *
 * 权限集前置 (测试侧配置, 非生产改动):
 *   默认权限集是 safe 模板 (shell=none) → 本测试需先 IPC:
 *     await window.evaluate(() => window.electronAPI.permissions.setActive('preset_permissive'))
 *   否则永远在权限层拒绝 (PERMISSION_DENIED), 到达不了 confirm 弹窗。
 *   这是测试环境配置, 不是生产代码改动 (用户禁令零生产改动 未突破)。
 *
 * 审计路径动态解析 (不硬编码):
 *   审计文件 = <userData>/audit/openclaw.audit.jsonl
 *   userData = main 进程 Electron app.getPath('userData')
 *   本 spec 用 freshUserData (fixture 提供) = 主进程 userData, 直接路径拼接。
 *
 * 运行:
 *   npx playwright test tests/e2e/confirm-dialog.smoke.spec.ts
 *   期望: 2 passed (S1-allow + S2-deny), 0 failed
 */
import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { launchAndProbe, makeUserDataDir } from './_p0-helpers'

const userDataDir = makeUserDataDir('confirm-dialog')
let app: import('@playwright/test').ElectronApplication
let win: import('@playwright/test').Page
let auditPath: string

test.describe('S2 冒烟: confirm 弹窗真回路 (Playwright Electron)', () => {
  test.describe.configure({ mode: 'serial' })
  // CI 防御 (与 chat-agent/auto-updater 等 6 spec 同配方, playwright.config 头注释): 未设 E2E_ELECTRON=1 → skip
  test.skip(!process.env.E2E_ELECTRON, 'requires E2E_ELECTRON=1 to launch Electron renderer')

  test.beforeAll(async () => {
    // 启动真 app + 探测 gateway 端口 (验证 gateway 起得来)
    const r = await launchAndProbe(userDataDir)
    app = r.app
    win = r.win
    // 主进程 userData 就是 launchAndProbe 的 userDataDir
    // (Electron --user-data-dir 指定了主进程 userData 位置)
    auditPath = path.join(userDataDir, 'audit', 'openclaw.audit.jsonl')
    console.log(`  audit path: ${auditPath}`)
    // 确保 audit 目录存在
    fs.mkdirSync(path.dirname(auditPath), { recursive: true })
  }, { timeout: 90_000 })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
  })

  /** 读 audit 文件行数 + 最后 N 行 JSON */
  function readAudit(lastN: number = 10): any[] {
    if (!fs.existsSync(auditPath)) return []
    const lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean)
    return lines.slice(-lastN).map((l) => {
      try { return JSON.parse(l) } catch { return { _parse_error: l } }
    })
  }

  /** 读 audit 文件总行数 */
  function auditLineCount(): number {
    if (!fs.existsSync(auditPath)) return 0
    return fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length
  }

  /** 切换权限集到 permissive (测试侧配置, 非生产改动) */
  async function setPermissivePermissionSet(): Promise<void> {
    const res = await win.evaluate(async () => {
      const api: any = (window as any).electronAPI
      return await api?.permissions?.setActive?.('preset_permissive') ?? null
    })
    console.log(`  permissions.setActive(preset_permissive) = ${JSON.stringify(res)}`)
    if (res?.success !== true) {
      throw new Error(`setActive 失败: ${JSON.stringify(res)} — 无法进入 confirm 弹窗测试 (权限层会先拒)`)
    }
  }

  /** 调用 openclaw:execute — 返回 IPC 结果 + 弹窗 DOM 操作 (真点击) */
  async function executeAndRespond(opts: { cmd: string; args: string[]; respond: 'allow' | 'deny' }): Promise<any> {
    // 1. 调执行 API (异步, 会触发弹窗 + 等待回执)
    //    弹窗 30s 超时 — 必须在 30s 内点击按钮
    //    注意: evaluate 函数体在页面上下文执行, 禁引用外部闭包变量 — 一切走 params
    const resultPromise = win.evaluate(async (p: { cmd: string; args: string[] }) => {
      const api: any = (window as any).electronAPI
      return await api?.openclaw?.execute?.({
        operationType: 'run_command',
        params: { command: p.cmd, args: p.args }
      }) ?? null
    }, { cmd: opts.cmd, args: opts.args })

    // 2. 等弹窗出现 (锚到「允许」按钮 — 唯一文案, 防 text= 匹配到导航/侧栏误命中)
    //    放宽 25s: Windows 冷启动冷帧 + 主进程 IPC→webContents.send 偶发慢帧
    //    (flaky 复盘 2026-10-12: 15s 锚 text=命令执行确认 挂过 1 次, 同代码重跑 2 绿 → 判为派发竞态, 放宽+换锚)
    const btnText = opts.respond === 'allow' ? '允许' : '拒绝'
    const btn = win.locator(`button:has-text("${btnText}")`)
    await btn.waitFor({ state: 'visible', timeout: 25_000 })

    // 3. 按钮已可点击
    console.log(`  弹窗出现, 真点击「${btnText}」...`)
    await btn.click()

    // 4. 等 IPC 返回
    const result = await resultPromise
    console.log(`  execute 返回: ${JSON.stringify(result).slice(0, 250)}`)
    return result
  }

  // ═══════════════════════════════════════════════════════════════
  // S1 允许路径: 弹窗 → 真点击「允许」→ 执行 → 审计 humanConfirm='true'
  //
  // 命令选择实证 (2026-10-12 失败复盘):
  //   exec 的 cwd 固定 = <userData>/sandbox (审计 start 行实测), 该目录非 git repo
  //   → `git status` 必 fatal exit≠0 (实测 exit=-1, 链路全通但命令失败)
  //   → allow 路径要真跑成 (exit=0) 用 `git --version` (非 repo 也成功, 且 git 同为 confirm 级)
  //   生产代码未改 (sandbox 固定属既有行为, 非本单引入)
  // ═══════════════════════════════════════════════════════════════
  test('S1-allow: git --version → 弹窗 → 允许 → 成功 + 审计 humanConfirm="true"', async () => {
    // 前置: 切权限集 (safe → permissive, 避免 shell 层先拒)
    await setPermissivePermissionSet()

    // 快照基线行数 (断言"恰新增 N 行"的依据)
    const before = auditLineCount()
    console.log(`  审计基线行数: ${before}`)

    // 执行 + 真点击「允许」
    const res = await executeAndRespond({ cmd: 'git', args: ['--version'], respond: 'allow' })

    // 断言 res.success === true
    expect(res, 'execute result 不能为 null').not.toBeNull()
    expect(res.success, `res.success 应为 true (实际: ${JSON.stringify(res)})`).toBe(true)
    expect(res.data?.success ?? false, 'res.data.success 应为 true').toBe(true)

    // 等 audit 写入 (fs.appendFileSync 同步, 但 Node 可能有微任务延迟 — 给一拍)
    await new Promise((r) => setTimeout(r, 500))

    // 断言恰新增 2 行 (start + finish), 解析新行字段
    const after = auditLineCount()
    console.log(`  审计终态行数: ${after} (新增 ${after - before})`)
    expect(after, `行数差应为 2 (start + finish), 实际 ${after - before}`).toBe(before + 2)

    // 解析新 2 行 (最后 2 行)
    const last2 = readAudit(2)
    console.log(`  末 2 行: ${JSON.stringify(last2).slice(0, 300)}`)
    expect(last2, '新 2 行不应有 parse 错').not.toContainEqual(expect.objectContaining({ _parse_error: expect.anything() }))

    // start 行断言 (第 1 行)
    const start = last2[0]
    expect(start.baseCmd, 'start 行 baseCmd 应为 git').toBe('git')
    expect(start.humanConfirm, `start 行 humanConfirm 应为 'true' (实际: ${start.humanConfirm})`).toBe('true')
    expect(start.confirmChannel).toBe('ui')
    expect(start.contextKind).toBe('ui')
    expect(start.phase).toBe('start')

    // finish 行断言 (第 2 行)
    const finish = last2[1]
    expect(finish.baseCmd, 'finish 行 baseCmd 应为 git').toBe('git')
    expect(finish.exit, `finish 行 exit 应为 0 (实际: ${finish.exit})`).toBe(0)
    expect(finish.phase).toBe('finish')
    expect(finish.opId, 'finish 行 opId 应有').toBeTruthy()
    expect(start.opId, 'start 行 opId 应有').toBeTruthy()
    expect(finish.opId, 'start/finish 同 opId (phase 配对)').toBe(start.opId)
  }, { timeout: 60_000 })

  // ═══════════════════════════════════════════════════════════════
  // S2 拒绝路径: 弹窗 → 真点击「拒绝」→ 未执行 → 审计 humanConfirm='false'
  // ═══════════════════════════════════════════════════════════════
  test('S2-deny: git status → 弹窗 → 拒绝 → 失败 + 审计 humanConfirm="false"', async () => {
    // 权限集应还是 permissive (同 describe, 前一个 test 已设)
    // 但保险起见, 再确认一次 (若 setActive 是持久化的, 这里幂等 OK)
    await setPermissivePermissionSet()

    const before = auditLineCount()
    console.log(`  审计基线行数: ${before}`)

    const res = await executeAndRespond({ cmd: 'git', args: ['status'], respond: 'deny' })

    // 断言 res.success === false (gateway 侧: deny → EACCES → PERMISSION_DENIED, OpenClawGateway.ts:489-504 实读)
    expect(res, 'execute result 不能为 null').not.toBeNull()
    expect(res.success, `res.success 应为 false (实际: ${JSON.stringify(res)})`).toBe(false)
    expect(res.data?.errorCode, `res.data.errorCode 应为 PERMISSION_DENIED (实际: ${res.data?.errorCode})`).toBe('PERMISSION_DENIED')
    // 文案 = formatErrorMessage EACCES 固定措辞 (OpenClawGateway.ts:344 实读), 非咽喉原因文本
    expect(String(res.data?.error), `res.data.error (实际: ${res.data?.error})`).toMatch(/权限不足|拒绝|denied/)
    expect(res.data?.status, `res.data.status 应为 failed (实际: ${res.data?.status})`).toBe('failed')

    // 等 audit 写入
    await new Promise((r) => setTimeout(r, 500))

    // 断言恰新增 1 行 (deny 行, 无 finish 行)
    const after = auditLineCount()
    console.log(`  审计终态行数: ${after} (新增 ${after - before})`)
    expect(after, `行数差应为 1 (deny 行, 无 finish), 实际 ${after - before}`).toBe(before + 1)

    // 解析新 1 行
    const last1 = readAudit(1)
    console.log(`  末 1 行: ${JSON.stringify(last1).slice(0, 300)}`)
    expect(last1, 'deny 行不应有 parse 错').not.toContainEqual(expect.objectContaining({ _parse_error: expect.anything() }))
    expect(last1.length).toBe(1)

    const deny = last1[0]
    expect(deny.baseCmd, 'deny 行 baseCmd 应为 git').toBe('git')
    expect(deny.humanConfirm, `deny 行 humanConfirm 应为 'false' (实际: ${deny.humanConfirm})`).toBe('false')
    expect(deny.contextKind).toBe('ui')
    expect(deny.phase, `deny 行 phase 应为 'deny' (writeDenyRow 实读, 实际: ${deny.phase})`).toBe('deny')
    expect(deny.denied, 'deny 行 denied 应为 true').toBe(true)
    expect(deny.denialReason, `deny 行应含 denialReason (实际: ${deny.denialReason})`).toBeTruthy()
    expect(deny.confirmChannel, `deny 行 confirmChannel (实际: ${deny.confirmChannel})`).toBe('ui-reject/timeout')
  }, { timeout: 60_000 })
})
