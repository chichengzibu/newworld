/**
 * PiPiClaw - Windows Job Object L1 隔离(占位,W9.2)
 *
 * 真实实现路径:win32job npm 库 + JobObject + UiFlags
 * W9 阶段:plan 明确"留占位",仅接口定义 + isAvailable 检测 + runWithWindowsJob 返回 stub
 */

import { LogManager } from '../../core/LogManager'
import * as os from 'node:os'

/**
 * WindowsJobConfig:Windows Job Object 参数(W9 占位)
 * - cpuLimit:CPU 限制(0-100)
 * - memoryMb:内存限制(MB)
 * - allowChildProcesses:是否允许子进程派生
 */
export interface WindowsJobConfig {
  /** CPU 限制(0-100) */
  cpuLimit?: number
  /** 内存限制(MB) */
  memoryMb?: number
  /** 子进程派生 */
  allowChildProcesses?: boolean
}

export interface WindowsJobResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  fallback: boolean
}

export function isWindowsJobAvailable(): boolean {
  return os.platform() === 'win32'
}

export function runWithWindowsJob(command: string[], _config: WindowsJobConfig = {}): WindowsJobResult {
  const log = LogManager.getInstance()
  const startMs = Date.now()
  log.warn('WindowsJob: W9 stub, Windows 平台 W9 暂不实装, W10+ 评估; 命令未执行')
  // 这是 W9 占位 stub,Job Object 隔离并未真正实现。
  // 绝不能返回 ok:true —— 否则调用方会把"未执行"误判为"执行成功"(假阳性)。
  // capability() 已把 windows-job 标记为 available:false,这里保持一致返回 ok:false。
  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: 'Windows Job Object W9 stub — 未实现,命令未执行',
    durationMs: Date.now() - startMs,
    fallback: true,
  }
}