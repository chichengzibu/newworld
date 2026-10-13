/**
 * PiPiClaw - RunCheckpointManager (#004 设计稿 A1-A3 落实)
 *
 * run 层 checkpoint:把 LlmAgentBrain 一次 run 的 {messages(含轮内工具结果), tool_state,
 * iteration, status} 以 **append-only 事件流** 落盘,供崩溃/中止后恢复续跑。
 *
 * 纪律(逐条对应裁决):
 *  - A1 纯函数:无单例 / 无模块态 / 无路径内省 —— 全部函数接收 dir(绝对路径字符串)
 *    或事件数组;dir 由调用方(W5 接线时的 ChatManager / 测试)拼装。
 *    依赖方向单向:本文件 import type brain 的事件类型;LlmAgentBrain 【不】 import 本文件。
 *  - A2 append-only:只追加、永不重写/删除/修改已有行;快照的"最新态"由读取侧推导
 *    (取最后一条 run.snapshot 行)。恢复原子性 = 单次 append 落一行(Win/Posix 单次
 *    append 对小行足够;损坏行在读取侧跳过并计数,不静默)。
 *  - A3 惰性 sweep:不做启动清扫。本 run 的第一条 checkpoint 事件到达时,才把"其它
 *    runId 且仍 running 且未被标记"的旧快照各追加一行 interrupted 标记(append,不改旧行)。
 *  - 目录避撞(A 裁决):旧三件套(W5 清理, DEV-024)占 userData/checkpoints/;
 *    本 manager 用 userData/run-checkpoints/ —— 两个时代不共目录。
 *  - 冻结:main.ts / IpcServer / commandDecide / BashTool 零接触;恢复后 confirm 门
 *    仍经既有 execCommand 咽喉(本文件不触碰任何确认/审计逻辑, DEV-023 残留见台账)。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RunCheckpointEvent, RunSnapshotPayload } from './LlmAgentBrain'

/** 约定目录名(相对 userData / 测试 tmp 根)——不占用旧 'checkpoints' 目录 */
export const RUN_CHECKPOINTS_DIRNAME = 'run-checkpoints'

export function resolveCheckpointDir(baseDir: string): string {
  return path.join(baseDir, RUN_CHECKPOINTS_DIRNAME)
}

/** 读取整个事件流(append-only 行)。损坏 JSON 行跳过,返回 { events, skippedCorrupt }。 */
export function readEvents(dir: string): { events: RunCheckpointEvent[]; skippedCorrupt: number } {
  const file = path.join(dir, 'events.jsonl')
  if (!fs.existsSync(file)) return { events: [], skippedCorrupt: 0 }
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '')
  const events: RunCheckpointEvent[] = []
  let skippedCorrupt = 0
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as RunCheckpointEvent
      if (ev && (ev.type === 'run.snapshot' || ev.type === 'run.status')) events.push(ev)
      else skippedCorrupt++
    } catch {
      skippedCorrupt++
    }
  }
  return { events, skippedCorrupt }
}

/** 追加一行事件(唯一写路径 —— append-only, A2) */
export function appendEvent(dir: string, ev: RunCheckpointEvent): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(ev) + '\n', 'utf8')
}

/** 纯函数:取某 run 最后一条 snapshot 行(= 最新快照) */
export function latestSnapshot(events: RunCheckpointEvent[], runId?: string): RunSnapshotPayload | null {
  let found: RunSnapshotPayload | null = null
  for (const ev of events) {
    if (ev.type !== 'run.snapshot') continue
    if (runId && ev.runId !== runId) continue
    found = {
      runId: ev.runId,
      conversationId: ev.conversationId,
      status: ev.status,
      iteration: ev.iteration,
      messages: ev.messages,
      toolState: ev.toolState,
    }
  }
  return found
}

/** 纯函数:推导某 run 的最终状态 —— 最后一条 run.status 行;无则取快照行(= running) */
export function deriveStatus(events: RunCheckpointEvent[], runId: string): 'running' | 'interrupted' | 'finalized' | null {
  let status: 'running' | 'interrupted' | 'finalized' | null = null
  for (const ev of events) {
    if (ev.runId !== runId) continue
    if (ev.type === 'run.status') status = ev.status
    else status = 'running'
  }
  return status
}

/**
 * 纯函数(A3 决策):找出"其它 runId + 仍 running + 尚无 interrupted 标记"的旧快照 runId 集合。
 * 返回需要追加 marked 的 runId 列表(决策,不写盘)——让写入与决策可独立测试。
 */
export function findSweepTargets(
  events: RunCheckpointEvent[],
  currentRunId: string,
): string[] {
  const running = new Set<string>()
  const interrupted = new Set<string>()
  for (const ev of events) {
    if (ev.runId === currentRunId) continue
    if (ev.type === 'run.snapshot') running.add(ev.runId)
    else if (ev.type === 'run.status' && ev.status === 'interrupted') interrupted.add(ev.runId)
  }
  const targets: string[] = []
  for (const id of running) {
    if (!interrupted.has(id)) targets.push(id)
  }
  return targets.sort()
}

/**
 * A3 惰性 sweep + 追加:本 run 第一条 checkpoint 事件到达时触发。
 * ① 找出旧 running 未标记的 runId,各 append 一行 { type:'run.status', status:'interrupted' }
 * ② append 本事件。
 * 全程 append-only:旧行字节级不动(测试断言)。
 * 返回 { swept: 被标记的 runId[], }
 */
export function lazyCheckpoint(
  dir: string,
  ev: RunCheckpointEvent,
  currentRunId: string,
): { swept: string[] } {
  const { events } = readEvents(dir)
  const targets = findSweepTargets(events, currentRunId)
  for (const oldRunId of targets) {
    appendEvent(dir, {
      type: 'run.status',
      runId: oldRunId,
      conversationId: ev.conversationId,
      status: 'interrupted',
      reason: 'swept-by-lazy',
    })
  }
  appendEvent(dir, ev)
  return { swept: targets }
}

/** 恢复入口(纯读):取某 run 的最新快照 + 推导状态;无快照返回 null */
export function collectForRestore(
  dir: string,
  runId: string,
): { snapshot: RunSnapshotPayload; status: 'running' | 'interrupted' | 'finalized' | null } | null {
  const { events } = readEvents(dir)
  const snapshot = latestSnapshot(events, runId)
  if (!snapshot) return null
  return { snapshot, status: deriveStatus(events, runId) }
}
