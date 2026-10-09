/**
 * PiPiClaw - 日志管理器
 * 
 * 职责：
 * 1. 统一日志输出（控制台+文件）
 * 2. 日志级别管理
 * 3. 日志文件轮转
 */

import log from 'electron-log';
import { app } from 'electron';
import { getHost } from '../platform/runtime'

// getHost() 在 initHost() 之前可能尚未注入(本模块顶层即实例化 Logger)。
// 统一兜底到 electron app,避免应用启动极早期抛 "PlatformHost 尚未初始化"。
function safeUserData(): string {
  try {
    return getHost().getPath('userData');
  } catch {
    /* host 未就绪,fallback 到 app */
  }
  try {
    return app.getPath('userData');
  } catch {
    /* app 未 ready(极早期),再 fallback 到环境变量 */
  }
  return process.env.APPDATA || process.env.USERPROFILE || process.cwd();
}

function safeIsPackaged(): boolean {
  try {
    return getHost().isPackaged();
  } catch {
    /* host 未就绪,fallback 到 app */
  }
  try {
    return app.isPackaged;
  } catch {
    return true;
  }
}

import { join } from 'path';
import { execSync } from 'child_process';
import type { LogMessage } from 'electron-log';

export class LogManager {
  private static instance: LogManager;

  private constructor() {
    this.initializeLogger();
  }

  public static getInstance(): LogManager {
    if (!LogManager.instance) {
      LogManager.instance = new LogManager();
    }
    return LogManager.instance;
  }

  private initializeLogger(): void {
    // Windows 平台设置控制台 UTF-8 编码
    if (process.platform === 'win32') {
      try {
        execSync('chcp 65001', { stdio: 'ignore' });
      } catch {}
    }

    const userDataPath = safeUserData();
    const logPath = join(userDataPath, 'logs');

    log.transports.file.resolvePathFn = () => join(logPath, 'pipiclaw.log');
    log.transports.file.maxSize = 5 * 1024 * 1024;
    log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
    log.transports.console.format = '[{h}:{i}:{s}] [{level}] {text}';

    // Windows 控制台使用自定义 writeFn，解决中文乱码
    if (process.platform === 'win32') {
      log.transports.console.writeFn = (options: { message: LogMessage }) => {
        const msg = options.message;
        const time = msg.date;
        const pad = (n: number, len = 2) => String(n).padStart(len, '0');
        
        const formatted = `[${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}] [${msg.level}] ${msg.data.map((a: any) => 
          typeof a === 'object' ? JSON.stringify(a) : String(a)
        ).join(' ')}`;
        
        process.stdout.write(formatted + '\n');
      };
    }

    if (!safeIsPackaged()) {
      log.transports.file.level = 'debug';
      log.transports.console.level = 'debug';
    } else {
      log.transports.file.level = 'info';
      log.transports.console.level = 'info';
    }
  }

  public debug(message: string, ...args: any[]): void {
    log.debug(message, ...args);
  }

  public info(message: string, ...args: any[]): void {
    log.info(message, ...args);
  }

  public warn(message: string, ...args: any[]): void {
    log.warn(message, ...args);
  }

  public error(message: string, ...args: any[]): void {
    log.error(message, ...args);
  }

  public getLogPath(): string {
    return join(safeUserData(), 'logs');
  }
}

export const logger = LogManager.getInstance();
