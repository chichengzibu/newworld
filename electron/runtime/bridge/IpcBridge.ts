import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { LogManager } from '../../core/LogManager'
import { EventBus } from './EventBus'

const IPC_BRIDGE_CHANNEL = 'runtime:ipc-bridge'

export interface IpcBridgeMessage {
  /** 发送方标识(会话 id / actor id / 任意来源标签) */
  from: string
  type: string
  payload: unknown
}

/**
 * IpcBridge: 渲染进程 → 主进程 → runtime actor
 * 渲染进程通过 ipcRenderer.invoke('runtime:ipc-bridge', msg) 发消息
 * 主进程收到后,转发给对应 actor
 */
export class IpcBridge {
  private static instance: IpcBridge
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  private registered = false

  private constructor() {}

  public static getInstance(): IpcBridge {
    if (!IpcBridge.instance) {
      IpcBridge.instance = new IpcBridge()
    }
    return IpcBridge.instance
  }

  registerHandler(): void {
    if (this.registered) return
    ipcMain.handle(IPC_BRIDGE_CHANNEL, async (_: IpcMainInvokeEvent, msg: IpcBridgeMessage) => {
      this.log.debug(`IpcBridge: 收到 ${msg.from} 的 ${msg.type}`)
      // 【M3-G 收敛】原先这里还会查 ActorRegistry 并把消息投给对应 actor。
      // 但全仓**没有任何 actor 注册过**(actor 模型是 #005 时期的一套平行架构,
      // 从未接入当前主线)→ 那段代码永远走不到,是条不可达的路径。
      // 现只保留 EventBus 桥接 —— 这才是它实际在做的事。
      await this.bus.publish(`ipc:${msg.type}`, msg.payload, msg.from)
      return { success: true, bridge: 'ipc', echoed: msg.type }
    })
    this.registered = true
    this.log.info('IpcBridge: 已注册 IPC 监听')
  }

  async sendToRenderer(type: string, payload: unknown, source?: string): Promise<void> {
    await this.bus.publish(`renderer:${type}`, payload, source)
  }

  channel(): string {
    return IPC_BRIDGE_CHANNEL
  }
}