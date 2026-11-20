/**
 * PiPiClaw — 旧管道对齐 D8（M4-AA）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * D8：「技能由 **AI 自行判断**选用 —— 代码里不做关键词/相似度匹配替 AI 决定」。
 *
 * 旧管道（无 tool loop 时的回退路径）此前**两处违反**这条决策：
 *   ① `getSkillContext()` 在 >5 个技能时**额外发一次 LLM 调用**去排序，
 *      失败再降级为**关键词匹配**，取前 3 名注入
 *   ② `InstructionGenerator` 把技能清单**注入两遍**（一份含禁用技能、一份不含），
 *      并把追加段称作「检测到匹配的技能」—— 而"匹配"是代码做的，不是模型做的
 *
 * 现在：**不做任何选择**。要么把全部摆出来（正文在预算内），要么只给清单并
 * **如实说明**这条路径拿不到全文 —— 不挑、不假装。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TEST_USER_DATA } from './test-host';

const SKILLS_DIR = path.join(TEST_USER_DATA, 'skills');

/** 写一个技能；bodyChars 控制正文长度（用于预算测试） */
function writeSkill(id: string, opts: { name?: string; bodyChars?: number } = {}): void {
  const dir = path.join(SKILLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const body = `【${id}-正文标记】` + 'x'.repeat(Math.max(0, (opts.bodyChars ?? 100) - 10));
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${opts.name ?? id}`, `description: ${id} 的描述`, '---', '', '## 操作步骤', body, ''].join('\n'),
    'utf-8',
  );
}

async function freshLoader(): Promise<any> {
  const { SkillLoader } = await import('../../electron/skill/SkillLoader');
  (SkillLoader as any).instance = null;
  const loader = SkillLoader.getInstance() as any;
  loader.skillsDir = SKILLS_DIR;
  loader.reloadSkills();
  return loader;
}

describe('M4-AA 旧管道：技能不做代码侧选择（D8）', () => {
  beforeEach(() => {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  });

  it('正文在预算内 → 全量给出（清单 + 每个技能的正文），不做挑选', async () => {
    writeSkill('a', { bodyChars: 200 });
    writeSkill('b', { bodyChars: 200 });
    writeSkill('c', { bodyChars: 200 });
    const loader = await freshLoader();

    const ctx = await loader.getSkillContext('随便什么任务');
    expect(ctx).toContain('a 的描述');
    expect(ctx).toContain('b 的描述');
    expect(ctx).toContain('c 的描述');
    // 三个技能的正文都在 —— 不是"挑了前 3 个"，而是**没有挑**
    expect(ctx).toContain('a-正文标记');
    expect(ctx).toContain('b-正文标记');
    expect(ctx).toContain('c-正文标记');
  });

  it('正文超预算 → 只给清单，并**如实说明**拿不到全文（不偷偷挑几个）', async () => {
    writeSkill('huge1', { bodyChars: 9000 });
    writeSkill('huge2', { bodyChars: 9000 });
    const loader = await freshLoader();

    const ctx = await loader.getSkillContext('随便什么任务');
    // 清单在
    expect(ctx).toContain('huge1 的描述');
    expect(ctx).toContain('huge2 的描述');
    // 正文一个都不给 —— 尤其不能"挑一个塞进去"
    expect(ctx).not.toContain('huge1-正文标记');
    expect(ctx).not.toContain('huge2-正文标记');
    // 必须说清楚为什么、以及该怎么办
    expect(ctx).toContain('注入预算');
    expect(ctx).toContain('没有工具循环');
  });

  it('【回归】不再有任何代码侧排序器（LLM 排序 / 关键词降级都已删除）', async () => {
    const { SkillLoader: L } = await import('../../electron/skill/SkillLoader');
    const { SelfLearner: S } = await import('../../electron/learning/SelfLearner');
    // 这两个方法就是"替 AI 选"的实现 —— 删掉才是真的对齐 D8
    expect((L as any).prototype.rankSkillsOnce).toBeUndefined();
    expect((S as any).prototype.rankSkillsByRelevance).toBeUndefined();
  });

  it('禁用的技能不出现在清单里（模型不该看到用户明确关掉的技能）', async () => {
    writeSkill('keeplive');
    writeSkill('throwaway');
    const loader = await freshLoader();
    loader.toggleSkill('throwaway', false);

    const all = loader.getAllSkillSummaries();
    expect(all).toContain('keeplive');
    expect(all).not.toContain('throwaway');

    const ctx = await loader.getSkillContext('任务');
    expect(ctx).not.toContain('throwaway');
  });

  it('【回归】InstructionGenerator 不再注入第二份清单、也不声称"检测到匹配的技能"', async () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../electron/task/InstructionGenerator.ts'),
      'utf-8',
    );
    // 重复注入:这个变量就是第二份清单的来源
    expect(src).not.toContain('const skillSummaries = this.skillLoader.getAllSkillSummaries()');
    expect(src).not.toContain('${skillSummaries}');
    // 措辞:不能把"代码匹配过的结果"说成"检测到匹配的技能"
    expect(src).not.toContain('【检测到匹配的技能】');   // 提示词里的旧标题（注释里提到它不算）
    // 改成由模型判断
    expect(src).toContain('先判断用户需求是否与某个技能相关');
  });
});
