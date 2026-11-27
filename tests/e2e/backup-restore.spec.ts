import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'

/**
 * 本地备份闭环（无服务器）
 *
 * BE1: 真实 Electron 下 create → list → restore 走 IPC 全链路，
 *      验证 zip 真落盘、清单可读、恢复产出保护性备份。
 * 用 IPC 注入而非表单填写，避免 UI flaky；UI tab 由 i18n/组件层覆盖。
 */
test.describe('本地备份导出导入', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('BE1: create → list → restore 全链路', async ({ window }) => {
    await window.waitForSelector('#app', { timeout: 10_000 })
    await window.waitForTimeout(600)

    const created = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      const r = await api.backup.create({ includeApiKeys: false })
      return {
        success: r?.success,
        error: r?.error,
        filePath: r?.data?.filePath,
        size: r?.data?.size,
        apiKeysIncluded: r?.data?.manifest?.apiKeysIncluded,
      }
    })
    expect(created.success, created.error || '').toBe(true)
    expect(created.filePath).toMatch(/nw-backup-.*\.zip$/)
    expect(created.size).toBeGreaterThan(0)
    expect(created.apiKeysIncluded).toBe(false)

    const listed = await window.evaluate(async () => {
      const r = await (window as any).electronAPI.backup.list()
      return { success: r?.success, data: r?.data }
    })
    expect(listed.success).toBe(true)
    expect(Array.isArray(listed.data)).toBe(true)
    expect((listed.data as unknown[]).length).toBeGreaterThan(0)

    const restored = await window.evaluate(async (filePath: string) => {
      const r = await (window as any).electronAPI.backup.restore(filePath)
      return {
        success: r?.success,
        error: r?.error,
        restored: r?.data?.restored,
        safety: r?.data?.safetyBackupPath,
      }
    }, created.filePath as string)
    expect(restored.success, restored.error || '').toBe(true)
    expect(restored.restored).toContain('config')
    expect(restored.safety).toBeTruthy()

    const after = await window.evaluate(async () => {
      const r = await (window as any).electronAPI.backup.list()
      return r?.data?.length ?? 0
    })
    expect(after).toBeGreaterThanOrEqual(2)
  })
})
