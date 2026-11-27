import { LogManager } from '../core/LogManager'

export interface ScreenFrame {
  ts: number
  dataUrl: string
  width: number
  height: number
  byteSize: number
}

export interface RecordingResult {
  frames: ScreenFrame[]
  durationMs: number
  startedAt: number
  endedAt: number
  fps: number
}

interface RecordingState {
  frames: ScreenFrame[]
  timer?: ReturnType<typeof setInterval>
  startedAt?: number
  fps: number
}

/**
 * ScreenVision: 全屏截帧器
 *
 * 【v4.12 修复】原先 `captureFrame()` 第一行是 `if (!this.recording) return null`，
 * 只有 startRecording() 之后才能截屏。但三个调用方
 * （ComputerUseHandler / IpcServer / A5ComputerUse skill）都是**不录制、直接要一帧**，
 * 于是全部拿到 null —— 整条 Computer Use 链路第一步就必然失败。
 *
 * 现在拆成两个语义清晰的方法：
 *   · captureOnce()   —— 单次截屏，不依赖录制状态（三个调用方真正需要的）
 *   · captureFrame()  —— 录制中的一帧（保留原语义，录制用）
 * 并让 captureFrame 在未录制时回落到 captureOnce，避免再出现"要一帧却拿不到"。
 */
export class ScreenVision {
  private static instance: ScreenVision
  private log = LogManager.getInstance()
  private recording: RecordingState | null = null
  private fps: number = 1
  private maxFrames: number = 60

  private constructor() {}

  public static getInstance(): ScreenVision {
    if (!ScreenVision.instance) ScreenVision.instance = new ScreenVision()
    return ScreenVision.instance
  }

  async startRecording(fps = 1): Promise<void> {
    if (this.recording) {
      this.log.warn('ScreenVision: 已在录制中,先 stop')
      await this.stopRecording()
    }
    this.fps = fps
    this.recording = { frames: [], startedAt: Date.now(), fps }
    const intervalMs = 1000 / fps
    this.recording.timer = setInterval(() => void this.captureFrame(), intervalMs)
    this.log.info(`ScreenVision: 开始录制 ${fps}fps`)
  }

