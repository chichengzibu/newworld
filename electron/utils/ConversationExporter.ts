/**
 * New World - 对话导出工具
 * 
 * 职责：
 * 1. 将会话内容导出为Markdown/PDF/Word格式
 * 2. 前置对接PermissionManager做权限校验
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';
import { getHost } from '../platform/runtime'

import { LogManager } from '../core/LogManager';
import { PermissionManager } from '../permissions/PermissionManager';
import type { Conversation } from '../chat/ChatTypes';

export interface ExportOptions {
  format: 'markdown' | 'pdf' | 'word';
  outputPath: string;
}

export interface ExportResult {
  success: boolean;
  /** 真实写入的文件路径（降级时是 .html，不再是谎报的 .pdf/.docx） */
  filePath?: string;
  /** 实际格式：raw markdown / 真 docx / 真 pdf / 降级 html */
  actualFormat?: 'markdown' | 'docx' | 'pdf' | 'html';
  /** true = 请求格式未能生成，已诚实降级 */
  degraded?: boolean;
  error?: string;
  guidance?: string;
}

export class ConversationExporter {
  private static instance: ConversationExporter;
  private log = LogManager.getInstance();
  private permissionManager: PermissionManager;

  private constructor() {
    this.permissionManager = PermissionManager.getInstance();
  }

  public static getInstance(): ConversationExporter {
    if (!ConversationExporter.instance) {
      ConversationExporter.instance = new ConversationExporter();
    }
    return ConversationExporter.instance;
  }

