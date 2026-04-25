# DO NOT EDIT — copied from projects/profile-to-html-resume/helpers/render.py
#!/usr/bin/env python3
"""Render canonical resume JSON + answers into a single-file HTML.

Usage:
  render.py --data canonical.json [--answers answers.json] \
            --template modern-minimal|colorful [--outdir <dir>]

Writes to <outdir>/resume-<slug>.html (auto -v2, -v3 on collision).
Prints final path to stdout.
"""
from __future__ import annotations

import argparse
import html as html_mod
import json
import os
import re
import sys
from typing import Any


HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.normpath(os.path.join(HERE, "..", "templates"))


def slugify(name: str | None) -> str:
    if not name:
        return "resume"
    s = re.sub(r"[^\w一-鿿\-]+", "-", name, flags=re.UNICODE).strip("-")
    return s.lower() or "resume"


def esc(s: Any) -> str:
    if s is None:
        return ""
    return html_mod.escape(str(s), quote=True)


def fmt_date_range(start: str | None, end: str | None) -> str:
    if not start and not end:
        return ""
    s = start or ""
    e = "present" if end == "present" else (end or "")
    if s and e:
        return f"{s} – {e}"
    return s or e


def apply_answers(data: dict[str, Any], answers: dict[str, str] | None,
                  deferred: list[dict[str, Any]] | None) -> tuple[dict[str, Any], list[str]]:
    """Merge answered Qs into data. Return (merged, todos).

    todos = list of HTML-safe TODO strings to render as comments.
    """
    answers = answers or {}
    deferred = deferred or []
    merged = json.loads(json.dumps(data))
    todos: list[str] = []

    def write_target(path: str, value: str) -> None:
        # very small path subset: 'summary' | 'headline' | 'skills'
        # | 'experiences[i].bullets' | 'experiences[i]'
        if path in ("summary", "headline"):
            merged[path] = value
            return
        if path == "skills":
            parts = [p.strip() for p in re.split(r"[,，、;；/／\n]+", value) if p.strip()]
            if parts:
                merged["skills"] = parts
            return
        m = re.match(r"experiences\[(\d+)\]\.bullets", path)
        if m:
            i = int(m.group(1))
            if i < len(merged["experiences"]):
                lines = [ln.strip(" •·-*").strip() for ln in value.splitlines() if ln.strip()]
                if not lines:
                    lines = [value.strip()]
                base = merged["experiences"][i].get("bullets") or []
                merged["experiences"][i]["bullets"] = base + lines
            return
        m = re.match(r"experiences\[(\d+)\]$", path)
        if m:
            i = int(m.group(1))
            if i < len(merged["experiences"]):
                # store as a note bullet
                base = merged["experiences"][i].get("bullets") or []
                merged["experiences"][i]["bullets"] = base + [value.strip()]
            return

    # deferred unanswered → TODO comments
    for q in deferred:
        todos.append(f"TODO ({q.get('rule')}): {q.get('text')}")

    for qid, ans in answers.items():
        if not isinstance(ans, dict):
            continue
        text = (ans.get("answer") or "").strip()
        target = ans.get("target_path") or ""
        if text in ("", "跳過", "不知道", "skip"):
            rule = ans.get("rule") or ""
            text_q = ans.get("text") or qid
            todos.append(f"TODO ({rule}): {text_q}")
            continue
        if target:
            write_target(target, text)

    return merged, todos


def render_experiences(data: dict[str, Any]) -> str:
    items = []
    exps = data.get("experiences") or []
    # reverse chronological: sort by end/start desc
    def sort_key(e: dict[str, Any]) -> str:
        end = e.get("end") or ""
        if end == "present":
            return "9999"
        return end or e.get("start") or ""
    sorted_exps = sorted(exps, key=sort_key, reverse=True)
    for e in sorted_exps:
        bullets = "".join(f"<li>{esc(b)}</li>" for b in (e.get("bullets") or []))
        bullets_html = f"<ul class='bullets'>{bullets}</ul>" if bullets else ""
        loc = esc(e.get("location")) if e.get("location") else ""
        loc_html = f" <span class='loc'>{loc}</span>" if loc else ""
        items.append(
            f"<div class='exp'>"
            f"<div class='exp-head'>"
            f"<span class='exp-title'>{esc(e.get('title'))}</span>"
            f"<span class='exp-sep'>｜</span>"
            f"<span class='exp-company'>{esc(e.get('company'))}</span>"
            f"{loc_html}"
            f"<span class='exp-date'>{esc(fmt_date_range(e.get('start'), e.get('end')))}</span>"
            f"</div>"
            f"{bullets_html}"
            f"</div>"
        )
    return "".join(items)


def render_education(data: dict[str, Any]) -> str:
    items = []
    for e in data.get("education") or []:
        degree = " – ".join(filter(None, [e.get("degree"), e.get("field")]))
        degree_html = f" <span class='edu-degree'>{esc(degree)}</span>" if degree else ""
        items.append(
            f"<div class='edu'>"
            f"<span class='edu-school'>{esc(e.get('school'))}</span>"
            f"{degree_html}"
            f"<span class='edu-date'>{esc(fmt_date_range(e.get('start'), e.get('end')))}</span>"
            f"</div>"
        )
    return "".join(items)


def render_skills(data: dict[str, Any]) -> str:
    skills = data.get("skills") or []
    if not skills:
        return ""
    return "".join(f"<span class='skill'>{esc(s)}</span>" for s in skills)


