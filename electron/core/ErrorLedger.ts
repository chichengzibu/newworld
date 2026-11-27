/**
 * New World — 本地错误台账(P0 工程规范批次, ADR 配套可观测性)
 *
 * 【为什么必须有】
 * 此前渲染进程的报错只存在于 console(关掉就没了)与 electron-log(散行文本),
 * 没有结构化聚合 —— 版本迭代时无法回答"哪类错误在涨"。
 * 本台账把渲染端错误按 humanizeError 的 kind 分类计数落盘(userData),
 * 纯本地 JSON, 零云端依赖(不配 Sentry DSN 也可用)。
 *
 * 【消费面】
 * - 渲染端: src/main.ts 三处错误钩子(Vue errorHandler / window.error /
 *   unhandledrejection)经 preload 桥 `errors.report()` 上报。
 * - 人工排查: userData/error-ledger.json 直接可读。
 *
 * 【约束】
 * - 记录上限 500 条(FIFO 裁剪), 文件 <200KB, 同步写可接受(低频)。
 * - 同 message 5s 内去重(防止 console.error 循环打爆台账)。
 */
import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export interface ErrorRecord {
  /** ms 时间戳 */
  ts: number;
  /** humanizeError 的 kind(auth/network/permission/...) 或 'unclassified' */
  kind: string;
  /** 一行摘要(截断 300 字符) */
  message: string;
  /** 错误来源: vue / window.error / unhandledrejection / console */
  source: string;
  /** 可选堆栈(截断 2000 字符) */
  stack?: string;
}

export class ErrorLedger {
  private readonly file: string;
  private records: ErrorRecord[] = [];
  private counts: Record<string, number> = {};
  private loaded = false;
  private lastMessageAt = new Map<string, number>();
  private static readonly MAX_RECORDS = 500;
  private static readonly DEDUPE_MS = 5_000;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'error-ledger.json');
  }

  /** 注册渲染端上报通道(main.ts 早期调用, 重复调用安全) */
  registerIpcHandlers(): void {
    for (const channel of ['error:report', 'error:summary']) {
      if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(channel);
    }
    ipcMain.handle('error:report', (_event, rec: Partial<ErrorRecord>) => {
      try {
        this.append(rec);
        return { success: true };
      } catch (e) {
        // 台账自身绝不能让渲染端报错升级成新错误
        return { success: false, error: String(e) };
      }
    });
    ipcMain.handle('error:summary', () => {
      try {
        return { success: true, data: this.getSummary() };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    });
  }

  append(rec: Partial<ErrorRecord>): void {
    this.load();
    const now = Date.now();
    const message = String(rec.message ?? '').slice(0, 300);
    // 同 message 去重(5s 窗口)
    const last = this.lastMessageAt.get(message) ?? 0;
    if (now - last < ErrorLedger.DEDUPE_MS) return;
    this.lastMessageAt.set(message, now);

    const record: ErrorRecord = {
      ts: now,
      kind: String(rec.kind ?? 'unclassified').slice(0, 40),
      message,
      source: String(rec.source ?? 'unknown').slice(0, 40),
      stack: rec.stack ? String(rec.stack).slice(0, 2000) : undefined,
    };
    this.records.push(record);
    if (this.records.length > ErrorLedger.MAX_RECORDS) {
      this.records = this.records.slice(-ErrorLedger.MAX_RECORDS);
    }
    this.counts[record.kind] = (this.counts[record.kind] ?? 0) + 1;
    this.flush();
  }

  /** 台账摘要(给设置页/诊断页未来消费) */
  getSummary(): { total: number; counts: Record<string, number>; recent: ErrorRecord[] } {
    this.load();
    return {
      total: this.records.length,
      counts: { ...this.counts },
      recent: this.records.slice(-20),
    };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
        records?: ErrorRecord[];
        counts?: Record<string, number>;
      };
      this.records = Array.isArray(raw.records) ? raw.records.slice(-ErrorLedger.MAX_RECORDS) : [];
      this.counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
    } catch {
      // 首次运行/文件损坏: 从空台账开始
      this.records = [];
      this.counts = {};
    }
  }

  private flush(): void {
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify({ records: this.records, counts: this.counts }, null, 2),
        'utf8',
      );
    } catch {
      // 写失败(磁盘满/权限)不影响主流程
    }
  }
}
