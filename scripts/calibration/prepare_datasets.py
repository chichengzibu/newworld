#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
New World — 裁判校准标注集准备脚本 (M4-J)
════════════════════════════════════════════════════════════════════
【它做什么】
把两份公开的人工标注数据集，下载并转成本项目统一的 pairwise JSONL 格式：

  1. EstellaCheng42/panel  —— EMNLP 2026《Panel: A Human Pairwise-Preference
     Benchmark for Open-Ended Dialogue》。专为「评测 LLM 裁判」造的数据集：
     1800 对人工 pairwise 偏好标注（3 个领域 × 600），每对带 A/B 两个模型答复
     与人工共识标签（A / B / Tie）。
     许可：CC-BY-NC-4.0（**非商用**）→ 只作开发期校准用，不入仓（仓库里
     只有 MT-Bench 派生的 fixture）。

  2. lmsys/mt_bench_human_judgments —— MT-Bench 人工裁决集（Zheng et al. 2023，
     FastChat / Chatbot Arena 的经典基准）。3355 条**多标注者**投票，
     同一对答案有多个人的裁决 → 本脚本按多数票聚成一个人工标签，
     同时把人类内部的分歧（"ambiguous"）标出来 —— 那部分不进严格指标。
     许可：CC-BY-4.0（宽松）→ 可入仓作 fixture。

【为什么不从零造标注集】
人工标注是校准的**唯一可信来源**，而自造标注集等于自己给自己出题。
本项目没有人工标注资源，因此直接采用公开高质量数据集 —— 这也是业界
(LangSmith Align Evals / DIAL / openevals) 的通行做法。

【网络现实】
本机 huggingface.co 直连超时（实测 21s 无响应），hf-mirror.com 可用。
脚本因此对两个域名都试：先官方站，再镜像站。生产/构建不依赖网络，
本脚本只在开发期跑一次。

【输出】
  .tmp-calibration/datasets/panel.jsonl        全量 1800 对（不入仓）
  .tmp-calibration/datasets/mt_bench.jsonl     全量（聚合后）（不入仓）
  tests/fixtures/judge-calibration/mt_bench-sample.jsonl   入仓 fixture（许可干净）

【用法】
  python scripts/calibration/prepare_datasets.py
  python scripts/calibration/prepare_datasets.py --fixture-size 40
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / ".tmp-calibration" / "datasets"
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "judge-calibration"

# Windows 控制台默认 GBK → 中文输出乱码。开发期脚本，统一按 UTF-8 输出。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        pass

# 镜像站优先 —— 本机实测 huggingface.co 直连超时（见文件头「网络现实」）
HF_HOSTS = ("https://hf-mirror.com", "https://huggingface.co")

PANEL_DATASET = "EstellaCheng42/panel"
PANEL_CONFIGS = ("msc", "esconv", "dream")
PANEL_LICENSE = "cc-by-nc-4.0"
PANEL_URL = "https://huggingface.co/datasets/EstellaCheng42/panel"

MTB_DATASET = "lmsys/mt_bench_human_judgments"
MTB_PARQUET = "data/human-00000-of-00001-25f4910818759289.parquet"
MTB_LICENSE = "cc-by-4.0"
MTB_URL = "https://huggingface.co/datasets/lmsys/mt_bench_human_judgments"

USER_AGENT = "newworld-calibration-prep/1.0 (+https://github.com/chichengzibu/newworld)"


# ── 下载 ────────────────────────────────────────────────────────────────
def http_get(url: str, timeout: int = 60) -> bytes:
    """GET 一个 URL；对 HF 的多个镜像站依次重试。"""
    last_err: Exception | None = None
    for host in HF_HOSTS:
        full = url.replace("https://huggingface.co", host)
        try:
            req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_err = exc
            print(f"    [retry] {full} -> {exc}")
    raise RuntimeError(f"下载失败: {url} ({last_err})")


def download_to(url: str, dest: Path, timeout: int = 120) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  [cached] {dest.name} ({dest.stat().st_size} bytes)")
        return dest
    print(f"  [get] {url}")
    data = http_get(url, timeout=timeout)
    dest.write_bytes(data)
    print(f"  [ok] {dest.name} ({len(data)} bytes)")
    return dest


