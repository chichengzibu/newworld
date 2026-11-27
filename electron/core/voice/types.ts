/**
 * NOVA #005-B · M4 语音 · 类型契约（第①笔）
 *
 * 设计稿:  §F1 / §F6 / §F7
 * 零 electron import / 零新依赖 — 可被 node 单测直测。
 *
 * 边界锚定(稿 F0 + F1):
 *   - TTS 主方案 = Web Speech API(speechSynthesis + SpeechSynthesisUtterance), Electron Chromium 内建。
 *   - voices:0 语义 = 用户选 voice 不可用, UI 屏蔽 voice picker(F1)。
 *     但 speechSynthesis 实例存在 → 主方案成立(F0 onstart 实证)。
 *   - TTSImpl 接口 = speechSynthesis 行为的可注入抽象(DI seam):
 *     production 取 globalThis.speechSynthesis; testing 传 mock;
 *     mock 缺失? → "speechSynthesis 缺失态" 错误码 `unavailable`(F7.1 + F1 完备态)。
 *   - 错误码与 #004-B SearchError 命名风格保持一致(`network / invalid-query / e2e-stub`),
 *     但本域独有 = `unavailable`(speechSynthesis 全缺失, 不仅是某次 speak 失败)。
 *
 * 设置模型(稿 F2.1):
 *   - enabled / autoRead 布尔, 默认 false
 *   - rate / pitch / volume 透传到 SpeechSynthesisUtterance, 默认中性 1/1/1
 *
 * 状态机(稿 F2.3):
 *   idle → speaking → (done | canceled | error) → idle
 *   显式状态再次出声(speaking 中再 speak)按 queue 语义: cancel 旧 + 立即排新(F2.3);
 *   注: queue 是单层(MVP), 不做 FIFO 多级排队。
 */

/** TTS 入参（draft F1 §1） */
export interface SpeakRequest {
  /** 必填; 引擎侧 trim 后非空校验 */
  text: string;
  /** 默认 'zh-CN'(F0 实证 voices=0 时此字段仅作"语义标注", 引擎回落默认) */
  lang?: string;
  /** 0.1–10; 默认 1.0 */
  rate?: number;
  /** 0–2; 默认 1.0 */
  pitch?: number;
  /** 0–1; 默认 1.0 */
  volume?: number;
}

/** 状态机(稿 F2.3): 单语指向 "speak → 终态" 三终态 */
export type SpeechState =
  | 'idle'         // 引擎闲置, 队列空
  | 'speaking'     // 引擎在出声
  | 'done'         // onend 触发(用户感知 = speaking 终止 + 一次性 toast)
  | 'canceled'     // cancel() 或 speaking 中再 speak 的覆盖
  | 'error';       // onerror 触发

/** 引擎错误码 */
export type TtsErrorCode =
  | 'unavailable'    // speechSynthesis 全缺失(T0-1 失败时态)
  | 'invalid-text'   // text trim 后为空
  | 'engine-error';  // utterance.onerror 触发, 引擎层语义("synthesis-failed" / "audio-busy" 等)

/** 设置模型（draft F2.1） */
export interface VoiceSettings {
  /** 全局开关; 默认 false */
  enabled: boolean;
  /** 自动朗读助手回复; 默认 false; 实现于 W5 接线批(MVP 不接 ChatManager) */
  autoRead: boolean;
  /** 0.1–10; 默认 1.0 */
  rate: number;
  /** 0–2; 默认 1.0 */
  pitch: number;
  /** 0–1; 默认 1.0 */
  volume: number;
}

/** 设置默认值常量(稿 F2.1) */
export const DEFAULT_VOICE_SETTINGS: Readonly<VoiceSettings> = Object.freeze({
  enabled: false,
  autoRead: false,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
});

/**
 * TTSImpl 接口 = speechSynthesis 行为的可注入抽象(DI seam)
 *  生产端: globalThis.speechSynthesis(必含 speak / cancel / pause / resume / getVoices / addEventListener / removeEventListener);
 *  测试端: mock 实现(参见 tests/unit/voice/store.test.ts 的 mockTTS)。
 *
 * 注: 故意不约束为 `interface { speak(u: SpeechSynthesisUtterance): void }` 类型签名,
 *   因为 SpeechSynthesisUtterance 在 TS DOM lib 里 constructor 签名多变(Web Speech API spec 跨浏览器历史包袱),
 *   这里把 utterance 视为不透明对象, 由实现侧保证构造/挂事件, store 侧只调 speak/cancel/pause/resume 三方法 + add/remove listener。
 */
export interface TTSImpl {
  speak(u: unknown): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): Array<{ name: string; lang: string; default: boolean; localService: boolean }>;
  /** F0 实证 voices=0 在 Electron 默认语义是"无可用 voice", 实测 6s 异步也不返回; 此方法 = 命中状态 / 取 voice 列表 */
  addVoicesChangedListener?(cb: () => void): () => void;
}

/**
 * 生产端默认 TTSImpl = globalThis.speechSynthesis 适配。
 * F0 实证: Electron Chromium 主进程 window.speechSynthesis 存在但 voices=0;
 *   本方法 try { globalThis.speechSynthesis } 包裹 → 主进程可用, e2e(playwright chromium)可用;
 *   F7.1 测试场景(纯 unit)由测试侧显式注入 mockTTS, 不走此方法, 故对"speechSynthesis 缺失态"无需在本方法判定,
 *   缺失判定在 SpeechStore.speak() 入口(见 store.ts)。
 */
export function defaultTTSImpl(): TTSImpl | null {
  const g = globalThis as unknown as { speechSynthesis?: unknown };
  if (!g.speechSynthesis) return null;
  return g.speechSynthesis as unknown as TTSImpl;
}