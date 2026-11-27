/**
 * New World — 失败分类器 (M4-B)
 *
 * 【为什么单独成模块,而不是挂在 SelfLearner 上】
 * 上一版把 classifyFailure 写成 `SelfLearner.classifyFailure` 静态方法,
 * 带来两个问题:
 *   1. **测试耦合** —— 单测常把 SelfLearner 整个 mock 掉,静态方法随之消失,
 *      调用点直接 TypeError。而学习是旁路,不该有能力把主流程带崩。
 *   2. **职责错位** —— 分类失败是纯函数,与"自我学习"这个有状态单例无关。
 *      纯函数该独立成文件:无 Electron 依赖、可穷举测试、零 mock。
 *
 * 【与 electron/agent/ErrorClassifier.ts 的分工】
 * 两个分类器服务两个不同的决策,不是重复:
 *   - ErrorClassifier → "该不该重试?"(传输层语义,含 retryable/hint/retryAfter)
 *   - 本模块          → "这次失败属于哪一类?"(学习层语义,用于统计与聚类)
 * 两者的类目名有意【不同】(timeout vs transient、permission_denied vs permission),
 * 因为合并成一个枚举会让"可重试"与"可归类"两个正交维度互相污染:
 *   - 一个 permission 错误既可能是"不可重试"也可能是"权限类失败" → 都成立
 *   - 一个 timeout 既属于"瞬时可重试"也属于"超时类失败"   → 都成立
 * 强行合并后,学习侧要按可重试性过滤样本,或重试侧要按学习类目分组 ——
 * 都会出现"一半样本对不上"的割裂。故保持两套,但共用同一份【原始错误文本】输入。
 *
 * 【类目设计原则】
 * 1. **低基数** —— 类目数量固定,不含自由文本。自由文本放 message 字段。
 *    (高基数值会让"统计失败类型"退化成"统计失败字符串")
 * 2. **互斥且穷尽** —— 一次失败只归一类,且总有归属(兜底 'unknown')。
 * 3. **对学习有区分度** —— 区分"这次为什么坏"以便归因:
 *    工具选错了(tool_error) vs 工具用错了参数(tool_error) 属同一类,
 *    因为学习侧要回答的是"哪类操作容易坏",不是"错在哪个字面量"。
 */

export type FailureType =
  | 'permission_denied'   // 权限/授权不足 → 需要用户授权或换路径
  | 'timeout'             // 超时 → 慢操作或死等
  | 'not_found'           // 目标不存在(文件/路径/资源)
  | 'tool_error'          // 工具/命令执行失败(非上述子类)
  | 'parse_error'         // 输出解析失败(格式不符预期)
  | 'context_overflow'    // 上下文/长度超限
  | 'rate_limited'        // 限流/配额
  | 'user_cancelled'      // 用户主动取消
  | 'unknown'             // 兜底

export interface ClassifiedFailure {
  /** 失败类目(低基数,可统计) */
  type: FailureType
  /** 原始错误文本 —— 自由文本只放这里,绝不进 type */
  message?: string
}

/**
 * 把一次工具/步骤失败归类。
 *
 * @param error 原始错误文本(可含 Error 对象)
 * @param hint  额外的上下文提示(如步骤描述),用于消歧而不进 type
 */
export function classifyFailure(
  error: string | Error | undefined | null,
  hint?: string,
): ClassifiedFailure {
  const raw = error instanceof Error ? error.message : (error ?? '')
  if (!raw && !hint) return { type: 'unknown' }

  // 归一:小写 + 空格归一,避免 'Permission Denied' / 'permission_denied' 分家
  const lower = raw.toLowerCase().replace(/[_-]+/g, ' ')

  // 顺序有意义:先匹配特异性强的,再匹配泛化的。
  // 反过来会让 'tool' 抢走 'permission' 之类更精确的类目。
  if (/permission denied|forbidden|unauthorized|eacces|eperm|权限|授权|拒绝访问|not permitted/.test(lower)) {
    return { type: 'permission_denied', message: raw || undefined }
  }
  if (/user cancelled|user canceled|aborted by user|用户取消|已取消/.test(lower)) {
    return { type: 'user_cancelled', message: raw || undefined }
  }
  if (/timeout|timed out|etimedout|超时/.test(lower)) {
    return { type: 'timeout', message: raw || undefined }
  }
  if (/rate limit|rate_limit|too many requests|quota exceeded|\b429\b|限流|配额/.test(lower)) {
    return { type: 'rate_limited', message: raw || undefined }
  }
  if (/no such file or directory|not found|enoent|不存在|找不到/.test(lower)) {
    return { type: 'not_found', message: raw || undefined }
  }
  if (/context length|context window|max tokens|maximum context|context overflow|上下文超限/.test(lower)) {
    return { type: 'context_overflow', message: raw || undefined }
  }
  if (/json parse|unexpected token|invalid json|syntax error|parse error|解析失败|格式错/.test(lower)) {
    return { type: 'parse_error', message: raw || undefined }
  }
  if (/tool|工具|command|命令|spawn|exit code|执行失败/.test(lower)) {
    return { type: 'tool_error', message: raw || undefined }
  }
  return { type: 'unknown', message: raw || undefined }
}
