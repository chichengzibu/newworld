/**
 * New World — 构建脚本的可测核心（M4-Z）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么要把这几段抽出来】
 * `scripts/build.mjs` 是**顶层直接执行**的脚本 —— 无法 import、无法单测。
 * 而它里面恰好藏着两个真实缺陷:
 *   ① 子进程输出用 `stdio:'inherit'` → 不落盘,门禁红时没有证据
 *   ② `timedOut` 在 `close` 回调里被写死成 `false` → 超时永远报不出来
 * 这两条都属于"出事了才知道它坏了"的类型 —— 不钉成用例,下次还会坏。
 *
 * 故把**纯逻辑**抽到这里,build.mjs 只负责编排与提示文案。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 同步 sleep —— 只用于"移走旧产物"的重试 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 构建前用 rename 移走旧产物（rename 不走 safe-delete 拦截的 rm 路径）。
 *
 * 【M4-Z】不再静默吞错:
 * - 先**重试**（默认 4 次,间隔递增）—— 杀毒扫描刚生成的大文件时,锁往往是瞬时的
 * - 仍失败 → 返回 `{ok:false, error}`，**由调用方快速中止**
 *
 * 为什么不能"失败了也照跑":旧目录还占着时，electron-builder 会在
 * `unlink app.asar` 撞 `EBUSY`，最终报成「未找到打包产物」——
 * 真正的错误被埋掉两层，排查要多花几轮构建（实测就是这么浪费的）。
 */
export function moveAside(dir, opts = {}) {
  const { retries = 4, baseDelayMs = 1500, sleep = sleepSync, onRetry } = opts;
  if (!fs.existsSync(dir)) return { ok: true, skipped: true };
  const tmp = `${dir}.bak-${Date.now()}`;
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      fs.renameSync(dir, tmp);
      return { ok: true, moved: tmp, attempts: i + 1 };
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) {
        const waitMs = baseDelayMs * (i + 1);
        onRetry?.(dir, e, i + 1, retries - 1, waitMs);
        sleep(waitMs);
      }
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * 跑一步构建:输出**同时**写控制台与日志文件，并如实上报超时。
 *
 * 【M4-Z 修的三个点】
 * ① `stdio:'pipe'` + tee → 日志落盘，红的时候有证据
 * ② `timedOut` 是**局部变量**，在 `close` 时按当时的值上报 —— 不再写死 false
 * ③ 杀进程后加**硬兜底**：即使 `close` 不触发也会 resolve，绝不挂死
 *
 * @returns {Promise<{status:number|null, timedOut:boolean, signal?:string|null, error?:Error, durationMs:number, logPath:string}>}
 */
export function runStep(label, cmd, cmdArgs, timeoutMs = 180000, opts = {}) {
  const {
    logDir,
    shell = process.platform === 'win32',
    echo = true,
    /** 杀进程后等多久强制 resolve（防止 close 不触发把构建挂死） */
    killGraceMs = 15000,
    /** 测试注入用 */
    killTree,
  } = opts;

  if (logDir) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      /* 建不了日志目录不该阻断构建 */
    }
  }
  const logPath = logDir ? path.join(logDir, `${label}.log`) : '';

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let killFallback = null;
    let timer = null;

    let logStream = null;
    if (logPath) {
      try {
        logStream = fs.createWriteStream(logPath, { flags: 'w' });
        logStream.on('error', () => { logStream = null; });
      } catch {
        logStream = null;
      }
    }

    const tee = (chunk) => {
      try {
        logStream?.write(chunk);
      } catch {
        /* 日志写失败不影响构建 */
      }
      if (echo) {
        try {
          process.stdout.write(chunk);
        } catch {
          /* 控制台写失败(如管道断开)也不该让构建崩 */
        }
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killFallback) clearTimeout(killFallback);
      try {
        logStream?.end();
      } catch {
        /* ignore */
      }
      resolve({ ...result, durationMs: Date.now() - startedAt, logPath });
    };

    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, shell });

    child.stdout?.on('data', tee);
    child.stderr?.on('data', tee);

    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (killTree) killTree(child);
        else if (process.platform === 'win32') {
          spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* ignore */
      }
      // 硬兜底:taskkill 之后 close 偶发不触发 —— 不能因此把构建挂死
      killFallback = setTimeout(() => finish({ status: null, timedOut: true }), killGraceMs);
    }, timeoutMs);

    child.on('close', (code, signal) => finish({ status: code, timedOut, signal }));
    child.on('error', (err) => finish({ status: 1, timedOut, error: err }));
  });
}

/** 读日志末尾 —— 失败时直接把现场打出来，不用再让人去翻文件 */
export function readTail(file, lineCount) {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-lineCount).join('\n');
  } catch {
    return '';
  }
}

/** 递归查找打包产物（以「产物是否存在」判断构建成功，而非只看退出码） */
export function findArtifact(dir) {
  if (!fs.existsSync(dir)) return false;
  let found = false;
  const walk = (p) => {
    let entries = [];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(p, e);
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(fp);
      else if (/\.(exe|app|AppImage|dmg|deb|rpm)$/.test(e)) found = true;
    }
  };
  walk(dir);
  return found;
}
