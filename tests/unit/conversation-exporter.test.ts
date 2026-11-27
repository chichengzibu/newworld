/**
 * 对话导出"假交付"回归
 *
 * [ROUTE] 旧实现把 HTML 写到 .html，却向调用方回报 .docx/.pdf —— 用户拿到一个
 * 扩展名对、内容完全不对的文件。这里把"路径后缀 == 真实内容"钉成断言。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { setHost } from '../../electron/platform/runtime'
import { TestHost, TEST_USER_DATA } from './test-host'
import { PermissionManager } from '../../electron/permissions/PermissionManager'
import { ConversationExporter } from '../../electron/utils/ConversationExporter'
import type { Conversation } from '../../electron/chat/ChatTypes'

const OUT = path.join(TEST_USER_DATA, 'downloads')
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

const conversation: Conversation = {
  id: 'conv-1',
  title: '验收对话',
  messages: [
    { id: 'm1', role: 'user', content: '请导出报告', timestamp: 1, status: 'sent' },
    { id: 'm2', role: 'assistant', content: '好的，这是报告', timestamp: 2, status: 'sent' },
  ],
  createdAt: 1,
  updatedAt: 2,
  status: 'active',
  pinned: false,
}

describe('ConversationExporter 真实格式', () => {
  const exporter = ConversationExporter.getInstance()

  beforeEach(() => {
    setHost(new TestHost())
    fs.mkdirSync(OUT, { recursive: true })
    vi.spyOn(PermissionManager.getInstance(), 'checkPermission')
      .mockReturnValue({ allowed: true, reason: '' } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const f of fs.readdirSync(OUT)) {
      fs.rmSync(path.join(OUT, f), { force: true, recursive: true })
    }
  })

  it('CE1 word → 真 .docx，ZIP 魔数正确且 actualFormat=docx', async () => {
    const target = path.join(OUT, '报告.docx')
    const r = await exporter.exportConversation(conversation, { format: 'word', outputPath: target })
    expect(r.success).toBe(true)
    expect(r.actualFormat).toBe('docx')
    expect(r.degraded).toBeFalsy()
    expect(r.filePath).toBe(target)
    expect(fs.readFileSync(target).subarray(0, 4)).toEqual(ZIP_MAGIC)
  })

  it('CE2 传 .html 后缀也纠正为 .docx —— 不允许后缀与内容不符', async () => {
    const target = path.join(OUT, '报告.html')
    const r = await exporter.exportConversation(conversation, { format: 'word', outputPath: target })
    expect(r.success).toBe(true)
    expect(r.filePath).toBe(path.join(OUT, '报告.docx'))
    expect(fs.existsSync(path.join(OUT, '报告.html'))).toBe(false)
    expect(fs.readFileSync(r.filePath!).subarray(0, 4)).toEqual(ZIP_MAGIC)
  })

  it('CE3 PDF 渲染不可用时诚实降级为 .html，不再谎报 .pdf', async () => {
    // 全局 electron mock 的 BrowserWindow 没有 loadURL → printToPDF 路径必失败
    const target = path.join(OUT, '报告.pdf')
    const r = await exporter.exportConversation(conversation, { format: 'pdf', outputPath: target })

    expect(r.success).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.actualFormat).toBe('html')
    expect(r.filePath).toBe(path.join(OUT, '报告.html'))
    expect(r.guidance).toContain('打印为 PDF')
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.readFileSync(r.filePath!, 'utf-8')).toContain('<!DOCTYPE html>')
  })

  it('CE4 markdown 保持真实 .md', async () => {
    const target = path.join(OUT, '报告.md')
    const r = await exporter.exportConversation(conversation, { format: 'markdown', outputPath: target })
    expect(r.success).toBe(true)
    expect(r.actualFormat).toBe('markdown')
    expect(r.filePath).toBe(target)
    expect(fs.readFileSync(target, 'utf-8')).toContain('# 验收对话')
  })
})
