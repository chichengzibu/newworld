/**
 * New World - create_artifact 工具（成品交付闭环）
 *
 * 【要补的短板】
 * 此前 agent 只能改已有文本或跑命令；唯一真 docx 生成器锁在 OpenClawGateway 里，
 * 且会话导出的 word/pdf 实际写 .html 却上报 .docx/.pdf —— 典型假交付。
 * 本工具用真实库生成合法 docx / xlsx / pptx 并落盘，返回 stat 得到的真实路径与大小。
 *
 * 【安全】
 * 写操作 → requiresPermission:true，ToolGate 标 confirm；headless 无确认桥时拒绝。
 * 文件名只取 basename 并清洗，路径固定落在 userData/workspace，不接受任意目录。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Document, Packer, Paragraph, HeadingLevel } from 'docx'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import { getHost } from '../../platform/runtime'
import { LogManager } from '../../core/LogManager'
import type { PiPiTool, ToolExecResult, ProducedArtifact } from './Tool'

const log = LogManager.getInstance()

type ArtifactType = 'document' | 'spreadsheet' | 'presentation'
const EXT_BY_TYPE: Record<ArtifactType, string> = {
  document: '.docx',
  spreadsheet: '.xlsx',
  presentation: '.pptx',
}
const MIME_BY_TYPE: Record<ArtifactType, string> = {
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function safeFileName(raw: unknown, type: ArtifactType): string {
  const stem = path.basename(String(raw ?? ''))
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_')
    .slice(0, 80) || 'artifact'
  return `${stem}${EXT_BY_TYPE[type]}`
}

/** 极简 Markdown → docx 段落：标题 / 列表 / 正文，不引入 HTML 中转。 */
function markdownToParagraphs(content: string): Paragraph[] {
  return content.split(/\r?\n/).map((line) => {
    const text = line.trim()
    if (!text) return new Paragraph({ text: '' })
    if (text.startsWith('### ')) {
      return new Paragraph({ text: text.slice(4), heading: HeadingLevel.HEADING_3 })
    }
    if (text.startsWith('## ')) {
      return new Paragraph({ text: text.slice(3), heading: HeadingLevel.HEADING_2 })
    }
    if (text.startsWith('# ')) {
      return new Paragraph({ text: text.slice(2), heading: HeadingLevel.HEADING_1 })
    }
    if (/^[-*]\s+/.test(text)) {
      return new Paragraph({ text: text.replace(/^[-*]\s+/, ''), bullet: { level: 0 } })
    }
    return new Paragraph({ text })
  })
}

/** CSV 行解析（支持引号包裹与逗号转义），不依赖额外 csv 库。 */
function parseCsvRow(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ } else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

export const CreateArtifactToolMetadata = {
  name: 'create_artifact',
  description:
    '生成一份可直接交付的成品文件（真实 docx/xlsx/pptx）。当用户要求"整理成文档/表格/PPT、' +
    '导出报告、生成可下载文件"时调用。type=document 时 content 用 Markdown；' +
    'type=spreadsheet 时 content 用 CSV（首行为表头）；type=presentation 时每页以空行分隔、' +
    '首行为标题、其余为要点。返回真实文件路径，用户可在对话中点击打开。',
  parametersJson: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['document', 'spreadsheet', 'presentation'] },
      filename: { type: 'string', description: '文件名（不含扩展名也可，扩展名会按 type 自动正确生成）' },
      content: { type: 'string', description: '文件内容；按 type 使用 Markdown / CSV / 幻灯片文本' },
    },
    required: ['type', 'filename', 'content'],
  },
  requiresPermission: true,
  domain: 'deliverable',
}

export class CreateArtifactTool implements PiPiTool {
  metadata = CreateArtifactToolMetadata

  async execute(args: Record<string, unknown>): Promise<ToolExecResult> {
    const type = String(args?.type ?? '') as ArtifactType
    if (!EXT_BY_TYPE[type]) {
      return { ok: false, result: '', error: 'type 必须是 document / spreadsheet / presentation' }
    }
    const content = String(args?.content ?? '')
    if (!content.trim()) {
      return { ok: false, result: '', error: 'content 不能为空 —— 不生成空壳文件' }
    }

    const targetDir = path.join(getHost().getPath('userData'), 'workspace')
    const target = path.join(targetDir, safeFileName(args.filename, type))
    await fs.mkdir(targetDir, { recursive: true })

    try {
      if (type === 'document') {
        const doc = new Document({ sections: [{ children: markdownToParagraphs(content) }] })
        await fs.writeFile(target, await Packer.toBuffer(doc))
      } else if (type === 'spreadsheet') {
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet('Sheet1')
        for (const line of content.split(/\r?\n/).filter(l => l.trim())) ws.addRow(parseCsvRow(line))
        ws.getRow(1).font = { bold: true }
        await fs.writeFile(target, Buffer.from(await wb.xlsx.writeBuffer()))
      } else {
        const pptx = new PptxGenJS()
        for (const block of content.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)) {
          const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
          const slide = pptx.addSlide()
          slide.addText(lines[0] ?? '未命名', { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true })
          const bullets = lines.slice(1).map(t => ({
            text: t.replace(/^[-*]\s*/, ''),
            options: { bullet: true, breakLine: true },
          }))
          if (bullets.length) {
            slide.addText(bullets as never, { x: 0.6, y: 1.4, w: 8.8, h: 4.6, fontSize: 18 })
          }
        }
        await pptx.writeFile({ fileName: target })
      }

      const stat = await fs.stat(target)
      const artifact: ProducedArtifact = {
        path: target,
        name: path.basename(target),
        mimeType: MIME_BY_TYPE[type],
        size: stat.size,
        kind: type,
      }
      log.info(`[CreateArtifact] 已生成 ${artifact.name} (${stat.size} bytes) -> ${target}`)
      return {
        ok: true,
        result: `已生成成品文件：${artifact.name}\n路径：${target}\n大小：${stat.size} bytes。用户可在对话中点击打开。`,
        artifacts: [artifact],
      }
    } catch (e) {
      const error = `成品生成失败：${(e as Error).message}`
      log.error('[CreateArtifact]', error)
      return { ok: false, result: '', error }
    }
  }
}
