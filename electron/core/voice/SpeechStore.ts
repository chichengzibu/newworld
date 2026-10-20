/**
 * NOVA #005-B · M4 语音 · SpeechStore(TTS 状态机 + queue, 第①笔)
 *
 * 设计稿: docs/NOVA-#005-M4-voice-design.md §F1 / §F2.3 / §F7
 * 零 electron import / 零新依赖 — 可被 node 单测直测。
 *
 * 核心约定(稿 F12.2):
 *   显式 DI 注入 `ttsImpl?`(与 searchStore.search(q, fetchImpl?) 同族);
 *   DI seam 缺失? → `ttsImpl === undefined` 时按生产端 defaultTTSImpl() 取;
 *   defaultTTSImpl() 返回 null → 状态码 'unavailable', 不静默走模块态(DEV-013/014 红线)。
 *
 * 状态机(稿 F2.3):
 *   idle → speaking → (done | canceled | error) → idle
 *   done/canceled/error 是**一次性终态**(= speaking 终止 + 一次性通知), 不作为"轮转态"长期停留,
 *   但允许消费侧 listener 收到一次性的终态事件后, store 内部立刻回归 idle。
 *
 * queue 语义(稿 F2.3 + 命令"speaking 中再 speak" = cancel 旧 + 立即排新):
 *   queue 是**单层替换**(非 FIFO 多级):
 *   - queue 为空 → 直接 speak;
 *   - queue 有未消耗项 → 替换之, 不堆叠;
 *   - speaking 中再 speak → cancel 当前 utterance + 排新项 + 重置 speak()。
 *   注意: 这是**单语**语义, 不做多句连读(超出 MVP 边界)。
 */
import {
  DEFAULT_VOICE_SETTINGS,
  type SpeechState,
  type SpeakRequest,
  type TTSImpl,
  type VoiceSettings,
  defaultTTSImpl,
} from './types';

/** 终态事件回调签名(稿 F2.3 Orb 联动) */
export type StateListener = (s: SpeechState, payload?: { reason?: string; code?: string }) => void;

export interface SpeechStoreOptions {
  /** DI 注入(F7.2 / F12.2); 缺省 → defaultTTSImpl()(globalThis.speechSynthesis) */
  ttsImpl?: TTSImpl | null;
  /** 测试 seam: 注入 time provider(单测可控时钟), 不暴露给生产 */
  now?: () => number;
}