def render_languages(data: dict[str, Any]) -> str:
    langs = data.get("languages") or []
    if not langs:
        return ""
    items = []
    for l in langs:
        level = f" ({esc(l.get('level'))})" if l.get("level") else ""
        items.append(f"<li>{esc(l.get('name'))}{level}</li>")
    return f"<ul>{''.join(items)}</ul>"


def render_certifications(data: dict[str, Any]) -> str:
    certs = data.get("certifications") or []
    if not certs:
        return ""
    items = []
    for c in certs:
        bits = [c.get("name")]
        if c.get("issuer"):
            bits.append(c.get("issuer"))
        if c.get("date"):
            bits.append(c.get("date"))
        items.append(f"<li>{esc(' · '.join(b for b in bits if b))}</li>")
    return f"<ul>{''.join(items)}</ul>"


def render_contact(data: dict[str, Any]) -> str:
    c = data.get("contact") or {}
    parts = []
    if c.get("email"):
        parts.append(f"<a href='mailto:{esc(c['email'])}'>{esc(c['email'])}</a>")
    if c.get("phone"):
        parts.append(esc(c["phone"]))
    if c.get("location"):
        parts.append(esc(c["location"]))
    for link in (c.get("links") or [])[:5]:
        parts.append(f"<a href='{esc(link)}'>{esc(link)}</a>")
    return " · ".join(parts)


SECTIONS: list[tuple[str, str, callable]] = [
    ("summary", "Summary", lambda d: f"<p>{esc(d.get('summary'))}</p>" if d.get("summary") else ""),
    ("experience", "Experience", render_experiences),
    ("education", "Education", render_education),
    ("skills", "Skills", lambda d: f"<div class='skills-wrap'>{render_skills(d)}</div>" if d.get("skills") else ""),
    ("languages", "Languages", render_languages),
    ("certifications", "Certifications", render_certifications),
]

# Per-template split: which section keys go in the sidebar (colorful only).
# modern-minimal is single-column, so SIDEBAR_KEYS is empty.
SIDEBAR_KEYS_BY_TEMPLATE = {
    "colorful": {"skills", "languages", "certifications"},
    "modern-minimal": set(),
    "academic-serif": set(),
}


def _render_section(key: str, label: str, fn, data: dict[str, Any]) -> str:
    content = fn(data)
    if not content.strip():
        return ""
    return (
        f"<section class='sec sec-{key}'>"
        f"<h2>{label}</h2>"
        f"{content}"
        f"</section>"
    )


def build_sections(data: dict[str, Any], sidebar_keys: set[str] | None = None) -> tuple[str, str]:
    """Return (main_html, sidebar_html). If sidebar_keys is empty, sidebar_html is ''."""
    sidebar_keys = sidebar_keys or set()
    main_out = []
    side_out = []
    for key, label, fn in SECTIONS:
        rendered = _render_section(key, label, fn, data)
        if not rendered:
            continue
        (side_out if key in sidebar_keys else main_out).append(rendered)
    return "\n".join(main_out), "\n".join(side_out)


def load_template(name: str) -> str:
    path = os.path.join(TEMPLATE_DIR, f"{name}.html")
    with open(path, encoding="utf-8") as f:
        return f.read()


def render_html(data: dict[str, Any], template: str, todos: list[str]) -> str:
    tpl = load_template(template)
    headline_html = (
        f"<p class='headline'>{esc(data.get('headline'))}</p>"
        if data.get("headline") else ""
    )
    header = (
        f"<h1 class='name'>{esc(data.get('name'))}</h1>"
        f"{headline_html}"
        f"<p class='contact'>{render_contact(data)}</p>"
    )
    sidebar_keys = SIDEBAR_KEYS_BY_TEMPLATE.get(template, set())
    main_html, sidebar_html = build_sections(data, sidebar_keys)
    todo_comments = "\n".join(f"<!-- {esc(t)} -->" for t in todos)
    out = tpl.replace("{{HEADER}}", header)
    # New colorful placeholders + legacy single-column placeholder for modern-minimal
    out = out.replace("{{MAIN_SECTIONS}}", main_html)
    out = out.replace("{{SIDEBAR_SECTIONS}}", sidebar_html)
    out = out.replace("{{SECTIONS}}", main_html)
    out = out.replace("{{TODOS}}", todo_comments)
    return out


def unique_path(outdir: str, base_slug: str) -> str:
    path = os.path.join(outdir, f"resume-{base_slug}.html")
    if not os.path.exists(path):
        return path
    i = 2
    while True:
        candidate = os.path.join(outdir, f"resume-{base_slug}-v{i}.html")
        if not os.path.exists(candidate):
            return candidate
        i += 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--answers", default=None)
    ap.add_argument("--template", choices=["modern-minimal", "colorful", "academic-serif"], default="modern-minimal")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()

    with open(args.data, encoding="utf-8") as f:
        data = json.load(f)

    answers_obj = None
    deferred = None
    if args.answers:
        with open(args.answers, encoding="utf-8") as f:
            ao = json.load(f)
        answers_obj = ao.get("answers") or ao
        deferred = ao.get("deferred")

    merged, todos = apply_answers(data, answers_obj, deferred)
    html = render_html(merged, args.template, todos)

    slug = slugify(merged.get("name"))
    os.makedirs(args.outdir, exist_ok=True)
    path = unique_path(args.outdir, slug)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)

    size = os.path.getsize(path)
    print(json.dumps({"path": path, "size": size, "slug": slug}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
