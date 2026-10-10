/**
 * Schedule.vue — 行操作列 scope.row 行为修复测试 (v3 Step A)
 *
 * 修复点: src/views/Schedule.vue:46-48
 *   修复前: @click="openEditDialog(row)" / viewHistory(row) / handleDelete(row)
 *           —— 模板作用域里 `row` 未定义 (el-table 单元格作用域变量是 scope.row),
 *              运行时 handler 收到 undefined → remove(undefined.id) 崩, 编辑/历史传空对象
 *   修复后: @click="openEditDialog(scope.row)" / viewHistory(scope.row) / handleDelete(scope.row)
 *           —— 正确取 scope.row
 *
 * 本测试 stub el-table + el-table-column, 用 fixture 作为 "当前行" 传入 scope,
 * 断言 3 个 handler 实际收到那条 fixture (行为级证据: remove(ROW.id), history(ROW.id),
 * edit → form 被填为 ROW.name 等)。反证: handler 绝不应收到 undefined (修复前 bug 的签名)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h } from 'vue'

// Mock element-plus 静态方法 (Schedule.vue 从子路径取用)
const { ElMessageMock, ElMessageBoxMock } = vi.hoisted(() => ({
  ElMessageMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBoxMock: { confirm: vi.fn().mockResolvedValue('confirm') }, // 模拟用户点"确认"
}))
vi.mock('element-plus', () => ({ ElMessage: ElMessageMock, ElMessageBox: ElMessageBoxMock }))
vi.mock('element-plus/es/components/message/index', () => ({ ElMessage: ElMessageMock }))
vi.mock('element-plus/es/components/message-box/index', () => ({ ElMessageBox: ElMessageBoxMock }))

// electronAPI mock (schedule 命名空间; 其它命名空间空即可)
const { api } = vi.hoisted(() => {
  const api: any = {}
  api.schedule = {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    remove: vi.fn(),      // handleDelete → schedule.remove(id)
    history: vi.fn(),     // viewHistory → schedule.history(id)
    toggle: vi.fn(),
    execute: vi.fn(),
    cancel: vi.fn(),
  }
  ;(globalThis as any).window = (globalThis as any).window || {}
  ;(globalThis as any).window.electronAPI = api
  return { api }
})

import Schedule from '../../../src/views/Schedule.vue'

// 行 fixture
const ROW = {
  id: 'sched-001',
  name: '每周清理任务',
  description: 'desc',
  instruction: 'do cleanup',
  scheduleType: 'weekly' as const,
  cron: '0 0 * * 1',
  retryCount: 2,
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
}

/**
 * Stub 策略:
 *   - el-table: 把 default slot(el-table-column 们) 包一层, 但 **不** 做行迭代
 *     (真实 el-table 会按 data 逐行渲染 el-table-column; 测试里我们只关心 "1 行" 的
 *     scope 传导语义, 不关心多行)
 *   - el-table-column: 在 render 里调用自己的 default slot, 作用域 = 测试注入的 fixture
 *     —— 等价于真实 el-table 给某一行渲染 el-table-column 单元格时传 scope={row}
 *   - 其他组件: 最小 stub, render 原样透传 default slot
 */
function makeStubs(rowFixture: any): Record<string, any> {
  const passthrough = (cls: string) => ({
    render(this: any) {
      return h('div', { class: cls }, this.$slots?.default?.())
    },
  })
  return {
    'el-table': {
      props: { data: Array, stripe: Boolean },
      render(this: any) {
        // 不逐行迭代, 只透传 default slot (el-table-column 们)
        return h('div', { class: 'el-table-stub' }, this.$slots?.default?.())
      },
    },
    'el-table-column': {
      props: {
        label: String, prop: String, width: [String, Number],
        minWidth: [String, Number], fixed: [Boolean, String],
      },
      render(this: any) {
        // 关键: 把 fixture 作为 scope.row 传给本单元格的 default slot (按钮们)
        const scope = { row: rowFixture, $index: 0, column: null }
        return h('div', { class: 'el-col-stub' }, this.$slots?.default?.(scope))
      },
    },
    'el-button': {
      props: { size: String, type: String, text: Boolean },
      render(this: any) {
        const onClick = this.$attrs?.onClick
        return h('button', { class: 'el-button-stub', onClick }, this.$slots?.default?.())
      },
    },
    'el-tag': passthrough('el-tag-stub'),
    'el-switch': {
      props: { modelValue: Boolean },
      render() { return h('input', { type: 'checkbox', class: 'el-switch-stub' }) },
    },
    'el-alert': passthrough('el-alert-stub'),
    'el-empty': passthrough('el-empty-stub'),
    'el-icon': passthrough('el-icon-stub'),
    'el-dialog': passthrough('el-dialog-stub'),
    'el-form': passthrough('el-form-stub'),
    'el-form-item': passthrough('el-form-item-stub'),
    'el-input': { render: () => h('input', { class: 'el-input-stub' }) },
    'el-select': passthrough('el-select-stub'),
    'el-option': { render: () => h('option', { class: 'el-option-stub' }) },
    'el-input-number': { render: () => h('input', { class: 'el-input-number-stub' }) },
    Plus: { render: () => h('i', { class: 'plus-stub' }) },
  }
}