export class SpeechStore {
  private ttsImpl: TTSImpl | null;
  private readonly now: () => number;
  private current: SpeakRequest | null = null;
  /** 一次性挂接在当前 utterance 上的 onend/onerror 处理; 每次新 utterance 重建 */
  private boundHandlers: {
    onStart?: (ev: Event) => void;
    onEnd?: (ev: Event) => void;
    onError?: (ev: { error?: string } & Event) => void;
  } = {};
  private currentUtterance: unknown = null;
  private _state: SpeechState = 'idle';
  private _settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };
  private listeners = new Set<StateListener>();

  constructor(opts: SpeechStoreOptions = {}) {
    // DI seam(F12.2 禁读模块态 — 显式参数透传):
    //   opts.ttsImpl === undefined → 生产端 defaultTTSImpl();
    //   opts.ttsImpl === null → 测试显式置空(用于 unavailable 态的精确判定);
    //   opts.ttsImpl 为对象 → 测试显式注入。
    if (opts.ttsImpl === undefined) {
      this.ttsImpl = defaultTTSImpl();
    } else {
      this.ttsImpl = opts.ttsImpl;
    }
    this.now = opts.now ?? (() => Date.now());
  }

  // ─── state accessors ───
  get state(): SpeechState {
    return this._state;
  }
  get settings(): Readonly<VoiceSettings> {
    return this._settings;
  }
  /** 渲染层对 queue 是否还有未消耗项的判定(供 UI 反馈) */
  get pending(): boolean {
    return this.current !== null;
  }

  // ─── subscription(供 Orb 联动 / UI 三态) ───
  subscribe(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit(s: SpeechState, payload?: { reason?: string; code?: string }): void {
    this._state = s;
    this.listeners.forEach((fn) => fn(s, payload));
    // done/canceled/error 是"一次性终态" — 立即回归 idle(仅保留通知历史给 listener)
    if (s === 'done' || s === 'canceled' || s === 'error') {
      // 下一 microtask 回归 idle, 让 listener 先收到终态
      queueMicrotask(() => {
        this._state = 'idle';
        this.listeners.forEach((fn) => fn('idle', payload));
      });
    }
  }

  // ─── settings update(稿 F2.1) ───
  updateSettings(patch: Partial<VoiceSettings>): void {
    this._settings = { ...this._settings, ...patch };
  }

  // ─── main API: 朗读(稿 F2.3) ───
  /**
   * 朗读一段文本。语义:
   *   - ttsImpl 为 null(且 opts.ttsImpl !== null 显式置空也算) → 状态切 error(unavailable), 抛 code
   *   - text trim 后为空 → 状态切 error(invalid-text), 抛 code
   *   - enabled = false → 不抛错, 静默 ignore(稿 F2.1 默认关 + 命令"不做降级"约定, 但避免被滥用来开声)
   *     实测: 命令 "默认关 + 朗读按钮落点 (c)/voice 路由" → 用户主动进入 /voice 即视为启用, 此处 enabled
   *     不再二次校验, 仅作为 settings 真值(供未来 ChatManager.onMessageComplete 钩子引用)。
   *   - speaking 中再 speak → cancel 旧 + 排新 + 立即 speak(语序律一致)
   *   - 终态事件(onend/onerror) → emit('done'|'error') + queueMicrotask 回归 idle
   */
  speak(req: SpeakRequest): { ok: boolean; code?: 'unavailable' | 'invalid-text' } {
    const text = (req?.text ?? '').trim();
    if (!text) {
      this.emit('error', { reason: 'invalid-text', code: 'invalid-text' });
      return { ok: false, code: 'invalid-text' };
    }
    if (!this.ttsImpl) {
      this.emit('error', { reason: 'unavailable', code: 'unavailable' });
      return { ok: false, code: 'unavailable' };
    }
    const next: SpeakRequest = {
      text,
      lang: req.lang ?? 'zh-CN',
      rate: req.rate ?? this._settings.rate,
      pitch: req.pitch ?? this._settings.pitch,
      volume: req.volume ?? this._settings.volume,
    };
    // speaking 中再 speak → cancel 旧 + 排新
    if (this._state === 'speaking') {
      try { this.ttsImpl.cancel(); } catch { /* engine quirk: ignore */ }
      this.detachHandlers();
      this.currentUtterance = null;
      this.current = null;
    }
    this.current = next;
    this.fireUtterance(next);
    return { ok: true };
  }

  /** 取消当前朗读(稿 F2.3 朗读中再点 = 停止) */
  cancel(): void {
    if (!this.ttsImpl) return;
    if (this._state !== 'speaking') return;
    try { this.ttsImpl.cancel(); } catch { /* ignore */ }
    // cancel 触发 onend(浏览器语义) — 这里保险一道, 若 onend 不发(electron quirk)显式触发终态
    this.detachHandlers();
    this.currentUtterance = null;
    this.current = null;
    this.emit('canceled', { reason: 'cancel' });
  }

  /** pause / resume(F1 能力面存在 + F2.3 "UI 不暴露, MVP 简化") */
  pause(): void {
    if (!this.ttsImpl) return;
    if (this._state !== 'speaking') return;
    try { this.ttsImpl.pause(); } catch { /* ignore */ }
  }
  resume(): void {
    if (!this.ttsImpl) return;
    try { this.ttsImpl.resume(); } catch { /* ignore */ }
  }

  // ─── utterance 拼装 ───
  private fireUtterance(req: SpeakRequest): void {
    if (!this.ttsImpl) return;
    const u = constructUtterance(req);
    this.currentUtterance = u;
    const onStart = () => this.emit('speaking');
    const onEnd = () => {
      this.detachHandlers();
      this.currentUtterance = null;
      this.current = null;
      this.emit('done');
    };
    const onError = (ev: Event | { error?: string }) => {
      this.detachHandlers();
      this.currentUtterance = null;
      this.current = null;
      const code = (ev && 'error' in ev) ? String(ev.error ?? 'engine-error') : 'engine-error';
      this.emit('error', { reason: code, code: 'engine-error' });
    };
    attachHandlers(u, { onStart, onEnd, onError });
    this.boundHandlers = { onStart, onEnd, onError };
    try {
      this.ttsImpl.speak(u);
    } catch (e) {
      onError({ error: String((e as Error)?.message ?? e) });
    }
  }

  private detachHandlers(): void {
    if (!this.ttsImpl || !this.currentUtterance) return;
    removeHandlers(this.currentUtterance, this.boundHandlers);
  }

  /** 测试 seam: 清空状态(单测池 isolate=true 天然隔离, 此为文件内多例 seam) */
  resetForTest(): void {
    this.detachHandlers();
    this.current = null;
    this.currentUtterance = null;
    this._state = 'idle';
    this._settings = { ...DEFAULT_VOICE_SETTINGS };
    this.listeners.clear();
  }
}