# ── panel → 统一格式 ────────────────────────────────────────────────────
def normalize_panel_label(raw: str) -> str:
    """panel 的 overall 字段：A / B / Tie → 统一成 A / B / tie"""
    raw = (raw or "").strip()
    if raw.upper() == "A":
        return "A"
    if raw.upper() == "B":
        return "B"
    return "tie"


def panel_rows(config: str) -> list[dict]:
    csv_path = download_to(
        f"https://huggingface.co/datasets/{PANEL_DATASET}/resolve/main/data/{config}.csv",
        OUT_DIR / "raw" / f"panel_{config}.csv",
    )
    # UTF-8 BOM 兜底：某些导出带 BOM，会污染第一个列名
    text = csv_path.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows: list[dict] = []
    for idx, r in enumerate(reader):
        history = r.get("history") or ""
        # 末行是提问方（speaker1 / seeker / ... 各数据集角色名不同）→ 抽成 question
        last_line = ""
        for line in reversed(history.splitlines()):
            if line.strip():
                last_line = line.strip()
                break
        # "speaker1: xxx" → "xxx"；角色名保留不了（各数据集不同），只取内容
        question = last_line.split(":", 1)[1].strip() if ":" in last_line else last_line
        rows.append(
            {
                "dataset": "panel",
                "config": config,
                "id": f"panel:{config}:{idx}",
                "category": f"panel-{config}",
                "question": question,
                "history": history,
                "answerA": r.get("response_a") or "",
                "answerB": r.get("response_b") or "",
                "modelA": r.get("model_a") or "",
                "modelB": r.get("model_b") or "",
                "humanLabel": normalize_panel_label(r.get("overall") or ""),
                "humanVotes": {},          # panel 已是共识标签，无逐票明细
                "ambiguous": False,
                "labelSource": r.get("label_source") or "",
                "turn": 1,
                "license": PANEL_LICENSE,
                "source": PANEL_URL,
            }
        )
    return rows


# ── MT-Bench → 统一格式 ────────────────────────────────────────────────
def normalize_mtb_winner(raw: str) -> str:
    """MT-Bench winner: model_a / model_b / tie / tie(bothbad) → A / B / tie

    注意「tie」与「tie(bothbad)」语义不同：后者是「两个都不好」，不是「一样好」。
    归一到 tie 会让"裁判说平局"在 bothbad 样本上被读成"认可质量"——
    故聚合时把两者分开统计（votes 里保留 tie_bothbad），严格 pairwise 指标
    只看 humanLabel ∈ {A, B} 的样本。
    """
    raw = (raw or "").strip().lower()
    if raw == "model_a":
        return "A"
    if raw == "model_b":
        return "B"
    if raw == "tie(bothbad)":
        return "tie_bothbad"
    return "tie"


