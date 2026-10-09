import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-dd-${k}`) },
}))

vi.mock('electron-log', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } } },
}))

import { DockerDetector } from '../../electron/sandbox/dockerDetector'

describe('DockerDetector', () => {
  let detector: DockerDetector

  beforeEach(() => {
    vi.clearAllMocks()
    detector = DockerDetector.getInstance()
  })

  it('getInstance returns singleton', () => {
    expect(DockerDetector.getInstance()).toBe(detector)
  })

  it('detect returns a result with platform set', async () => {
    const r = await detector.detect()
    expect(r).toBeDefined()
    expect(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix']).toContain(r.platform)
  })

  it('detect returns one of 6 valid statuses', async () => {
    const r = await detector.detect()
    expect([
      'available',
      'available-no-compose',
      'not-installed',
      'daemon-down',
      'permission-denied',
      'unsupported',
    ]).toContain(r.status)
  })

  it('detect on win32 识别 Docker Desktop(不再是 W9 占位 unsupported)', async () => {
    // 实现说明(dockerDetector.ts:56-59):早期对 win32 直接返回 unsupported,
    // 导致 Windows 上装了 Docker Desktop 也识别不到;现已统一走 docker --version 探测。
    // 本用例改为验证 win32 不再被强制判为 unsupported,并给出 Windows 安装地址。
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const r = await detector.detect()
      expect(r.status).not.toBe('unsupported')
      expect(r.installUrl ?? detector.installUrlFor('win32')).toContain('windows-install')
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })

  it('installUrlFor returns a URL string for current platform', () => {
    const url = (detector as any).installUrlFor(process.platform)
    expect(typeof url).toBe('string')
    expect(url).toMatch(/^https?:\/\//)
  })

  it('checkHealth returns boolean', async () => {
    const ok = await detector.checkHealth()
    expect(typeof ok).toBe('boolean')
  })
})
