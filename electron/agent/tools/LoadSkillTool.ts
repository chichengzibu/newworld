/**
 * New World - load_skill 工具 (M4-A)
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
    '不要凭猜测执行技能步骤 —— 先加载,再照着做。' +
    '【M4-W】判断相关性**优先于**动手:相关就**第一步**加载,别先去找文件;' +
    'skill_id 用清单里给出的那个(不是技能展示名)。',
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
    ctx?: RuntimeToolContext,
  ): Promise<ToolExecResult> {
    const skillId = typeof args.skill_id === 'string' ? args.skill_id.trim() : ''
    if (!skillId) {
      return { ok: false, result: '', error: '缺少参数 skill_id' }
    }
    /**
     * 【M4-E】对照实验的抑制检查。
     *
     * 「这个技能有没有用」要靠**配对对照**回答:同一个任务跑两遍,
     * 一遍允许用它、一遍禁止用。若不禁止,模型照样会调 load_skill ——
     * 对照组就废了,测出来的差值恒为 0(两个变体其实一样)。
     *
     * 拒绝时要说清原因:模型需要知道「这个技能不可用」而不是「工具坏了」,
     * 否则它会反复重试或改走别的路径,把对照做脏。
     *
     * 【M4-W】**必须同时按规范 id 与原样参数比对**。
     * 此前只比对传入的 skill_id;而模型可能传的是**展示名**
     * (摘要里两者都有)—— 那时抑制就漏了,对照组照样能加载到技能,
     * 整个对照实验的差值会被做成 0。故这里把两个键都比。
     */
    const loader = SkillLoader.getInstance()
    const canonicalId = loader.resolveCanonicalSkillId(skillId)
    const suppressed = ctx?.suppressedSkills ?? []
    if (suppressed.includes(skillId) || (canonicalId && suppressed.includes(canonicalId))) {
      return {
        ok: false,
        result: '',
        error: `技能 "${canonicalId ?? skillId}" 在本次运行中被禁用(对照实验分组),请直接完成任务`,
      }
    }
    try {
      const body = loader.getSkillBody(skillId)
      // 技能不存在时 getSkillBody 返回的是提示文案而非正文 —— 明确标为失败,
      // 让模型知道要换个 id 重试,而不是把提示当成技能内容照做。
      if (body.startsWith('技能 "') && body.includes('不存在')) {
        this.log.warn(`LoadSkillTool: 技能不存在 ${skillId}`)
        return { ok: false, result: '', error: body }
      }
      // 【M4-W】解析成**规范 id** —— 模型可能传的是展示名。
      // 学习闭环记的必须是真实 id,否则效用统计会按一个对不上的名字聚合。
      const appliedId = canonicalId ?? skillId
      this.log.info(`LoadSkillTool: 已加载技能 ${appliedId}`)
      // 【M4-D】声明本次作用在哪个技能上 —— 学习闭环据此记录
      // 「技能 S 被应用了」,这是技能级效用信号的前提。
      return { ok: true, result: body, appliedEntity: { kind: 'skill', id: appliedId } }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log.warn(`LoadSkillTool: 加载失败 ${skillId} — ${msg}`)
      return { ok: false, result: '', error: msg }
    }
  }
}