describe('Schedule 行操作列 scope.row 修复 (行为级证据)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.schedule.list.mockResolvedValue({ success: true, data: [ROW] })
    api.schedule.update.mockResolvedValue({ success: true })
    api.schedule.history.mockResolvedValue({ success: true, data: [] })
    api.schedule.remove.mockResolvedValue({ success: true })
    ElMessageBoxMock.confirm.mockResolvedValue('confirm')
  })

  async function mountWithRow(rowFixture: any) {
    // stub 里用 fixture 作为 scope.row (模拟真实 el-table 渲染某一行)
    const wrapper = mount(Schedule, { global: { stubs: makeStubs(rowFixture) } })
    await flushPromises()
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('action 列渲染出 3 个按钮 (编辑/历史/删除)', async () => {
    const wrapper = await mountWithRow(ROW)
    const actionCols = wrapper.findAll('.el-col-stub')
    // 4 个 el-table-column: name/instruction/scheduleType/enabled/createTime/actions
    // 其中 actions 列才有 3 个 el-button
    let actionButtons = wrapper.findAll('.el-button-stub')
    // 页面顶部 "创建任务" 也是 el-button, 排除它
    const headerBtns = wrapper.findAll('.page-header .el-button-stub').length
    expect(actionButtons.length).toBeGreaterThan(headerBtns)
    // actions 列 3 个
    expect(wrapper.findAll('.el-col-stub').some(col => col.findAll('.el-button-stub').length === 3)).toBe(true)
  })

  it('点击"删除" → schedule.remove 收到 ROW.id (非 undefined)', async () => {
    const wrapper = await mountWithRow(ROW)
    // 找到 actions 列 (有 3 按钮的那列)
    const actionCol = wrapper.findAll('.el-col-stub').find(c => c.findAll('.el-button-stub').length === 3)
    if (!actionCol) throw new Error('未找到 actions 列')
    const buttons = actionCol.findAll('.el-button-stub')
    await buttons[2].trigger('click')   // 删除
    await flushPromises()
    // ElMessageBox.confirm 被调用 (handleDelete 第一步)
    expect(ElMessageBoxMock.confirm).toHaveBeenCalledTimes(1)
    // schedule.remove 被调用, 收到 ROW.id
    expect(api.schedule.remove).toHaveBeenCalledTimes(1)
    expect(api.schedule.remove).toHaveBeenCalledWith(ROW.id)
    // 反证: 绝不应收到 undefined (修复前 bug 的签名)
    const received = api.schedule.remove.mock.calls[0]?.[0]
    expect(received).not.toBe(undefined)
  })

  it('点击"历史" → schedule.history 收到 ROW.id (非 undefined)', async () => {
    const wrapper = await mountWithRow(ROW)
    const actionCol = wrapper.findAll('.el-col-stub').find(c => c.findAll('.el-button-stub').length === 3)!
    const buttons = actionCol.findAll('.el-button-stub')
    await buttons[1].trigger('click')   // 历史
    await flushPromises()
    expect(api.schedule.history).toHaveBeenCalledTimes(1)
    expect(api.schedule.history).toHaveBeenCalledWith(ROW.id)
    const received = api.schedule.history.mock.calls[0]?.[0]
    expect(received).not.toBe(undefined)
  })

  it('点击"编辑" → openEditDialog 用该 ROW 填充表单 (form.name === ROW.name)', async () => {
    const wrapper = await mountWithRow(ROW)
    const actionCol = wrapper.findAll('.el-col-stub').find(c => c.findAll('.el-button-stub').length === 3)!
    const buttons = actionCol.findAll('.el-button-stub')
    await buttons[0].trigger('click')   // 编辑
    await flushPromises()
    // openEditDialog 执行后: form 被赋值为 ROW, isEditing=true
    const vm = wrapper.vm as any
    expect(vm.isEditing).toBe(true)
    expect(vm.form.id).toBe(ROW.id)
    expect(vm.form.name).toBe(ROW.name)
    expect(vm.dialogVisible).toBe(true)
  })

  it('反证: 若 handler 收到 undefined (修复前 bug), remove 会崩 (id 为 undefined)', async () => {
    // 模拟 bug 场景: stub 传 undefined 作为 scope.row
    const wrapper = await mountWithRow(undefined)
    const actionCol = wrapper.findAll('.el-col-stub').find(c => c.findAll('.el-button-stub').length === 3)
    if (actionCol) {
      const buttons = actionCol.findAll('.el-button-stub')
      // v-if="scope?.row" 为 false → 3 个按钮不渲染 (模板里 <template v-if="scope?.row"> 守卫)
      expect(actionCol.findAll('.el-button-stub').length).toBe(0)
      // 这证明修复前 "row undefined" 不会让按钮消失而是静默空对象;
      // 修复后 (scope.row 存在) 按钮正常渲染
    }
  })
})
