/**
 * PiPiClaw - 技能目录路径单点
 * ═══════════════════════════════════════════════════════════════════════
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
 *   - 状态(启用/统计)落在 ConfigStore `skills.states`
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
 *
 * ─────────────────────────────────────────────────────────────────
 * 【M4-X 技能包存储位置】
 *
 * 用户要求:「技能包存储位置添加为**应用本身结构目录**的 skills 下面」。
 * 于是技能目录从 `<userData>/skills` 改到**应用自身目录**下的 `skills`:
 *   - 开发态:`<appPath>/skills`(= 仓库根的 skills/ —— 正好是原来放样例技能的地方)
 *   - 打包后:`<install>/skills`(app.asar 在 `<install>/resources/` 下,取其上两级)
 *
 * 【但必须守住一条:读写同源】
 * 本文件的历史注释写得很清楚 —— 曾经**写** `appPath/../skills`、**读**
 * `userData/skills`,两个不同路径,导致「保存的技能永远扫不到」。
 * 这次改路径,最怕的就是改出一模一样的岔路。故:
 *   ① 选中的目录**落盘记住**(ConfigStore `skills.dir`),一旦定了就不再变
 *   ② 读与写都走这一个函数 —— 没有第二个拼路径的地方
 *   ③ 选之前**实测可写**(真写一个探针文件),不可写就落到 userData
 *      (装到 Program Files 这类只读位置时,否则用户下载的技能会静默丢失)
 */
import * as fs from 'fs';
import { getHost } from '../platform/runtime'
import * as path from 'path';
import { ConfigStore } from '../core/ConfigStore';

/** 选定的技能目录 —— 记住它,别每次重算(重算可能得出不同答案) */
const SKILLS_DIR_KEY = 'skills.dir';

export interface SkillsDirInfo {
  /** 最终选定的技能目录 */
  path: string;
  /** 是否可写(不可写时所有下载/导入都会失败) */
  writable: boolean;
  /** 人话说明 —— 界面上要如实展示,别让人猜技能去哪了 */
  reason: string;
  /** 候选目录(按优先级)—— 排查时用 */
  candidates: string[];
}

export class SkillManager {
  /**
   * W7.0.4: 路径单点 —— 其它模块应使用这个,而非自己 join(userData, 'skills')。
   *
   * 【为什么是单点】历史上踩过同一个坑:技能**写**到 `appPath/../skills`
   * (安装目录的兄弟目录,Windows 打包后在 Program Files → 只读),
   * **读** `userData/skills` —— 两个不同路径,导致保存的技能永远扫不到。
   *
   * 【M4-X】目录改为**应用自身结构目录**下的 `skills`;不可写时落回 userData。
   * 详见 `getSkillsDirInfo()`。
   */
  public static getSkillsDir(): string {
    return SkillManager.getSkillsDirInfo().path;
  }

  /**
   * 解析技能目录,并说明**为什么是它**。
   *
   * 【为什么要有 reason】
   * 技能目录会因安装位置而变(装到只读位置就落回 userData)。
   * 用户看到"技能保存在哪"时,界面必须能说清是哪一个、为什么 ——
   * 否则同一个应用在不同机器上技能"凭空不见了",没人知道去哪找。
   */
  public static getSkillsDirInfo(): SkillsDirInfo {
    const candidates = SkillManager.getCandidates();
    const remembered = SkillManager.readRemembered();

    // ① 之前定过 → 优先沿用(保证"装好的技能还在原地")
    if (remembered) {
      const stillThere = SkillManager.ensureDir(remembered);
      if (stillThere) {
        return {
          path: remembered,
          writable: SkillManager.probeWritable(remembered),
          reason: SkillManager.isUnder(remembered, getHost().getPath('userData'))
            ? '用户数据目录(应用结构目录不可写时的落点)'
            : '应用自身目录下的 skills',
          candidates,
        };
      }
    }

    // ② 首次:按优先级挑第一个**可写**的
    for (const c of candidates) {
      if (!SkillManager.ensureDir(c)) continue;
      if (!SkillManager.probeWritable(c)) continue;
      SkillManager.remember(c);
      return {
        path: c,
        writable: true,
        reason: SkillManager.isUnder(c, getHost().getPath('userData'))
          ? '用户数据目录(应用结构目录不可写时的落点)'
          : '应用自身目录下的 skills',
        candidates,
      };
    }

    // ③ 都不行 → userData(至少能建目录)
    const fallback = path.join(getHost().getPath('userData'), 'skills');
    SkillManager.ensureDir(fallback);
    return {
      path: fallback,
      writable: SkillManager.probeWritable(fallback),
      reason: '用户数据目录(应用结构目录不可写)',
      candidates,
    };
  }

  /**
   * 候选目录(按优先级)。
   *
   * - 开发态:`<appPath>/skills` —— 实测 dev 下 electron 以 `"."` 启动
   *   (vite-plugin-electron 的 `startup(['.', '--no-sandbox'])`),故 appPath 就是**仓库根**,
   *   `<repo>/skills` 正是"应用自身结构目录下的 skills"。
   * - 打包后:`<dirname(appPath)>/skills` —— appPath 是 `<install>/resources/app.asar`,
   *   取其父目录即 `<install>/resources/skills`;NSIS 默认装到 `%LOCALAPPDATA%\Programs\` → 可写。
   *   (app.asar **内部**不可写,所以不能直接用 `<appPath>/skills`。)
   * - 兜底:`<userData>/skills` —— 只读安装位置(Program Files)时的落点
   */
  private static getCandidates(): string[] {
    const out: string[] = [];
    const appPath = getHost().getAppPath();
    try {
      if (getHost().isPackaged()) {
        // <install>/resources/app.asar → <install>/resources/skills
        out.push(path.join(path.dirname(appPath), 'skills'));
        // 再退一级:<install>/skills
        out.push(path.resolve(path.dirname(appPath), '..', 'skills'));
      } else {
        // 开发态:appPath = 仓库根 → <repo>/skills
        out.push(path.join(appPath, 'skills'));
      }
    } catch {
      // 取不到 appPath(如某些宿主)→ 跳过这一档
    }
    out.push(path.join(getHost().getPath('userData'), 'skills'));
    return [...new Set(out)];
  }

  /** 建目录 —— 失败返回 false(不抛:不可写是**正常**情形,不是异常) */
  private static ensureDir(dir: string): boolean {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  }

  /**
   * 实测可写 —— **真写一个探针文件**,不靠猜。
   *
   * 【为什么必须真写】目录权限可能与父目录不同(继承被显式收紧),
   * existsSync 说存在不代表写得进去。装到 Program Files 时就是这种情形。
   */
  private static probeWritable(dir: string): boolean {
    const probe = path.join(dir, '.write-probe');
    try {
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  private static isUnder(child: string, parent: string): boolean {
    try {
      const c = path.resolve(child).toLowerCase();
      const p = path.resolve(parent).toLowerCase();
      return c === p || c.startsWith(p + path.sep);
    } catch {
      return false;
    }
  }

  private static readRemembered(): string | null {
    try {
      const v = ConfigStore.getInstance().get(SKILLS_DIR_KEY);
      return typeof v === 'string' && v.trim() ? v : null;
    } catch {
      return null;
    }
  }

  private static remember(dir: string): void {
    try {
      ConfigStore.getInstance().set(SKILLS_DIR_KEY, dir);
    } catch {
      // 记不住就记不住 —— 下次重算也还是同一个(可写性不会变)
    }
  }
}
