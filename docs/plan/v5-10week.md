# PiPiClaw v4.4.0 → v5.0.0 — 10 周硬骨头路线图

> **总目标**：Agent runtime 跟 ClaudeCode 对齐 + MCP 集成 + 知识库真向量 = 能力超越 ClaudeCode 起点
> **现状**：v4.4.0 ship 完成（5 P0 安全 + 14 v4.4 视觉），总评 6.5/10
> **差距**：MCP 0% / 知识库假向量 / Agent 死代码 / 沙箱 stub / LLM 精神分裂

## M1 — v4.5.0-alpha（4 周）

| 任务 | 主导 | 周 | 关键交付 |
|---|---|---|---|
| LlmAgentBrain v0.1 | ai | 1-2 | tool call 透传 + 5 工具（Read/Edit/Bash/Glob/Grep）+ multi-turn |
| 9 P0 阻塞前 4 项 | backend | 1 | forceReset 重做 + Ed25519+TOFU + LlmClient 修复 + d5:run bug |
| LLM 抽象统一 | ai | 1 | LlmClient + ModelManager 合并，删 ModelManager 死代码 |
| MCP 调研 + PoC | mcp (新) | 1-2 | stdio transport + filesystem server PoC |

**ship**：v4.5.0-alpha → GitHub 公开（early adopter），**总评 7.5/10**

## M2 — v4.5.0-beta（4 周）

| 任务 | 主导 | 周 | 关键交付 |
|---|---|---|---|
| LlmAgentBrain v0.2 | ai | 5-6 | max_iterations + cost tracking + 流式 tool call |
| 9 P0 阻塞后 5 项 | backend | 5 | safeStorage Linux + file path 沙箱 + 未知 op deny + SkillLoader verify + ToolRegistry |
| MCP 实施 3 server | mcp | 5-8 | filesystem / github / postgres + UI 配置页 |

**ship**：v4.5.0-beta → GitHub 公开（general），**总评 8.5/10**

## M3 — v5.0.0（2 周）

| 任务 | 主导 | 周 | 关键交付 |
|---|---|---|---|
| 知识库真向量 | ai | 9-10 | sqlite-vss + bge-m3 + rerank（替换 SHA-256 假向量） |
| 沙箱起步 | backend | 9-10 | ProcessSandbox 接口 + Windows 平台分支（cgroup/Job Object） |

**ship**：v5.0.0 → production + 半商业化，**总评 9.0/10**

### M3 实际交付（2026-10-28 ~ 10-29）

| 原计划项 | 状态 | 说明 |
|---|---|---|
| bge-m3 真向量 | ✅ **已交付** | 三个真后端代码本就存在，但**零配置入口**（provider 默认伪向量、用户设不了）。现：4 个 IPC + 设置页卡片 + ollama 后端现代化（现代 `/api/embed` 批量 + 模型自动探测）+ **语义自检**。A/B 实测（本地 ollama bge-m3）：改写查询 top-1 命中 **6/6 vs 伪向量 0/6** |
| 混合检索 | ✅ **超出计划交付** | 计划里没有，但真向量接上后暴露两个硬伤：中文根本没被分词（整句成词条，改写就召不回）、两路检索**取分数最大值**（拿覆盖率比余弦）。现：CJK bigram 分词 + RRF 融合 |
| ProcessSandbox + 平台分支 | ✅ **已交付** | 实测发现 `execFile` 超时只杀直接子进程 → **孙进程变孤儿**（Windows 实测 PID 存活）。现：POSIX 进程组 / Windows `taskkill /T`，另把「用户点停止」的中止信号贯通到命令执行 |
| sqlite-vss | ⏸ **有意不做** | 当前向量库上限 200 条，桌面应用够用。换 sqlite 是**规模问题不是正确性问题**，且要引入原生依赖（构建风险） |
| rerank | ⏸ **有意不做** | 本地 ollama 0.40.11 **没有 `/api/rerank`**（实测 404），要做需另接 cross-encoder 服务（TEI/Cohere/Jina） |
| cgroup / Job Object 资源限额 | ⏸ **有意不做** | 需原生模块，与本项目**零原生依赖**取向冲突。「不产生孤儿进程」这一最高价值部分已用零依赖方式落地 |

**设计文档**：[NOVA #009 M3-A](../NOVA-#009-m3a-real-vectors-design.md) · [M3-B](../NOVA-#009-m3b-hybrid-retrieval-design.md) · [M3-C](../NOVA-#009-m3c-process-sandbox-design.md)

**下一步（未排期，按价值排序）**
1. **M4-E 技能效用的受控对照** —— 现状是观察性对比（有混杂），需同批任务随机带/不带各跑一遍
2. **Job Object / cgroup 资源限额** —— 需原生模块，作为可选增强而非硬依赖
3. **rerank** —— 需另接 cross-encoder 服务

## 节点 + ship 对象

| 节点 | 总评 | ship 给 |
|---|---|---|
| 现在 v4.4.0 | 6.5/10 | 内部 dogfooding |
| M1 v4.5.0-alpha | 7.5/10 | GitHub 公开（early adopter） |
| M2 v4.5.0-beta | 8.5/10 | GitHub 公开（general） |
| M3 v5.0.0 | 9.0/10 | production + 半商业化 |

## M1 第一波（今天启动）

| Agent | 任务 | 状态 |
|---|---|---|
| pipiclaw-ai | LlmAgentBrain v0.1 + LLM 抽象统一 | spawn now |
| pipiclaw-backend | 9 P0 阻塞前 4 项 | spawn now |
| **pipiclaw-mcp（新）** | MCP 调研 + filesystem PoC | spawn now |

verifier 每周末汇总 + 决定 ship 模式