def mtb_rows() -> list[dict]:
    try:
        import pyarrow.parquet as pq  # noqa: PLC0415
    except ImportError:
        print("[fatal] 需要 pyarrow 读取 parquet：pip install pyarrow", file=sys.stderr)
        raise

    parquet_path = download_to(
        f"https://huggingface.co/datasets/{MTB_DATASET}/resolve/main/{MTB_PARQUET}",
        OUT_DIR / "raw" / "mt_bench_human.parquet",
    )
    table = pq.read_table(parquet_path)
    raw_rows = table.to_pylist()

    # 同一 (question_id, turn, model_a, model_b) 有多个标注者 → 聚成一条
    groups: dict[tuple, list[dict]] = {}
    for r in raw_rows:
        key = (r["question_id"], r["turn"], r["model_a"], r["model_b"])
        groups.setdefault(key, []).append(r)

    rows: list[dict] = []
    for (qid, turn, ma, mb), group in groups.items():
        votes = Counter(normalize_mtb_winner(r["winner"]) for r in group)
        top, top_n = votes.most_common(1)[0]
        total = sum(votes.values())
        # 人类内部分歧 → ambiguous（不进严格指标，但计数上报）
        ambiguous = (top_n / total) < 0.6 if total > 1 else False
        # 「两个都不好」在指标口径里等同平局，但单独标出来 —— 否则报告里
        # 「裁判说平局」会被误读成「裁判认可了这个质量」
        both_bad = top == "tie_bothbad"
        if both_bad:
            top = "tie"
        first = group[0]

        def last_user_text(conv) -> str:
            for msg in reversed(conv or []):
                if msg.get("role") == "user":
                    return msg.get("content") or ""
            return ""

        def last_assistant_text(conv) -> str:
            for msg in reversed(conv or []):
                if msg.get("role") == "assistant":
                    return msg.get("content") or ""
            return ""

        rows.append(
            {
                "dataset": "mt_bench",
                "config": "default",
                # id 必须**全局唯一**:同一 (question_id, turn) 下有多个模型对
                # (6 个模型两两组合 → 同一题最多 15 对)。只用 qid:turn 会撞号,
                # 撞号后校准侧的 itemById 映射会取到**另一对**的样本 →
                # 那几条是对着错的题算的一致度(实跑踩到:240 条只有 185 个唯一 id)。
                "id": f"mt_bench:{qid}:{turn}:{ma}_vs_{mb}",
                "category": "mt_bench",
                "question": last_user_text(first.get("conversation_a")),
                "history": "",
                "answerA": last_assistant_text(first.get("conversation_a")),
                "answerB": last_assistant_text(first.get("conversation_b")),
                "modelA": ma,
                "modelB": mb,
                "humanLabel": top,
                "humanVotes": dict(votes),
                "ambiguous": ambiguous,
                "bothBad": both_bad,
                "labelSource": f"{total} annotator(s)",
                "turn": turn,
                "license": MTB_LICENSE,
                "source": MTB_URL,
            }
        )
    return rows


# ── 输出 ────────────────────────────────────────────────────────────────
def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"  [write] {path.relative_to(REPO_ROOT)} ({len(rows)} rows)")


def summarize(name: str, rows: list[dict]) -> None:
    labels = Counter(r["humanLabel"] for r in rows)
    ambiguous = sum(1 for r in rows if r["ambiguous"])
    # A 位模型分布 —— 若 A 位偏斜（例如总是同一个模型），位置偏置会系统性偏向该模型
    a_models = Counter(r["modelA"] for r in rows)
    print(f"  {name}: n={len(rows)} labels={dict(labels)} ambiguous={ambiguous}")
    print(f"    A 位模型分布={dict(a_models)}")


def main() -> int:
    ap = argparse.ArgumentParser(description="准备裁判校准标注集")
    ap.add_argument("--fixture-size", type=int, default=40, help="入仓 fixture 条数（MT-Bench 派生）")
    ap.add_argument("--skip-fixture", action="store_true", help="不写 fixture")
    args = ap.parse_args()

    print("== 准备 panel ==")
    panel: list[dict] = []
    for cfg in PANEL_CONFIGS:
        got = panel_rows(cfg)
        print(f"  {cfg}: {len(got)} rows")
        panel.extend(got)
    write_jsonl(OUT_DIR / "panel.jsonl", panel)
    summarize("panel", panel)

    print("== 准备 mt_bench ==")
    mtb = mtb_rows()
    write_jsonl(OUT_DIR / "mt_bench.jsonl", mtb)
    summarize("mt_bench", mtb)

    if not args.skip_fixture:
        # fixture 只取 MT-Bench（CC-BY-4.0 许可宽松，可入仓）；
        # 抽样规则：A/B 对半 + 非 tie 标签 + 排除歧义 → 保证 fixture 有区分度
        pool = [
            r
            for r in mtb
            if r["humanLabel"] in ("A", "B") and not r["ambiguous"] and r["answerA"] and r["answerB"]
        ]
        pool.sort(key=lambda r: r["id"])
        half = args.fixture_size // 2
        a_side = pool[0::2][:half]
        b_side = pool[1::2][: args.fixture_size - half]
        fixture = sorted(a_side + b_side, key=lambda r: r["id"])
        write_jsonl(FIXTURE_DIR / "mt_bench-sample.jsonl", fixture)
        summarize("fixture", fixture)

    print("\n完成。下一步：跑校准（见 tests/integration/judge-calibration-live.test.ts）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
