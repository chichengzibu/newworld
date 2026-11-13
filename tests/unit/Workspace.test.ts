import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-ws-${k}`) },
}))

vi.mock('electron-log', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } } },
}))

import { WorkspaceManager } from '../../electron/sandbox/workspace'

describe('WorkspaceManager', () => {
  let wm: WorkspaceManager

  beforeEach(() => {
    vi.clearAllMocks()
    wm = WorkspaceManager.getInstance()
  })

  it('getInstance returns singleton', () => {
    expect(WorkspaceManager.getInstance()).toBe(wm)
  })

  it('createWorkspace returns a workspace with id and hostPath', () => {
    const ws = wm.createWorkspace({ name: 'project-1' })
    expect(ws.id).toBeTruthy()
    expect(ws.hostPath).toContain(ws.id)
    expect(ws.containerPath).toBe('/mnt/data')
  })

  it('createWorkspace creates host directory on disk', () => {
    const ws = wm.createWorkspace({ name: 'check-fs' })
    expect(fs.existsSync(ws.hostPath)).toBe(true)
  })

  it('getWorkspace returns existing workspace', () => {
    const ws = wm.createWorkspace({ name: 'lookup' })
    const got = wm.getWorkspace(ws.id)
    expect(got?.id).toBe(ws.id)
  })

  it('getWorkspace returns undefined for unknown id', () => {
    expect(wm.getWorkspace('nonexistent')).toBeUndefined()
  })

  it('listWorkspaces returns workspaces sorted by createdAt desc', () => {
    const a = wm.createWorkspace({ name: 'first' })
    const b = wm.createWorkspace({ name: 'second' })
    const list = wm.listWorkspaces()
    expect(list[0].id).toBe(b.id)
    expect(list[1].id).toBe(a.id)
  })

  it('【M4-N】同一毫秒创建的 workspace 仍然是「新的在前」(排序键相同时不靠运气)', () => {
    // createdAt 是 Date.now() 的毫秒精度 → 同毫秒创建时排序键相同,
    // 而 Array.sort 是稳定的 → 会保留插入顺序(旧的在前),与
    // 「按 createdAt desc(新的在前)」的承诺不符。
    // 这条用例把时钟钉死,让"同毫秒"这个分支**每次都跑到**,
    // 而不是靠运气(实测 8 轮里偶发 1 轮)。
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const a = wm.createWorkspace({ name: 'same-ms-a' })
      const b = wm.createWorkspace({ name: 'same-ms-b' })
      expect(a.createdAt).toBe(b.createdAt)   // 确认真的同毫秒
      const list = wm.listWorkspaces()
      // 【为什么断相对顺序而不是绝对位置】WorkspaceManager 是**单例**,
      // 同一文件里前面的用例已经建过 workspace(真实时间戳,比我 mock 的新)
      // → 绝对位置轮不到这两个。只断 a 与 b 的相对次序。
      const ia = list.findIndex(w => w.id === a.id)
      const ib = list.findIndex(w => w.id === b.id)
      expect(ib, '同毫秒时后建的应排前面').toBeLessThan(ia)
    } finally {
      spy.mockRestore()
    }
  })

  it('deleteWorkspace removes it from list', () => {
    const ws = wm.createWorkspace({ name: 'to-delete' })
    const ok = wm.deleteWorkspace(ws.id)
    expect(ok).toBe(true)
    expect(wm.getWorkspace(ws.id)).toBeUndefined()
  })

  it('hostToContainer returns /mnt/data', () => {
    const ws = wm.createWorkspace({ name: 'h2c' })
    const cp = wm.hostToContainer(ws.id, '/some/file')
    expect(cp).toBe('/mnt/data/some/file')
  })

  it('containerToHost returns the workspace hostPath', () => {
    const ws = wm.createWorkspace({ name: 'c2h' })
    const hp = wm.containerToHost(ws.id, '/mnt/data/file.txt')
    expect(hp).toBe(path.join(ws.hostPath, 'file.txt'))
  })
})
