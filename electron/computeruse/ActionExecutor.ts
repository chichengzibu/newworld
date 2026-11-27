import { LogManager } from '../core/LogManager'
import { BrowserWindow } from 'electron'
import { EventBus } from '../runtime/bridge/EventBus'
import { randomUUID } from 'node:crypto'

export type ActionKind = 'click' | 'double-click' | 'type' | 'key-press' | 'scroll' | 'drag' | 'screenshot'

export interface ActionRequest {
  kind: ActionKind
  /** click / double-click / drag:目标坐标 */
  x?: number
  y?: number
  /** type:要输入的文本 */
  text?: string
  /** key-press:键名 (e.g. 'Enter', 'Tab', 'Escape', 'F5') */
  key?: string
  /** scroll:滚轮距离(正数向下) */
  deltaY?: number
  /** drag:拖拽终点 */
  toX?: number
  toY?: number
  /** 仅 Electron 模式:目标 window */
  windowId?: number
}

export interface ActionResult {
  ok: boolean
  actionId: string
  kind: ActionKind
  durationMs: number
  executed: boolean
  note?: string
  error?: string
}

/**
 * ActionExecutor: 键盘鼠标执行器
 *
 * 【v4.12 现状说明 —— 请勿被"能执行"误导】
 * 本类内部实现是**真实**的：autoExecute=true 时会调 webContents.sendInputEvent
 * 真的派发鼠标/键盘事件。但它只能作用于**本应用自己的 BrowserWindow**，
 * 无法操作系统里其它程序（要跨进程注入需要 robotjs / nut.js 之类原生模块，
 * 是原生依赖，与"零额外依赖"的取舍冲突，暂不引入）。
 *
 * 而当前**没有任何 UI 入口能把它打开**：既没有确认弹窗，也没有设置开关，
 * 上层 ComputerUseHandler 又因屏幕理解未实现而在更早一步就中止。
 * 所以实际上它不会被调用到。
 *
 * 结论：这是「库存在但链路不通」的组件。对外表述不得声称具备桌面自动化能力。
 */
export class ActionExecutor {
  private static instance: ActionExecutor
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  /** 用户确认开关:false = 只记录不执行（默认）;true = 真派发输入事件 */
  private autoExecute: boolean = false

  private constructor() {}

  public static getInstance(): ActionExecutor {
    if (!ActionExecutor.instance) ActionExecutor.instance = new ActionExecutor()
    return ActionExecutor.instance
  }

  setAutoExecute(enabled: boolean): void {
    this.autoExecute = enabled
    this.log.warn(`ActionExecutor: autoExecute = ${enabled}`)
  }

  isAutoExecute(): boolean {
    return this.autoExecute
  }

  async execute(req: ActionRequest): Promise<ActionResult> {
    const actionId = randomUUID()
    const startMs = Date.now()
    this.log.info(`ActionExecutor: ${req.kind} ${JSON.stringify({ x: req.x, y: req.y, text: req.text?.slice(0, 30), key: req.key })}`)

    if (!this.autoExecute) {
      void this.bus.publish('action:requested', { actionId, kind: req.kind, args: req })
      return {
        ok: true,
        actionId,
        kind: req.kind,
        durationMs: Date.now() - startMs,
        executed: false,
        // 原提示说"需用户在 UI 确认后调 setAutoExecute(true)"，但不存在这个 UI，
        // 会让人去找一个找不到的开关。改成如实说明。
        note: '未执行：autoExecute=false。当前版本没有开启自动执行的界面入口。',
      }
    }

    try {
      const win = req.windowId
        ? BrowserWindow.fromId(req.windowId)
        : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) {
        return { ok: false, actionId, kind: req.kind, durationMs: Date.now() - startMs, executed: false, error: 'no BrowserWindow' }
      }
      const wc = win.webContents
      switch (req.kind) {
        case 'click':
          wc.sendInputEvent({ type: 'mouseMove', x: req.x ?? 0, y: req.y ?? 0 })
          wc.sendInputEvent({ type: 'mouseDown', x: req.x ?? 0, y: req.y ?? 0, button: 'left', clickCount: 1 })
          wc.sendInputEvent({ type: 'mouseUp', x: req.x ?? 0, y: req.y ?? 0, button: 'left', clickCount: 1 })
          break
        case 'double-click':
          wc.sendInputEvent({ type: 'mouseDown', x: req.x ?? 0, y: req.y ?? 0, button: 'left', clickCount: 2 })
          wc.sendInputEvent({ type: 'mouseUp', x: req.x ?? 0, y: req.y ?? 0, button: 'left', clickCount: 2 })
          break
        case 'type':
          if (req.text) {
            for (const ch of req.text) {
              wc.sendInputEvent({ type: 'char', keyCode: ch })
            }
          }
          break
        case 'key-press':
          if (req.key) wc.sendInputEvent({ type: 'keyDown', keyCode: req.key })
          if (req.key) wc.sendInputEvent({ type: 'keyUp', keyCode: req.key })
          break
        case 'scroll':
          wc.sendInputEvent({ type: 'mouseWheel', x: req.x ?? 0, y: req.y ?? 0, deltaX: 0, deltaY: req.deltaY ?? 0 })
          break
        case 'screenshot':
          break
        case 'drag':
          wc.sendInputEvent({ type: 'mouseMove', x: req.x ?? 0, y: req.y ?? 0 })
          wc.sendInputEvent({ type: 'mouseDown', x: req.x ?? 0, y: req.y ?? 0, button: 'left' })
          wc.sendInputEvent({ type: 'mouseMove', x: req.toX ?? 0, y: req.toY ?? 0 })
          wc.sendInputEvent({ type: 'mouseUp', x: req.toX ?? 0, y: req.toY ?? 0, button: 'left' })
          break
      }
      void this.bus.publish('action:executed', { actionId, kind: req.kind, args: req })
      return { ok: true, actionId, kind: req.kind, durationMs: Date.now() - startMs, executed: true }
    } catch (e) {
      void this.bus.publish('action:failed', { actionId, kind: req.kind, error: String(e) })
      return { ok: false, actionId, kind: req.kind, durationMs: Date.now() - startMs, executed: false, error: String(e) }
    }
  }
}
