import io

p = 'electron/insight/CostTracker.ts'
s = io.open(p, encoding='utf-8').read()

old = """  setPricing(model: string, p: ModelPricing): void {
    this.pricing.set(model, p)
  }"""
new = """  /**
   * 【M4-H】设置某个模型的定价 —— 现**持久化**。
   *
   * 【为什么以前是死的】`setPricing` 此前只改内存里的 Map,**不落盘** →
   * 重启即丢。加上零调用方,等于完全不存在。
   * 而用户自己的模型(比如某个 API 中转站的模型名)不在默认表里 →
   * 查表落空 → 成本恒 0 → 「成本面板永远是 0」却看不出原因。
   */
  setPricing(model: string, p: ModelPricing): void {
    this.pricing.set(model, p)
    this.persistPricing()
  }

  /** 列出全部已知定价(默认表 + 用户自定义) */
  listPricing(): Array<{ model: string; inputPer1kUsd: number; outputPer1kUsd: number; custom: boolean }> {
    const defaults = new Set(CostTracker.DEFAULT_PRICING_MODELS)
    return [...this.pricing.entries()].map(([model, p]) => ({
      model,
      inputPer1kUsd: p.inputPer1kUsd,
      outputPer1kUsd: p.outputPer1kUsd,
      custom: !defaults.has(model),
    }))
  }"""
assert old in s
s = s.replace(old, new, 1)

old = """  private seedDefaultPricing(): void {"""
new = """  /** 默认定价表的模型名集合(用于区分「默认」与「用户自定义」) */
  private static readonly DEFAULT_PRICING_MODELS = [
    'gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'ollama-llama3',
    'ollama-qwen3.5', 'ollama-bge-m3', 'ollama-qwen3.8', 'zhipu-glm-4',
  ]

  private seedDefaultPricing(): void {"""
assert old in s
s = s.replace(old, new, 1)

old = """  private persistToDisk(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.usages))
    } catch (e) {
      this.log.warn('CostTracker: persist failed', e)
    }
  }"""
new = """  private persistToDisk(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.usages))
    } catch (e) {
      this.log.warn('CostTracker: persist failed', e)
    }
  }

  /**
   * 【M4-H】定价持久化 —— 与用量记录**分开**存。
   *
   * 用量是频繁追加的(每次 LLM 调用一条),定价是极少变的(用户手动配一次)。
   * 放同一个文件会让「改一次定价」重写整个用量数组。
   */
  private pricingPath(): string {
    return path.join(path.dirname(this.storePath), 'cost-pricing.json')
  }

  private loadPricing(): void {
    try {
      const p = this.pricingPath()
      if (!fs.existsSync(p)) return
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, ModelPricing>
      for (const [model, price] of Object.entries(raw ?? {})) {
        if (price && typeof price.inputPer1kUsd === 'number' && typeof price.outputPer1kUsd === 'number') {
          this.pricing.set(model, price)
        }
      }
      this.log.info('CostTracker: 自定义定价已加载', { count: Object.keys(raw ?? {}).length })
    } catch (e) {
      this.log.warn('CostTracker: 定价加载失败', e)
    }
  }

  private persistPricing(): void {
    try {
      // 只存自定义的(默认表每次启动重新 seed,不必落盘)
      const defaults = new Set(CostTracker.DEFAULT_PRICING_MODELS)
      const custom: Record<string, ModelPricing> = {}
      for (const [model, price] of this.pricing) {
        if (!defaults.has(model)) custom[model] = price
      }
      fs.writeFileSync(this.pricingPath(), JSON.stringify(custom, null, 2))
    } catch (e) {
      this.log.warn('CostTracker: 定价保存失败', e)
    }
  }"""
assert old in s
s = s.replace(old, new, 1)

old = "    this.seedDefaultPricing()"
new = """    this.seedDefaultPricing()
    // 【M4-H】加载用户自定义定价(叠加在默认表之上)
    this.loadPricing()"""
assert old in s
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('OK CostTracker')

# ═══ IPC + preload ═══
p = 'electron/core/IpcServer.ts'
s = io.open(p, encoding='utf-8').read()
old = """    ipcMain.handle('skills:getEffectiveness', async () => {"""
new = """    /**
     * 【M4-H】设置模型定价 —— 让用户能给自己用的模型配价。
     * 没有这一步,不在默认表里的模型查表落空 → 成本恒 0 却看不出原因。
     */
    ipcMain.handle('insight:setPricing', async (_, payload: { model: string; inputPer1kUsd: number; outputPer1kUsd: number }) => {
      try {
        const { CostTracker } = await import('../insight/CostTracker');
        const model = String(payload?.model ?? '').trim();
        if (!model) return { success: false, error: '模型名不能为空' };
        const inputPer1kUsd = Number(payload?.inputPer1kUsd);
        const outputPer1kUsd = Number(payload?.outputPer1kUsd);
        if (!Number.isFinite(inputPer1kUsd) || !Number.isFinite(outputPer1kUsd) || inputPer1kUsd < 0 || outputPer1kUsd < 0) {
          return { success: false, error: '单价必须是非负数(每 1k token 的美元价)' };
        }
        const tracker = CostTracker.getInstance();
        tracker.setPricing(model, { inputPer1kUsd, outputPer1kUsd });
        return { success: true, data: { model, inputPer1kUsd, outputPer1kUsd } };
      } catch (error) {
        this.log.error('insight:setPricing 失败', error);
        return { success: false, error: String(error) };
      }
    });

    /** 列出已知定价(默认表 + 用户自定义) */
    ipcMain.handle('insight:getPricing', async () => {
      try {
        const { CostTracker } = await import('../insight/CostTracker');
        return { success: true, data: CostTracker.getInstance().listPricing() };
      } catch (error) {
        this.log.error('insight:getPricing 失败', error);
        return { success: false, error: String(error) };
      }
    });

    ipcMain.handle('skills:getEffectiveness', async () => {"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('OK IpcServer')

p = 'electron/preload.ts'
s = io.open(p, encoding='utf-8').read()
old = "  INSIGHT_GET_COST: 'insight:getCost',"
new = """  INSIGHT_GET_COST: 'insight:getCost',
  // 【M4-H】模型定价(用户可维护自己的模型单价)
  INSIGHT_GET_PRICING: 'insight:getPricing',
  INSIGHT_SET_PRICING: 'insight:setPricing',"""
assert old in s
s = s.replace(old, new, 1)

old = """    /** 【M3-E】今日成本 + 最近用量 */
    getCost: (): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_GET_COST),
  },"""
new = """    /** 【M3-E】今日成本 + 最近用量 */
    getCost: (): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_GET_COST),

    /** 【M4-H】已知定价(默认表 + 用户自定义) */
    getPricing: (): Promise<IpcResponse<any[]>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_GET_PRICING),

    /** 【M4-H】给自己用的模型配单价(每 1k token 的美元价) */
    setPricing: (payload: { model: string; inputPer1kUsd: number; outputPer1kUsd: number }): Promise<IpcResponse<any>> =>
      ipcRenderer.invoke(IpcChannels.INSIGHT_SET_PRICING, payload),
  },"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('OK preload')