  /**
   * 单次截屏 —— 不依赖录制状态。
   * 这是 ComputerUseHandler / IpcServer / A5 skill 真正需要的能力。
   */
  async captureOnce(opts: { width?: number; height?: number } = {}): Promise<ScreenFrame | null> {
    const width = opts.width ?? 1280
    const height = opts.height ?? 720
    try {
      const { desktopCapturer } = await import('electron')
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
      })
      if (sources.length === 0) {
        this.log.warn('ScreenVision.captureOnce: 没有可用的屏幕源')
        return null
      }
      const img = sources[0].thumbnail
      const dataUrl = img.toDataURL()
      const size = img.getSize()
      return {
        ts: Date.now(),
        dataUrl,
        width: size.width,
        height: size.height,
        byteSize: Math.floor((dataUrl.length * 3) / 4),
      }
    } catch (e) {
      this.log.error('ScreenVision.captureOnce: 截屏失败', e)
      return null
    }
  }

  /**
   * 录制中的一帧。未录制时回落到 captureOnce —— 调用方要一帧就该给它一帧，
   * 「没在录制」不是「不能截屏」。
   */
  async captureFrame(): Promise<ScreenFrame | null> {
    if (!this.recording) {
      return this.captureOnce()
    }
    if (this.recording.frames.length >= this.maxFrames) {
      this.log.warn('ScreenVision: 达上限,自动停止')
      await this.stopRecording()
      return null
    }
    const frame = await this.captureOnce()
    if (frame) this.recording.frames.push(frame)
    return frame
  }

  async stopRecording(): Promise<RecordingResult | null> {
    if (!this.recording) return null
    if (this.recording.timer) clearInterval(this.recording.timer)
    const frames = this.recording.frames
    const startedAt = this.recording.startedAt ?? Date.now()
    const endedAt = Date.now()
    const durationMs = endedAt - startedAt
    const result: RecordingResult = {
      frames,
      durationMs,
      startedAt,
      endedAt,
      fps: this.recording.fps,
    }
    this.recording = null
    this.log.info(`ScreenVision: 录制结束,${frames.length} 帧,${durationMs}ms`)
    return result
  }

  isRecording(): boolean {
    return this.recording !== null
  }

  // ============ W8 扩展:additive,不改既有方法 ============

  async captureAndAnalyze(opts: AnalyzeOptions = {}): Promise<{ frame: ScreenFrame; ocr?: OcrResult; understanding?: VisionUnderstanding; durationMs: number }> {
    const startMs = Date.now()
    const frame = await this.captureOnce()
    if (!frame) {
      throw new Error('ScreenVision: 截屏失败（无可用的屏幕源或系统拒绝屏幕录制权限）')
    }
    const result: { frame: ScreenFrame; ocr?: OcrResult; understanding?: VisionUnderstanding; durationMs: number } = {
      frame,
      durationMs: Date.now() - startMs,
    }
    if (opts.ocr !== false) {
      result.ocr = await this.ocrFrame(frame)
    }
    if (opts.understand !== false) {
      result.understanding = await this.understandFrame(frame)
    }
    return result
  }

  /**
   * OCR —— **当前未实现**。
   *
   * 为什么不做：真 OCR 需要引入 tesseract.js（+30MB 语言模型）或调云端 OCR API。
   * 前者显著增加安装包体积，后者需要用户配置凭据。在拿到真实用户需求前，
   * 不值得为一个未验证的场景付出这个成本。
   *
   * 【诚实标注】返回 available:false + 明确原因，而不是返回空字符串让调用方
   * 误以为「屏幕上没有文字」。这两种结果的含义完全不同。
   */
  async ocrFrame(frame: ScreenFrame): Promise<OcrResult> {
    this.log.debug(`ScreenVision.ocrFrame: 未实现 (frame ${frame.width}x${frame.height})`)
    return {
      available: false,
      unavailableReason: 'OCR 未实现：未集成文字识别引擎（需 tesseract.js 或云端 OCR 服务）',
      text: '',
      confidence: 0,
      blocks: [],
    }
  }

  /**
   * 屏幕理解 —— **当前未实现**。
   *
   * 真实现需要多模态视觉模型（Ollama llava / GPT-4V），而当前 LlmMessage.content
   * 是纯 string 类型，不支持图片数组 —— 要做得先改整个 LLM 消息层。
   *
   * 【诚实标注】available:false，且描述里说清「这是未实现」而不是「屏幕内容为空」。
   * 之前返回"(W8 stub) 屏幕内容分析待 W9 接入 Ollama Vision"这段文字会被
   * ComputerUseHandler 原样拼进 LLM prompt，模型可能把它当成真实屏幕内容，
   * 进而基于一句「待接入」的描述去做决策 —— 这是危险的行为。
   */
  async understandFrame(frame: ScreenFrame): Promise<VisionUnderstanding> {
    this.log.debug(`ScreenVision.understandFrame: 未实现 (frame ${frame.width}x${frame.height})`)
    return {
      available: false,
      unavailableReason: '屏幕理解未实现：未接入视觉模型（需多模态 LLM 支持图片输入）',
      description: '',
      elements: [],
      clickable: [],
    }
  }
}

export interface OcrResult {
  /** 该能力当前是否可用；false 时 text/blocks 一定为空，**不代表屏幕上无文字** */
  available: boolean
  /** available=false 时的原因说明 */
  unavailableReason?: string
  text: string
  confidence: number
  blocks: Array<{ text: string; bbox: { x: number; y: number; w: number; h: number }; confidence: number }>
}

export interface VisionUnderstanding {
  /** 该能力当前是否可用；false 时 description/elements 一定为空 */
  available: boolean
  /** available=false 时的原因说明 */
  unavailableReason?: string
  description: string
  elements: Array<{ type: 'button' | 'input' | 'text' | 'image' | 'icon' | 'unknown'; bbox: { x: number; y: number; w: number; h: number }; text?: string }>
  /** 推断的"可点击区域" */
  clickable: Array<{ x: number; y: number; label?: string }>
}

export interface AnalyzeOptions {
  ocr?: boolean
  understand?: boolean
  model?: 'stub-rule-based' | 'ollama-llava' | 'openai-gpt4v'
}