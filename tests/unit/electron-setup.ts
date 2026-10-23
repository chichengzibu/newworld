/**
 * Vitest global setup for electron module mocking
 *
 * 在 vitest 3.x + pool: 'forks' 下, 每个 worker 进程需要独立 mock electron
 * 否则 `import { app } from 'electron'` 会因找不到模块而失败
 *
 * 真实的 mock 内容 (返回路径等) 由各测试文件的 vi.mock('electron', ...) 提供
 * 本文件只确保模块可以被解析, 实际行为由具体 mock factory 决定
 */
import { vi } from 'vitest'

// Stub electron module so vite can resolve `import 'electron'`
vi.mock('electron', () => {
  // 可逆 XOR "加密" 模拟 safeStorage(加密存储语义:密文不可读、密钥可还原)。
  // 此前全局 mock 漏了 safeStorage,LlmConfigStore / IMConfigStore
  // `import { safeStorage } from 'electron'` 拿到 undefined,加密读写全崩;
  // 各测试文件自带的 safeStorage mock 因陈旧绑定不生效,只能补到全局。
  const KEY = 0x5a
  const xor = (buf: Uint8Array) => new Uint8Array(buf.map((b, i) => b ^ KEY ^ i))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => xor(Buffer.from(plain, 'utf-8')) as Buffer,
    decryptString: (buf: Uint8Array) => Buffer.from(xor(buf)).toString('utf-8'),
  }
  return {
    app: {
      getPath: vi.fn(() => '/tmp/pipiclaw-test-userdata'),
      getVersion: vi.fn(() => '4.3.0'),
      getPlatform: vi.fn(() => 'linux'),
      getAppPath: vi.fn(() => '/tmp/pipiclaw-test-app'),
    },
    safeStorage,
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
    },
    // 【M1-D】ChatManager 用 BrowserWindow.getAllWindows() 广播到渲染层。
    // 此前 mock 里 BrowserWindow 是裸 vi.fn(),没有这个静态方法,
    // 导致"执行确认闸门"无法在测试里模拟有无渲染窗口 —— fail-safe 分支
    // (无窗口 → 拒绝执行)就永远测不到。默认返回空数组 = 无渲染窗口。
    BrowserWindow: Object.assign(vi.fn(), {
      getAllWindows: vi.fn(() => [] as unknown[]),
    }),
    dialog: { showMessageBox: vi.fn() },
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
  }
})

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    transports: { file: { resolvePathFn: vi.fn(), maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

// ── P0 修复:测试环境注入平台宿主 ──
// Phase 2 解耦后 core 层经 getHost() 访问平台能力,强依赖 host 先行注入;
// 此前 setup 只做 vi.mock('electron') 不注入 host,272/299 用例抛
// "PlatformHost 尚未初始化"。
//
// 注入用 TestHost(纯 TS、不碰 electron mock)而非 initHost():
// ElectronHost 在 setup 阶段绑定 electron mock 对象后,各测试文件里自己的
// vi.mock('electron') 因模块陈旧绑定永不生效,持久化类单测全部落到同一
// userData 累积、互相污染(见 tests/unit/test-host.ts 头注释)。
import * as fsNode from 'node:fs'
import * as pathNode from 'node:path'
import { beforeEach } from 'vitest'
import { TestHost, TEST_USER_DATA } from './test-host'
import { setHost } from '../../electron/platform/runtime'

setHost(new TestHost())

// 每用例前清空共享测试目录:各单测文件的 beforeEach 清的是各自硬编码的
// 路径,实际清不到这里;由 setup 统一在真路径上做隔离,持久化类断言
// ("初始为空 / 重启后恢复")才能稳定成立。仅清目录内容,不破坏用例内部
// 的"实例化→写→重读磁盘"序列(那发生在一个用例内)。
beforeEach(() => {
  if (fsNode.existsSync(TEST_USER_DATA)) {
    fsNode.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    fsNode.mkdirSync(TEST_USER_DATA, { recursive: true })
  }
  // agent 工具(Read/Edit/Glob)强制根为 userData/{sandbox,workspace},
  // 且 fs.writeFile 不创建父目录 — 每用例清空后补建,保证工具测试可写
  fsNode.mkdirSync(pathNode.join(TEST_USER_DATA, 'sandbox'), { recursive: true })
  fsNode.mkdirSync(pathNode.join(TEST_USER_DATA, 'workspace'), { recursive: true })
})