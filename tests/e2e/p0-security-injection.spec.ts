/**
 * P0-Security Test 3: runCommand shell 注入防护
 *
 * 漏洞背景 (后端审计 C1):
 *   electron/openclaw/OpenClawGateway.ts runCommand
 *     改前: shell:true (默认), args 数组直接空格拼接, baseCmd split(' ')[0] 白名单注释掉
 *     含义: 经典命令注入。LLM 工具调用 / IPC / HTTP 任意一处都能执行任意命令。
 *   改后:
 *     - shell 参数强制 false (走 execFile 数组传参, 不经 shell 解析)
 *     - baseCmd 必须白名单内 (COMMAND_ALLOWLIST)
 *     - baseCmd 不能含 shell metachar (空格 & ; | ` $ < > ( ) { } \)
 *     - args 不能含 null byte
 *     - cwd 必须在 ~/.pipiclaw/sandbox/ 或 ~/.pipiclaw/workspace/ 下
 *
 * 期望 (基线 / 改前): 注入 `echo safe; cat /etc/passwd` → 实际执行 cat (洞)
 * 期望 (改后): 含 ; 的 command → server 拒绝 (400/422/500 with 白名单错误)
 *
 * 运行配方 (验收复跑依据, 钉死环境):
 *   1) 前置: npm run build (dist-electron/main.js 必须已产出 — 本 spec 走 _electron.launch, 无此文件直接红)
 *   2) 浏览器: export PLAYWRIGHT_BROWSERS_PATH=0  (钉死项目本地 chromium, 不依赖全局缓存)
 *   3) 单跑: npx playwright test tests/e2e/p0-security-injection.spec.ts
 *      全量: npx playwright test
 *   4) 环境变量: E2E_ELECTRON=1  (若 CI 防御性 skip 生效, 本 spec 会静默 skipped — 跑前确认)
 *   5) 期望: 3 passed, 0 failed; 拒绝通道 = PERMISSION_DENIED (safe 模板默认 shell 禁用,
 *      或名单层拒绝; 断言只钉 errorCode, 不锁定中文文案)
 */

import { test, expect } from '@playwright/test'
import { launchAndProbe, makeUserDataDir, safeRequest } from './_p0-helpers'

/**
 * 通过 IPC `task:execute` 调 runCommand, 验证 OpenClawGateway.runCommand 拦截逻辑。
 * 不走 HTTP /execute, 避开 token 鉴权 (token IPC 未在 preload 暴露)。
 */
async function executeRunCommand(win: import('@playwright/test').Page, params: { command: string; args?: string[]; cwd?: string }): Promise<{ status: number; body: string }> {
  return win.evaluate(async (params) => {
    const api: any = (window as any).electronAPI
    // 走 openclaw.execute (openclaw:execute) 直接调 OpenClawGateway.runCommand
    // 注: task.execute 走 TaskExecutor, 它会丢 args, 没法测 args null byte
    const r = await api?.openclaw?.execute?.({
      operationType: 'run_command',
      params,
    })
    return r ?? null
  }, params).then((r: any) => ({
    status: r?.success === false ? 500 : 200,
    body: JSON.stringify(r ?? { error: 'no response' }),
  }))
}

const userDataDir = makeUserDataDir('injection')

test.describe('P0 Security: runCommand shell 注入防护', () => {
  let app: import('@playwright/test').ElectronApplication
  let win: import('@playwright/test').Page
  let gatewayPort: number
  let token: string | null = null

  test.beforeAll(async () => {
    // 走 IPC 调 runCommand (task:execute), 不依赖 HTTP token 鉴权
    const r = await launchAndProbe(userDataDir)
    app = r.app
    win = r.win
    gatewayPort = r.gatewayPort
  }, { timeout: 60_000 })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
  })

  test('runCommand 含 shell metachar (;) 应被拒 (改前注入, 改后拒绝)', async () => {
    const r = await executeRunCommand(win, {
      // 注入: baseCmd='echo' (白名单内), 但 'safe; cat /etc/passwd' 含 ; 触发拒绝
      command: 'echo safe; cat /etc/passwd',
      args: [],
    })
    console.log(`  shell-meta command body=${r.body.slice(0, 250)}`)
    // 改前: 200 + 真跑了 echo + cat (洞)
    // 改后: 拒绝 (白名单检查失败 / shell metachar / 错误码)
    // 钉死拒绝通道: 响应 JSON 含 "errorCode":"PERMISSION_DENIED"
    // (safe 模板默认 shell 禁用 → PermissionManager 拒绝; 文案会随模板变, 不再断言中文措辞)
    expect(r.body, 'server 必须拒绝含 shell metachar 的 command').toContain('PERMISSION_DENIED')
    expect(r.body.includes('root:'), 'server 不应执行 cat /etc/passwd (body 不应包含 root:)').toBe(false)
  })

  test('runCommand 不在白名单的命令应被拒 (改前允许, 改后拒绝)', async () => {
    // nc (netcat) 不在 COMMAND_ALLOWLIST (白名单只有 git/node/python/curl/wget 等)
    // 改前: 任意命令可跑, 改后: 不在白名单拒绝
    const r = await executeRunCommand(win, {
      command: 'nc',  // 不在白名单
      args: ['-h'],
    })
    console.log(`  non-allowlist nc body=${r.body.slice(0, 250)}`)
    // 两层拒绝都可能命中 (权限层先于名单层), 通道统一 PERMISSION_DENIED
    expect(r.body, '不在自动放行/确认名单的命令必须被拒').toContain('PERMISSION_DENIED')
  })

  test('runCommand 含 null byte 参数应被拒', async () => {
    const r = await executeRunCommand(win, {
      command: 'echo',  // echo 在白名单, 用它测 args null byte
      args: ['safe\0injected'],
    })
    console.log(`  null-byte arg body=${r.body.slice(0, 250)}`)
    expect(r.body, '含 null byte 的参数必须被拒').toContain('PERMISSION_DENIED')
  })
})
