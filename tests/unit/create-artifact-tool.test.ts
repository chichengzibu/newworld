/**
 * create_artifact 真实成品交付回归
 *
 * [ROUTE] 这里守的是"模型说已生成"和"磁盘上真有一个合法文件"的差别：
 *   - 三种格式都必须是合法 OOXML（ZIP 魔数 PK\x03\x04）
 *   - artifact 的 path/size 必须来自 stat，不是拼出来的字符串
 *   - 写操作必须过 ToolGate：无确认桥时拒绝，绝不静默写盘
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TestHost, TEST_USER_DATA } from './test-host'
import { setHost } from '../../electron/platform/runtime'
import { ToolGate } from '../../electron/agent/ToolGate'
import { CreateArtifactTool, CreateArtifactToolMetadata } from '../../electron/agent/tools/CreateArtifactTool'

const WORKSPACE = path.join(TEST_USER_DATA, 'workspace')
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

describe('create_artifact 真实成品交付', () => {
  const tool = new CreateArtifactTool()

  beforeEach(() => {
    setHost(new TestHost())
    fs.mkdirSync(WORKSPACE, { recursive: true })
  })

  afterEach(() => {
    for (const f of fs.readdirSync(WORKSPACE)) {
      fs.rmSync(path.join(WORKSPACE, f), { force: true, recursive: true })
    }
  })

  it('CA1 document → 真 .docx（ZIP 魔数 + stat 大小 + 真实路径）', async () => {
    const r = await tool.execute({
      type: 'document',
      filename: '验收报告',
      content: '# 验收报告\n\n## 结论\n- 通过\n正文段落',
    })
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.artifacts).toHaveLength(1)

    const a = r.artifacts![0]
    expect(a.name).toBe('验收报告.docx')
    expect(a.kind).toBe('document')
    expect(a.mimeType).toContain('wordprocessingml.document')
    expect(a.path).toBe(path.join(WORKSPACE, '验收报告.docx'))

    const buf = fs.readFileSync(a.path)
    expect(buf.subarray(0, 4)).toEqual(ZIP_MAGIC)
    expect(buf.length).toBeGreaterThan(0)
    expect(a.size).toBe(buf.length)
  })

  it('CA2 spreadsheet → 真 .xlsx（CSV 表头落地）', async () => {
    const r = await tool.execute({
      type: 'spreadsheet',
      filename: '清单',
      content: '名称,数量\n苹果,3\n香蕉,5',
    })
    expect(r.ok).toBe(true)
    const a = r.artifacts![0]
    expect(a.name).toBe('清单.xlsx')
    expect(a.kind).toBe('spreadsheet')
    expect(fs.readFileSync(a.path).subarray(0, 4)).toEqual(ZIP_MAGIC)
    expect(a.size).toBe(fs.statSync(a.path).size)
  })

  it('CA3 presentation → 真 .pptx（空行分页）', async () => {
    const r = await tool.execute({
      type: 'presentation',
      filename: '汇报',
      content: '第一页\n- 要点一\n- 要点二\n\n第二页\n- 收尾',
    })
    expect(r.ok).toBe(true)
    const a = r.artifacts![0]
    expect(a.name).toBe('汇报.pptx')
    expect(a.kind).toBe('presentation')
    expect(fs.readFileSync(a.path).subarray(0, 4)).toEqual(ZIP_MAGIC)
    expect(a.size).toBeGreaterThan(0)
  })

  it('CA4 非法 type / 空 content 直接拒绝，不落空壳文件', async () => {
    const bad = await tool.execute({ type: 'pdf', filename: 'x', content: 'something' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('type')
    expect(fs.existsSync(path.join(WORKSPACE, 'x.pdf'))).toBe(false)

    const empty = await tool.execute({ type: 'document', filename: 'empty', content: '   ' })
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('不能为空')
    expect(fs.existsSync(path.join(WORKSPACE, 'empty.docx'))).toBe(false)
  })

  it('CA5 文件名只取 basename 并清洗 —— 路径穿越逃不出 workspace', async () => {
    const r = await tool.execute({
      type: 'document',
      filename: '../../evil<>:name',
      content: '内容',
    })
    expect(r.ok).toBe(true)
    const a = r.artifacts![0]
    expect(a.name).not.toContain('/')
    expect(a.name).not.toContain('\\')
    expect(a.name.endsWith('.docx')).toBe(true)
    expect(a.path.startsWith(WORKSPACE + path.sep)).toBe(true)
  })

  it('CA6 写操作必须确认：无确认桥 / headless 一律拒绝', async () => {
    expect(CreateArtifactToolMetadata.name).toBe('create_artifact')
    expect(CreateArtifactToolMetadata.requiresPermission).toBe(true)

    const noBridge = await ToolGate.check(
      tool, { type: 'document', filename: 'a', content: 'x' }, { contextKind: 'ui' },
    )
    expect(noBridge.allowed).toBe(false)
    expect(noBridge.permission).toBe('confirm')

    const headless = await ToolGate.check(
      tool, { type: 'document', filename: 'a', content: 'x' }, { contextKind: 'headless' },
      { requestConfirmation: async () => true },
    )
    expect(headless.allowed).toBe(false)

    const confirm = vi.fn().mockResolvedValue(true)
    const d = await ToolGate.check(
      tool, { type: 'document', filename: '报告', content: 'x' }, { contextKind: 'ui' },
      { requestConfirmation: confirm },
    )
    expect(d.allowed).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][1]).toContain('报告')
  })
})
