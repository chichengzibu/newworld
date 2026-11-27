/**
 * New World - Agent tools 索引 (M1 v0.1)
 *
 * 5 工具对齐 ClaudeCode: Read / Edit / Bash / Glob / Grep.
 * 导出: 5 个 class + 5 个 metadata + 通用 ToolExecResult / PiPiTool / Tool 接口.
 */
export { ReadTool, ReadToolMetadata } from './ReadTool'
export { EditTool, EditToolMetadata } from './EditTool'
export { BashTool, BashToolMetadata } from './BashTool'
export { GlobTool, GlobToolMetadata } from './GlobTool'
export { GrepTool, GrepToolMetadata } from './GrepTool'
export { LoadSkillTool, LoadSkillToolMetadata } from './LoadSkillTool'
export { ParallelSubtasksTool, ParallelSubtasksToolMetadata } from './ParallelSubtasksTool'
export { CreateArtifactTool, CreateArtifactToolMetadata } from './CreateArtifactTool'
export { WebSearchTool } from './WebSearchTool'
export type { PiPiTool, ToolExecResult, ProducedArtifact } from './Tool'

import { ReadTool } from './ReadTool'
import { EditTool } from './EditTool'
import { BashTool } from './BashTool'
import { GlobTool } from './GlobTool'
import { GrepTool } from './GrepTool'
import { LoadSkillTool } from './LoadSkillTool'
import { ParallelSubtasksTool } from './ParallelSubtasksTool'
import { CreateArtifactTool } from './CreateArtifactTool'
import { WebSearchTool } from './WebSearchTool'
import type { PiPiTool } from './Tool'

/** 内置工具实例数组 — LlmAgentBrain / ToolRegistry 用
 *  (M4-A: load_skill 渐进披露; P3: parallel_subtasks 多 agent 编排入口;
 *   P3-补短: create_artifact 真 docx/xlsx/pptx 成品交付;
 *   v4.8: web_search 联网搜索 —— 由开关决定是否进入本次 run 的白名单) */
export const BUILTIN_TOOLS: PiPiTool[] = [
  new ReadTool(),
  new EditTool(),
  new BashTool(),
  new GlobTool(),
  new GrepTool(),
  new LoadSkillTool(),
  new ParallelSubtasksTool(),
  new CreateArtifactTool(),
  new WebSearchTool(),
]

/** 把 PiPiTool 列表转成 OpenAI-style LlmTool[] (LlmClient.chat.tools 字段用) */
export function toolsToLlmSchema(tools: PiPiTool[]): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.metadata.name,
      description: t.metadata.description,
      parameters: t.metadata.parametersJson,
    },
  }))
}
