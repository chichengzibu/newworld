# 裁判校准测试样本（M4-J）

本目录的 JSONL 是**裁判校准**用的离线回归样本，供单元测试与人工抽查使用。

## 来源与许可

| 项 | 值 |
|---|---|
| 数据集 | `lmsys/mt_bench_human_judgments`（MT-Bench 人工裁决集） |
| 原始出处 | Zheng et al., *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*, NeurIPS 2023 Datasets & Benchmarks |
| 许可 | **CC-BY-4.0** —— 允许再分发，须署名 |
| 链接 | https://huggingface.co/datasets/lmsys/mt_bench_human_judgments |
| 本目录内容 | 由上表数据集**派生**（按 (question_id, turn, model_a, model_b) 聚合多数票、过滤歧义与平局后抽样 40 条） |

**署名（CC-BY-4.0 要求）**：本样本改编自 MT-Bench 人工裁决集，作者 Liang Zheng 等，许可 CC-BY-4.0。

## 为什么是 MT-Bench 而不是 panel

本项目实际校准用两套数据集：

- `panel`（EMNLP 2026，**CC-BY-NC-4.0 非商用**）—— 专为评测 LLM 裁判而造，1800 对人工 pairwise 标注。
  **不入仓**：非商用许可，且本项目路线图规划了「production + 半商业化」，不把非商用数据放进仓库。
  它只在开发期由 `scripts/calibration/prepare_datasets.py` 拉到 `.tmp-calibration/`（已 gitignore）。
- `mt_bench`（**CC-BY-4.0**）—— 许可宽松，且带多标注者逐票明细，可自算「人-人一致度」基线。
  本目录即它的派生样本，供仓库内离线回归。

## 字段

```jsonc
{
  "id": "mt_bench:81:1",     // 样本 id(数据集:question_id:turn)
  "dataset": "mt_bench",
  "category": "mt_bench",   // 报告里的分类别维度
  "question": "…",          // 用户提问(取该轮 user 消息)
  "answerA": "…",           // model_a 的答复
  "answerB": "…",           // model_b 的答复
  "humanLabel": "A",        // 人工多数票:A / B / tie
  "humanVotes": {"A": 2, "B": 1},  // 逐票明细
  "ambiguous": false,       // 人类内部分歧(票数分散)→ 不进严格指标
  "bothBad": false,         // 「两个都不好」(tie(bothbad))
  "license": "cc-by-4.0",
  "source": "https://huggingface.co/datasets/lmsys/mt_bench_human_judgments"
}
```

## 重新生成

```bash
python scripts/calibration/prepare_datasets.py --fixture-size 40
```