  /**
   * 导出对话
   */
  public async exportConversation(
    conversation: Conversation,
    options: ExportOptions
  ): Promise<ExportResult> {
    try {
      let outputPath = options.outputPath;

      if (!outputPath) {
        const downloadsPath = getHost().getPath('downloads');
        const timestamp = new Date().getTime();
        const safeTitle = conversation.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 20);

        switch (options.format) {
          case 'markdown':
            outputPath = path.join(downloadsPath, `${safeTitle}_${timestamp}.md`);
            break;
          case 'pdf':
            outputPath = path.join(downloadsPath, `${safeTitle}_${timestamp}.pdf`);
            break;
          case 'word':
            outputPath = path.join(downloadsPath, `${safeTitle}_${timestamp}.docx`);
            break;
        }
      }

      // 后缀必须与真实内容一致 —— 绝不出现"路径写 .docx、内容是 HTML"的假交付
      if (options.format === 'word') outputPath = withExtension(outputPath, '.docx');
      if (options.format === 'pdf') outputPath = withExtension(outputPath, '.pdf');

      const dir = path.dirname(outputPath);
      const permCheck = this.permissionManager.checkPermission({
        category: 'filesystem',
        action: 'write',
        resource: dir
      });

      if (!permCheck.allowed) {
        return {
          success: false,
          error: `无写入权限: ${permCheck.reason}`,
          guidance: '请在权限管理中启用「文件系统」的「写入」权限'
        };
      }

      let content: string;
      let actualFormat: ExportResult['actualFormat'];
      let degraded = false;
      let guidance: string | undefined;

      switch (options.format) {
        case 'markdown':
          content = this.generateMarkdown(conversation);
          fs.writeFileSync(outputPath, content, 'utf-8');
          actualFormat = 'markdown';
          break;
        case 'word':
          content = this.generateMarkdown(conversation);
          await this.generateWord(content, outputPath);
          actualFormat = 'docx';
          break;
        case 'pdf': {
          content = this.generateMarkdown(conversation);
          const html = this.markdownToHtml(content);
          if (await this.generatePdf(html, outputPath)) {
            actualFormat = 'pdf';
          } else {
            // 真 PDF 不可用时不谎报 —— 写真实 .html 并回传实际路径与格式
            const htmlPath = withExtension(outputPath, '.html');
            fs.writeFileSync(htmlPath, html, 'utf-8');
            outputPath = htmlPath;
            actualFormat = 'html';
            degraded = true;
            guidance = 'PDF 渲染不可用，已保存为 HTML；可在浏览器中打开并打印为 PDF。';
          }
          break;
        }
      }

      this.log.info('[ConversationExporter] 导出成功:', outputPath, `(${actualFormat})`);
      return { success: true, filePath: outputPath, actualFormat, degraded, guidance };

    } catch (error: any) {
      this.log.error('[ConversationExporter] 导出失败:', error);
      return {
        success: false,
        error: error.message || '导出失败'
      };
    }
  }

  /**
   * 生成Markdown内容
   */
  private generateMarkdown(conversation: Conversation): string {
    const lines: string[] = [];
    
    lines.push(`# ${conversation.title}`);
    lines.push('');
    lines.push(`**创建时间:** ${new Date(conversation.createdAt).toLocaleString('zh-CN')}`);
    lines.push(`**模型:** ${conversation.modelId || '未指定'}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const message of conversation.messages) {
      const roleIcon = message.role === 'user' ? '👤' : '🤖';
      const roleName = message.role === 'user' ? '用户' : 'AI';
      const time = new Date(message.timestamp).toLocaleString('zh-CN');
      
      lines.push(`### ${roleIcon} ${roleName} - ${time}`);
      lines.push('');

      if (message.thinking) {
        lines.push('**思考过程:**');
        lines.push('```');
        lines.push(message.thinking);
        lines.push('```');
        lines.push('');
      }

      const content = message.content || '(无内容)';
      lines.push(content);
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    lines.push('');
    lines.push(`*导出时间: ${new Date().toLocaleString('zh-CN')}*`);
    
    return lines.join('\n');
  }

  /**
   * 真 PDF：离屏窗口 printToPDF。失败由调用方降级为真实 .html，绝不把 HTML 报成 PDF。
   */
  private async generatePdf(html: string, outputPath: string): Promise<boolean> {
    let win: BrowserWindow | undefined;
    try {
      win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      await fs.promises.writeFile(outputPath, pdf);
      return true;
    } catch (e) {
      this.log.warn('[ConversationExporter] PDF 渲染失败，将诚实降级为 HTML:', e);
      return false;
    } finally {
      try { win?.destroy(); } catch { /* 窗口已销毁 */ }
    }
  }

  /** 真 docx：合法 OOXML（ZIP 魔数 PK\x03\x04），不再是套壳 HTML */
  private async generateWord(markdownContent: string, outputPath: string): Promise<void> {
    const children = markdownContent.split(/\r?\n/).map((line) => {
      const text = line.trim().replace(/\*\*/g, '');
      if (!text) return new Paragraph({ text: '' });
      if (text.startsWith('### ')) return new Paragraph({ text: text.slice(4), heading: HeadingLevel.HEADING_3 });
      if (text.startsWith('## ')) return new Paragraph({ text: text.slice(3), heading: HeadingLevel.HEADING_2 });
      if (text.startsWith('# ')) return new Paragraph({ text: text.slice(2), heading: HeadingLevel.HEADING_1 });
      return new Paragraph({ text });
    });
    const doc = new Document({ sections: [{ children }] });
    await fs.promises.writeFile(outputPath, await Packer.toBuffer(doc));
  }

  /**
   * Markdown转HTML
   */
  private markdownToHtml(markdown: string): string {
    const html = markdown
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.*)\*\*/g, '<strong>$1</strong>')
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/---/g, '<hr>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>对话导出</title>
  <style>
    body { font-family: 'Microsoft YaHei', sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
    h1, h2, h3 { color: #333; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
    code { font-family: 'Consolas', monospace; }
    hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
    .meta { color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <p>${html}</p>
</body>
</html>`;
  }

}

/** 把路径后缀纠正为真实格式，避免"内容是 HTML、文件名是 .docx"的欺骗 */
function withExtension(p: string, ext: string): string {
  return /\.[a-zA-Z0-9]+$/.test(p) ? p.replace(/\.[a-zA-Z0-9]+$/, ext) : `${p}${ext}`;
}