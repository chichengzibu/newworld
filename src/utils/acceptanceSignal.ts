/**
 * New World — 用户接受度信号识别（M4-F）
 * ═══════════════════════════════════════════════════════════════
 * 【要解决什么】
 * M4-E 的评分器用「工具调用全成功 + 有最终答复」当成功信号 —— 那是**过程**指标，
 * 不是**用户是否满意**的指标。
 *
 * 用户对一条答复的真实反应才是硬信号。渲染层能采集到的有三种：
 *   ① 用户点了「重新生成」 → 明确不要上一条答复（最强的负面信号）
 *   ② 用户的**下一条消息**以纠正词开头 → 不满意
 *   ③ 用户的**下一条消息**以认可词开头 → 满意
 *
 * 【为什么只认「开头」的词】
 * 「不是」「不对」这类词在正常任务描述里也常见：
 *   「把**不是**苹果的挑出来」「**不对**称的那些别动」
 * 若全文匹配,会把大量正常后续指令误判成「不满意」——
 * 而误判的代价是**让效用统计偏悲观**,比没有统计更糟。
 * 故只认**句首**的标记词(用户抱怨时通常第一句就在说)。
 *
 * 【没命中怎么办】什么都不报。
 * 「用户没再说话」不等于满意(可能只是走开了)→ 保持 unknown,不猜。
 * 业界对 LLM 裁判也是同样的态度:不确定就不给结论。
 */

export type AcceptanceVerdict = 'accepted' | 'rejected' | 'unknown'

/**
 * 纠正/否定标记 —— 句首匹配。
 * 涵盖中英文;注意「重新」只在句首才算(「重新生成」是用户主动换答案)。
 */
const REJECT_MARKERS: string[] = [
  '不对', '错了', '不是', '不对劲', '有问题', '反了', '搞错',
  '重来', '重做', '再来一次', '再试一次', '换一个',
  'wrong', 'incorrect', 'redo', 'try again', 'not right', 'no,', 'nope',
]

/**
 * 认可标记 —— 句首匹配。
 */
const ACCEPT_MARKERS: string[] = [
  '好了', '可以了', '没问题', '完成了', '搞定', '谢谢', '不错', '很好', '正是', '对了', '完美', '可以',
  'done', 'thanks', 'perfect', 'great', 'works', 'nice', 'good',
]

/** 句首匹配(允许前导标点与空白) */
function startsWithMarker(text: string, markers: string[]): string | undefined {
  const t = text.trim().replace(/^[，。！？、,.!?;；:\s]+/, '').toLowerCase()
  for (const m of markers) {
    if (t.startsWith(m.toLowerCase())) return m
  }
  return undefined
}

/**
 * 从用户的下一条消息里判断对上一条答复的态度。
 *
 * @param text 用户的下一条消息
 * @returns 判定 + 依据(依据会写进日志,便于事后核对)
 */
export function classifyAcceptance(text: string): { verdict: AcceptanceVerdict; reason?: string } {
  if (!text || !text.trim()) return { verdict: 'unknown' }

  const rej = startsWithMarker(text, REJECT_MARKERS)
  if (rej) {
    return { verdict: 'rejected', reason: `下一条消息以纠正词「${rej}」开头` }
  }

  const acc = startsWithMarker(text, ACCEPT_MARKERS)
  if (acc) {
    return { verdict: 'accepted', reason: `下一条消息以认可词「${acc}」开头` }
  }

  return { verdict: 'unknown' }
}

/** 用户点了「重新生成」→ 明确不要上一条答复 */
export function rejectionByRegenerate(): { verdict: AcceptanceVerdict; reason: string } {
  return { verdict: 'rejected', reason: '用户点击了「重新生成」' }
}
