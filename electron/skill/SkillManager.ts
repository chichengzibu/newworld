/**
 * PiPiClaw - 技能目录路径单点
 * ═══════════════════════════════════════════════════════════════
 * 【M3-F 瘦身 —— 本文件曾经是第二个技能存储】
 *
 * 旧实现(232 行)自带一套技能 CRUD:
 *   listSkills / getSkill / saveSkill / deleteSkill / toggleSkill
 *   / executeSkill(stub) / exportSkill / importSkill
 * 外加一个自己的 `skills: Skill[]` 存储(落在 ConfigStore 的 `skills` 键)。
 *
 * 【为什么它是死的】
 * 全仓审计(能力可达性):这套 CRUD **零生产调用方**。
 * 真正在跑的技能系统是:
 *   - `electron/skill/SkillLoader.ts` —— 扫盘(SKILL.md)→ Map → 注入/工具/UI
 *   - 状态(启用/统计)落在 ConfigStore 的 `skills.states`
 * 也就是说项目里有过**两个技能存储**,而只有一个是活的。
 *
 * 【为什么留着它是负担】
 * 读代码的人会问「哪个才是真的?」—— 一个自洽的 CRUD 看起来完全能用,
 * 于是后来者可能往 phantom 存储里写数据,写完发现没有任何东西读它。
 * 静默的空转比缺功能更难查。
 *
 * 【现在只留什么】
 * `getSkillsDir()` —— **路径单点**。全仓三个模块(SkillLoader / AutoCreator /
 * SelfLearner)都用它拼技能目录,自己 join(userData,'skills') 就是路径双源
 * (项目历史上踩过同一个坑:写 `appPath/../skills`、读 `userData/skills`)。
 *
 * 【技能的真实存储在哪 —— 别再找了】
 *   技能正文:文件系统 `<skillsDir>/<skillId>/SKILL.md`
 *   技能状态:ConfigStore `skills.states`
 *   技能内容接口:SkillLoader(加载/注入/工具/UI)
 */
import * as fs from 'fs';
import { getHost } from '../platform/runtime'
import * as path from 'path';

export class SkillManager {
  /**
   * W7.0.4: 路径单点 —— 其它模块应使用这个,而非自己 join(userData, 'skills')。
   *
   * 【为什么是单点】历史上踩过同一个坑:技能**写**到 `appPath/../skills`
   * (安装目录的兄弟目录,Windows 打包后在 Program Files → 只读),
   * **读** `userData/skills` —— 两个不同路径,导致保存的技能永远扫不到。
   */
  public static getSkillsDir(): string {
    const userDataPath = getHost().getPath('userData');
    const dir = path.join(userDataPath, 'skills');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
}