// ──────────────────────────────── 引擎无关 utility ────────────────────────────────

/**
 * 构造 utterance。
 * 不强约束 `SpeechSynthesisUtterance` 类型(浏览器间 ctor 签名漂移),
 * 返回 `unknown` 由 TTSImpl.speak(u) 消费。
 * 生产端: `new SpeechSynthesisUtterance(text)` 由 globalThis 取;
 * 测试端: 测试用例自行造 mock utterance。
 */
function constructUtterance(req: SpeakRequest): unknown {
  const g = globalThis as unknown as { SpeechSynthesisUtterance?: new (text: string) => unknown };
  if (g.SpeechSynthesisUtterance) {
    const u = new g.SpeechSynthesisUtterance(req.text);
    // 直接挂属性, 不借 setter(避免 spec 差异)
    try { (u as { lang?: string }).lang = req.lang ?? 'zh-CN'; } catch { /* ignore */ }
    try { (u as { rate?: number }).rate = req.rate ?? 1.0; } catch { /* ignore */ }
    try { (u as { pitch?: number }).pitch = req.pitch ?? 1.0; } catch { /* ignore */ }
    try { (u as { volume?: number }).volume = req.volume ?? 1.0; } catch { /* ignore */ }
    return u;
  }
  // 兜底: 测试场景无 SpeechSynthesisUtterance ctor — 由测试侧保证。
  return { text: req.text, lang: req.lang, rate: req.rate, pitch: req.pitch, volume: req.volume, _listeners: {} as Record<string, Function[]> };
}

function attachHandlers(
  u: unknown,
  h: { onStart: (ev: Event) => void; onEnd: (ev: Event) => void; onError: (ev: { error?: string } & Event) => void },
): void {
  // 真 utterance: addEventListener / onstart / onend / onerror
  if (typeof (u as { addEventListener?: unknown })?.addEventListener === 'function') {
    try { (u as unknown as { addEventListener: (t: string, h: (e: Event) => void) => void }).addEventListener('start', h.onStart); } catch { /* ignore */ }
    try { (u as unknown as { addEventListener: (t: string, h: (e: Event) => void) => void }).addEventListener('end', h.onEnd); } catch { /* ignore */ }
    try { (u as unknown as { addEventListener: (t: string, h: (e: { error?: string } & Event) => void) => void }).addEventListener('error', h.onError); } catch { /* ignore */ }
    return;
  }
  // 兜底: 测试造 mock utterance with _listeners + onxxx 字段
  const m = u as { onstart?: (e: Event) => void; onend?: (e: Event) => void; onerror?: (e: { error?: string } & Event) => void };
  m.onstart = h.onStart; m.onend = h.onEnd; m.onerror = h.onError;
}

function removeHandlers(u: unknown, h: SpeechStore['boundHandlers']): void {
  if (typeof (u as { removeEventListener?: unknown })?.removeEventListener === 'function') {
    try { (u as unknown as { removeEventListener: (t: string, h: (e: Event) => void) => void }).removeEventListener('start', h.onStart!); } catch { /* ignore */ }
    try { (u as unknown as { removeEventListener: (t: string, h: (e: Event) => void) => void }).removeEventListener('end', h.onEnd!); } catch { /* ignore */ }
    try { (u as unknown as { removeEventListener: (t: string, h: (e: { error?: string } & Event) => void) => void }).removeEventListener('error', h.onError!); } catch { /* ignore */ }
    return;
  }
  // 兜底清字段(测试侧)
  const m = u as { onstart?: unknown; onend?: unknown; onerror?: unknown };
  m.onstart = undefined; m.onend = undefined; m.onerror = undefined;
}