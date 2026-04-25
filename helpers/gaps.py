# DO NOT EDIT — copied from projects/profile-to-html-resume/helpers/gaps.py
#!/usr/bin/env python3
"""Gap detection (AC-8, AC-9).

Rules:
  R1 Missing summary       — summary empty or <40 chars
  R2 Thin bullet           — any experience has empty bullets or any bullet <20 chars
  R3 No quantification     — experience has bullets but none contain a number/metric
  R4 Unexplained gap       — gap >6 months between adjacent experiences
  R5 Missing dates         — experience start or end is null (and not 'present')
  R6 Empty skills          — skills.length < 3
  R7 Missing headline      — headline empty or <10 chars

Question priority (AC-9): R1 > R7 > R2 > R6 > R3 > R5 > R4

Output JSON list of questions (already sorted), each:
  {"id", "rule", "text", "target_path"}

Usage:
  gaps.py <canonical.json> [--max N]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any


PRIORITY = ["R1", "R7", "R2", "R6", "R3", "R5", "R4"]


_QUANT_RE = re.compile(
    r"\d+%|\d+[KkMm]?|\d+\s*(?:人|件|倍|天|月|年|users?|customers?|requests?)",
)


def _parse_ym(s: str | None) -> tuple[int, int] | None:
    if not s:
        return None
    if s == "present":
        return None
    m = re.match(r"(\d{4})-(\d{1,2})$", s)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.match(r"(\d{4})$", s)
    if m:
        return int(m.group(1)), 12
    return None


def _months_between(a: tuple[int, int], b: tuple[int, int]) -> int:
    return (b[0] - a[0]) * 12 + (b[1] - a[1])


def detect(data: dict[str, Any]) -> list[dict[str, Any]]:
    questions: list[dict[str, Any]] = []

    summary = (data.get("summary") or "").strip()
    if len(summary) < 40:
        questions.append(
            {
                "id": "q_summary",
                "rule": "R1",
                "text": "請用 2–3 句寫一段 summary（你的專長定位與核心價值）。",
                "target_path": "summary",
            }
        )

    headline = (data.get("headline") or "").strip()
    if len(headline) < 10:
        questions.append(
            {
                "id": "q_headline",
                "rule": "R7",
                "text": "請補一句 headline（例：資深前端工程師 / React 專長 / 金融業 8 年）— 用來做定位。",
                "target_path": "headline",
            }
        )

    experiences = data.get("experiences") or []

    # R2: thin bullets
    for i, exp in enumerate(experiences):
        bullets = exp.get("bullets") or []
        if not bullets or any(len((b or "").strip()) < 20 for b in bullets):
            title = exp.get("title") or exp.get("company") or f"第 {i+1} 段"
            questions.append(
                {
                    "id": f"q_bullet_{i}",
                    "rule": "R2",
                    "text": f"「{title}」的職責/成果描述偏短，請補 1–3 條具體 bullet（每條 >20 字）。",
                    "target_path": f"experiences[{i}].bullets",
                }
            )

    # R6: empty skills
    skills = data.get("skills") or []
    if len(skills) < 3:
        questions.append(
            {
                "id": "q_skills",
                "rule": "R6",
                "text": "請列 5–10 項核心技能（用逗號分隔，例：Python, React, SQL, Docker, AWS）。",
                "target_path": "skills",
            }
        )

    # R3: no quantification
    for i, exp in enumerate(experiences):
        bullets = exp.get("bullets") or []
        if bullets and not any(_QUANT_RE.search(b or "") for b in bullets):
            title = exp.get("title") or exp.get("company") or f"第 {i+1} 段"
            questions.append(
                {
                    "id": f"q_quant_{i}",
                    "rule": "R3",
                    "text": f"「{title}」缺乏量化成果，請補一個帶數字的指標（例：提升轉換率 30%、服務 5000 用戶）。",
                    "target_path": f"experiences[{i}].bullets",
                }
            )

    # R5: missing dates
    for i, exp in enumerate(experiences):
        missing = []
        if not exp.get("start"):
            missing.append("start")
        end = exp.get("end")
        if end is None:
            missing.append("end")
        if missing:
            title = exp.get("title") or exp.get("company") or f"第 {i+1} 段"
            questions.append(
                {
                    "id": f"q_dates_{i}",
                    "rule": "R5",
                    "text": f"「{title}」缺少日期（{', '.join(missing)}），請給 YYYY-MM 格式（或 present）。",
                    "target_path": f"experiences[{i}]",
                }
            )

    # R4: unexplained gaps
    dated = [(i, _parse_ym(e.get("start")), _parse_ym(e.get("end")) or (9999, 12) if e.get("end") == "present" else _parse_ym(e.get("end")))
             for i, e in enumerate(experiences)]
    # sort ascending by start date
    dated_sorted = sorted(
        [(i, s, e) for i, s, e in dated if s is not None and e is not None],
        key=lambda x: x[1],
    )
    for j in range(1, len(dated_sorted)):
        prev = dated_sorted[j - 1]
        curr = dated_sorted[j]
        if prev[2] == (9999, 12):  # present — no gap possible
            continue
        gap = _months_between(prev[2], curr[1])
        if gap > 6:
            questions.append(
                {
                    "id": f"q_gap_{prev[0]}_{curr[0]}",
                    "rule": "R4",
                    "text": f"第 {prev[0]+1} 段結束到第 {curr[0]+1} 段開始之間有 {gap} 個月空白期，可說明（進修 / 轉職準備 / 個人）嗎？",
                    "target_path": f"experiences[{curr[0]}]",
                }
            )

    # sort by priority
    order = {r: i for i, r in enumerate(PRIORITY)}
    questions.sort(key=lambda q: (order.get(q["rule"], 99), q["id"]))
    return questions


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--max", type=int, default=5)
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as f:
        data = json.load(f)

    qs = detect(data)
    limited = qs[: args.max]
    deferred = qs[args.max :]
    out = {"questions": limited, "deferred": deferred, "total_detected": len(qs)}
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
