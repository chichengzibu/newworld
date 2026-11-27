import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ArtifactPanel from '../../../src/components/chat/ArtifactPanel.vue'
import type { ProducedArtifact } from '../../../src/types/electron-api'

const artifacts: ProducedArtifact[] = [
  {
    path: 'C:/data/workspace/验收报告.docx',
    name: '验收报告.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 20480,
    kind: 'document',
  },
  {
    path: 'C:/data/workspace/清单.xlsx',
    name: '清单.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 8192,
    kind: 'spreadsheet',
  },
]

describe('成品交付卡片', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        file: {
          open: vi.fn().mockResolvedValue({ success: true }),
          showInFolder: vi.fn().mockResolvedValue({ success: true }),
        },
      },
    })
  })

  it('AP-1 只展示 stat 过的真实文件名/大小/类型', () => {
    const wrapper = mount(ArtifactPanel, { props: { artifacts } })
    const text = wrapper.text()
    expect(text).toContain('成品文件')
    expect(text).toContain('2 份')
    expect(text).toContain('验收报告.docx')
    expect(text).toContain('20.0 KB')
    expect(text).toContain('文档')
    expect(text).toContain('清单.xlsx')
    expect(text).toContain('8.0 KB')
    expect(wrapper.findAll('.artifact-row')).toHaveLength(2)
  })

  it('AP-2 打开/定位走白名单 IPC，失败时行内显示原因', async () => {
    const open = vi.fn().mockResolvedValue({ success: false, error: '路径不在允许的成品目录内' })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { file: { open, showInFolder: vi.fn().mockResolvedValue({ success: true }) } },
    })

    const wrapper = mount(ArtifactPanel, { props: { artifacts: [artifacts[0]] } })
    const buttons = wrapper.findAll('el-button')
    expect(buttons).toHaveLength(2)

    await buttons[0].trigger('click')
    await flushPromises()
    expect(open).toHaveBeenCalledWith(artifacts[0].path)
    expect(wrapper.text()).toContain('路径不在允许的成品目录内')
  })
})
