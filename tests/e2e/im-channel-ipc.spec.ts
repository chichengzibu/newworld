import { test, expect, shouldRunElectronE2E, gotoBySideNav } from './helpers/electron-app'

/**
 * IM 真连通 · IPC 桩修复验收（真实 Electron）
 *
 * 此前 channel:list 恒返回 []、channel:health 恒返回 {healthy:true, stub:true}、
 * permission:list 调不存在的 listRules 恒返回 []。这些在单测里看不到，
 * 必须在真实 IPC 面上钉住。
 *
 * 钉住:
 *   IM1: channel:health 对不存在通道返回 healthy:false 且不再带 stub 字段
 *   IM2: channel:list / channel:poller-status 返回真实结构
 *   IM3: permission:grant → list → revoke 真往返（白名单真生效，不是本地假操作）
 *   IM4: /im 管理页 5 个 tab + 刷新健康检查按钮可见，无 IPC 报错
 */

test.describe('IM 通道 IPC 真连通', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('IM1: channel:health 不再恒返回 healthy:true/stub:true', async ({ window }) => {
    const result = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      return await api.channel.health('im-channel-that-does-not-exist')
    })
    expect(result.success).toBe(true)
    expect(result.data.healthy).toBe(false)
    expect(result.data.channelId).toBe('im-channel-that-does-not-exist')
    // 关键:桩标记必须消失
    expect(result.data.stub).toBeUndefined()
    expect(result.data.error).toContain('not found')
  })

  test('IM2: channel:list 与 poller-status 返回真实结构', async ({ window }) => {
    const [listResult, pollerResult] = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      return [await api.channel.list(), await api.channel.pollerStatus()]
    })
    expect(listResult.success).toBe(true)
    expect(Array.isArray(listResult.data)).toBe(true)
    for (const row of listResult.data) {
      expect(row).toHaveProperty('kind')
      expect(row).toHaveProperty('healthy')
      expect(row.stub).toBeUndefined()
    }
    expect(pollerResult.success).toBe(true)
    expect(typeof pollerResult.data.running).toBe('boolean')
    expect(typeof pollerResult.data.offset).toBe('number')
  })

  test('IM3: permission grant → list → revoke 真往返', async ({ window }) => {
    const userId = `e2e-user-${Date.now()}`
    const granted = await window.evaluate(async (uid: string) => {
      const api = (window as any).electronAPI
      return await api.channel.permissionGrant({ channelKind: 'im-feishu', userId: uid })
    }, userId)
    expect(granted.success).toBe(true)

    const listed = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      return await api.channel.permissionList()
    })
    expect(listed.success).toBe(true)
    expect(Array.isArray(listed.data)).toBe(true)
    expect(listed.data.some((p: any) => p.subject === userId)).toBe(true)

    const revoked = await window.evaluate(async (uid: string) => {
      const api = (window as any).electronAPI
      return await api.channel.permissionRevoke({ channelKind: 'im-feishu', userId: uid })
    }, userId)
    expect(revoked.success).toBe(true)

    const after = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      return await api.channel.permissionList()
    })
    expect(after.data.some((p: any) => p.subject === userId)).toBe(false)
  })

  test('IM4: IM 管理页挂载正常，健康检查入口可见', async ({ window }) => {
    const errors: string[] = []
    window.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await gotoBySideNav(window, '/im-management')
    await expect(window.locator('.im-management')).toBeVisible()
    // v4.9：IM 管理已内嵌进设置页配置中心（隐藏自带页头避免与设置页标题重复），
    // 因此「IM 管理」文字由设置页左侧选栏承载，不再出现在 .im-management 内部。
    await expect(window.locator('nav.settings-nav')).toBeVisible({ timeout: 8_000 })
    await expect(
      window.locator('a.settings-link[href$="#/im-management"]'),
    ).toHaveClass(/is-active/, { timeout: 8_000 })
    const text = await window.locator('.im-management').innerText()
    for (const tab of ['通道配置', '状态仪表板', '消息查看器', '路由规则', '权限管理']) {
      expect(text).toContain(tab)
    }
    // el-tabs 面板懒渲染：切到状态仪表板后健康检查按钮才进 DOM
    await window.locator('.el-tabs__item', { hasText: '状态仪表板' }).click()
    await expect(window.getByRole('button', { name: '刷新健康检查' })).toBeVisible({ timeout: 10_000 })
    expect(errors.filter((e) => /channelConfig|permissionList|messageHistory/i.test(e))).toEqual([])
  })
})
