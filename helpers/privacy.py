# DO NOT EDIT — copied from projects/profile-to-html-resume/helpers/privacy.py
#!/usr/bin/env python3
"""Sensitive-data detection (NF-1).

Scans a canonical resume JSON for likely sensitive fields and prints
a JSON list of hits. Exit 0 always; callers decide what to prompt.
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any


TW_ID_RE = re.compile(r"\b[A-Z][12]\d{8}\b")
SALARY_RE = re.compile(r"(月薪|年薪|salary|薪資)[^\n]*\d", re.IGNORECASE)
ADDRESS_RE = re.compile(r"(?:\d+號|室|樓|弄|巷|街|路)", re.UNICODE)


def _walk(obj: Any, path: str, hits: list[dict[str, str]]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            _walk(v, f"{path}.{k}" if path else k, hits)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _walk(v, f"{path}[{i}]", hits)
    elif isinstance(obj, str):
        if TW_ID_RE.search(obj):
            hits.append({"path": path, "reason": "TW national id", "sample": obj[:30]})
        if SALARY_RE.search(obj):
            hits.append({"path": path, "reason": "salary figure", "sample": obj[:40]})
        if ADDRESS_RE.search(obj) and len(obj) > 10:
            hits.append({"path": path, "reason": "home address", "sample": obj[:40]})


def scan(data: dict[str, Any]) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    _walk(data, "", hits)
    return hits


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: privacy.py <canonical.json>", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    hits = scan(data)
    json.dump({"hits": hits}, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
