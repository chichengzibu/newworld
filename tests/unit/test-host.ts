/**
 * TestHost — 单测专用 PlatformHost 实现(纯 TS,不 import electron)
 *
 * 背景:Phase 2 解耦后 core 层一切平台能力走 getHost()。此前 setup 用
 * ElectronHost + electron mock,而 ElectronHost 在 setup 阶段就绑定了那个
 * mock app 对象,测试文件里各自的 vi.mock('electron') 因模块陈旧绑定永不生效,
 * 导致所有持久化单测(IMConfigStore / ModelUsageTracker / ClawHubManager)
 * 落到同一 userData 目录并跨用例累积,而各 beforeEach 删的是自己硬编码的
 * 假路径 — 清不到真目录,计数/列表断言全线失败(2→41、3→10)。
 *
 * TestHost 直接指向一个固定测试目录,测试文件无需再 vi.mock electron。
 * 生命周期方法(quit/relaunch 等)在单测环境无真实应用可操作:
 * 这里不做静默 no-op,而是抛显式错误 — 若某测试真的走到 app.quit(),
 * 说明测试本身有问题,应当场暴露而非掩盖。
 */
import * as fsNode from 'node:fs'
import * as pathNode from 'node:path'
import * as os from 'node:os'
import type {
  PlatformHost,
  PlatformId,
  AppPathName,
  AppLifecycleListener,
  AppLifecycleEvent,
  AppRelaunchOptions,
} from '../../electron/platform/PlatformHost'

/**
 * 所有单测共享的 userData 目录基址。
 *
 * 关键:按 worker 进程 pid 区分,使 vitest 并行 fork 的各 worker 落到互不
 * 相交的目录 — 否则会并发 rmSync 同一共享目录,触发 EBUSY/ENOTEMPTY 竞态
 * (全量并行跑 190 挂、单文件 48/48 全绿即此因)。
 * worker 内测试文件串行执行,setup 的 beforeEach 每用例清空本 worker 目录,
 * 持久化类断言("初始为空 / 重启恢复")在串行下稳定成立。
 */
export const TEST_USER_DATA = pathNode.join(
  os.tmpdir(),
  `pipiclaw-test-userdata-${process.pid}`,
)

export class TestHost implements PlatformHost {
  platform(): PlatformId {
    return 'linux'
  }

  getPath(_name: AppPathName): string {
    // 所有路径名统一收敛到同一测试目录下,按名分目录避免互相踩
    const base = TEST_USER_DATA
    if (!fsNode.existsSync(base)) fsNode.mkdirSync(base, { recursive: true })
    // agent 工具(Read/Edit/Glob)与集成测试以 userData/{sandbox,workspace}
    // 为强制根,且 fs.writeFile 不建父目录 — 构造期即保证存在
    fsNode.mkdirSync(pathNode.join(base, 'sandbox'), { recursive: true })
    fsNode.mkdirSync(pathNode.join(base, 'workspace'), { recursive: true })
    return base
  }

  getVersion(): string {
    return '0.0.0-test'
  }

  isPackaged(): boolean {
    return false
  }

  getAppPath(): string {
    // 【M4-X】技能目录改到「应用自身结构目录的 skills」后,这里是**唯一真源**:
    // 开发态下真实 electron 以 "." 启动 → appPath = 仓库根 → `<appPath>/skills` = 仓库的 skills/。
    // 测试里同理:appPath = TEST_USER_DATA → `<appPath>/skills` = TEST_USER_DATA/skills,
    // 与各测试直接写入的 `<TEST_USER_DATA>/skills` 是**同一个目录**
    // (读写同源 —— 历史上"写一处、读另一处"导致技能永远扫不到,别再分叉)。
    return TEST_USER_DATA
  }

  // —— 生命周期:测试环境无真实应用,调用即视为错误 ——
  on(_event: AppLifecycleEvent, _listener: AppLifecycleListener): void {
    throw new Error('[TestHost] app.on 不应在单测中调用')
  }
  once(_event: AppLifecycleEvent, _listener: AppLifecycleListener): void {
    throw new Error('[TestHost] app.once 不应在单测中调用')
  }
  quit(): void {
    throw new Error('[TestHost] app.quit 不应在单测中调用')
  }
  relaunch(_options?: AppRelaunchOptions): void {
    throw new Error('[TestHost] app.relaunch 不应在单测中调用')
  }
  exit(_code?: number): void {
    throw new Error('[TestHost] app.exit 不应在单测中调用')
  }

  // —— 只读状态 ——
  whenReady(): Promise<void> {
    return Promise.resolve()
  }
  isReady(): boolean {
    return true
  }

  tray(): null {
    return null
  }
  shortcuts(): null {
    return null
  }
  updater(): null {
    return null
  }
  secureStorage(): null {
    return null
  }
}
