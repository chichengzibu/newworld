/**
 * PiPiClaw - load_skill 工具 (M4-A)
 *
 * 【为什么需要这个工具】
 * Anthropic Agent Skills 的渐进披露模型:
 *   L1  name + description —— 常驻上下文(约 100 token/技能)
 *   L2  技能正文          —— 仅在触发时加载
 *   L3  references/scripts —— 按需 Read/Bash
 *
 * 模型看到 L1 摘要后,自己判断"这个技能相关",然后调 load_skill 拿 L2 正文。
 * 这正是 Claude Code 的做法 —— 匹配决策交给模型,它比关键词更懂用户意图。
 *
 * 【与旧实现的关键差异】
 * 旧路径在【代码里】做匹配(SkillLoader.getSkillContext):
 *   - 技能 >5 个时对每个技能【串行发一次 LLM 调用】→ N 次网络往返
 *   - 且传入的 triggerCondition 恒为 undefined,拿字符串"无"作对照
 * 现在匹配交给模型一次判断 + 按需加载,既省往返又更准。
 *
 * 【安全】
 * 读技能正文是只读操作 → auto 放行。技能正文来自本地磁盘,
 * 不含可执行副作用(脚本需经 BashTool 单独走权限门)。
 */
import { LogManager } from '../../core/LogManager'
import { SkillLoader } from '../../skill/SkillLoader'
import type { PiPiTool, ToolExecResult, RuntimeToolContext } from './Tool'

export const LoadSkillToolMetadata = {
  name: 'load_skill',
  description:
    '加载某个技能的完整操作说明。当用户的需求与某个可用技能相关时调用它,' +
    '以获取该技能的具体步骤与约束。当前可用技能见系统提示中的"可用技能"清单。' +
    '不要凭猜测执行技能步骤 —— 先加载,再照着做。',
  parametersJson: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: '要加载的技能 id(取自系统提示里的可用技能清单)',
      },
    },
    required: ['skill_id'],
  },
  requiresPermission: false,
  domain: 'skill',
}

export class LoadSkillTool implements PiPiTool {
  metadata = LoadSkillToolMetadata
  private log = LogManager.getInstance()

  async execute(
    args: Record<string, unknown>,
    _ctx?: RuntimeToolContext,
  ): Promise<ToolExecResult> {
    const skillId = typeof args.skill_id === 'string' ? args.skill_id.trim() : ''
    if (!skillId) {
      return { ok: false, result: '', error: '缺少参数 skill_id' }
    }
    try {
      const body = SkillLoader.getInstance().getSkillBody(skillId)
      // 技能不存在时 getSkillBody 返回的是提示文案而非正文 —— 明确标为失败,
      // 让模型知道要换个 id 重试,而不是把提示当成技能内容照做。
      if (body.startsWith('技能 "') && body.includes('不存在')) {
        this.log.warn(`LoadSkillTool: 技能不存在 ${skillId}`)
        return { ok: false, result: '', error: body }
      }
      this.log.info(`LoadSkillTool: 已加载技能 ${skillId}`)
      return { ok: true, result: body }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log.warn(`LoadSkillTool: 加载失败 ${skillId} — ${msg}`)
      return { ok: false, result: '', error: msg }
    }
  }
}
