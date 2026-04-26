# DO NOT EDIT — copied from projects/profile-to-html-resume/helpers/parse.py
#!/usr/bin/env python3
"""Parse profile input into canonical JSON (AC-5 schema).

Supports 5 input kinds (AC-4):
  linkedin-url, 104-url, html-paste, linkedin-zip, text-paste

Usage:
  parse.py --kind <kind> --input <path>
  parse.py --auto --input <path> [--pretty]

URL kinds expect the caller to pre-fetch the HTML; this script does not
do network I/O. If `--kind linkedin-url` / `104-url` is passed with a
plain HTML file, it parses the HTML and records the source accordingly.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import zipfile
from html.parser import HTMLParser
from typing import Any


EMPTY_RESUME: dict[str, Any] = {
    "name": None,
    "headline": None,
    "summary": None,
    "contact": {"email": None, "phone": None, "location": None, "links": []},
    "experiences": [],
    "education": [],
    "skills": [],
    "languages": [],
    "certifications": [],
    "_source": None,
    "_missing": [],
}


# ----------------------------- helpers ------------------------------


class _TextExtractor(HTMLParser):
    """Collect visible text from HTML, grouped by block boundaries."""

    _BLOCK = {
        "p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6",
        "section", "article", "header", "footer", "tr", "td", "th",
    }

    def __init__(self) -> None:
        super().__init__()
        self.chunks: list[str] = []
        self._buf: list[str] = []
        self._skip = 0
        self._li_depth = 0

    _HIDE = {"script", "style", "head", "title", "noscript", "svg"}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._HIDE:
            self._skip += 1
        if tag in self._BLOCK:
            self._flush()
        if tag == "li":
            self._li_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self._HIDE and self._skip:
            self._skip -= 1
        if tag == "li" and self._li_depth:
            # mark buffered li content with a leading bullet char
            if self._buf:
                self._buf.insert(0, "•")
            self._li_depth -= 1
        if tag in self._BLOCK:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        t = data.strip()
        if t:
            self._buf.append(t)

    def _flush(self) -> None:
        if self._buf:
            self.chunks.append(" ".join(self._buf))
            self._buf = []

    def finish(self) -> list[str]:
        self._flush()
        return [c for c in self.chunks if c]


def html_to_lines(html: str) -> list[str]:
    p = _TextExtractor()
    p.feed(html)
    return p.finish()


_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_RE = re.compile(r"(\+?\d[\d\s\-()]{7,}\d)")
_URL_RE = re.compile(r"https?://[^\s<>\"']+")
_DATE_RANGE_RE = re.compile(
    r"(\d{4}(?:[./-]\d{1,2})?)\s*(?:年)?\s*(?:[-–—~至~到]|to|present)\s*"
    r"(present|現在|迄今|\d{4}(?:[./-]\d{1,2})?)",
    re.IGNORECASE,
)


def norm_date(s: str | None) -> str | None:
    if not s:
        return None
    s = s.strip().lower()
    if s in ("present", "現在", "迄今", "now", "至今"):
        return "present"
    m = re.match(r"(\d{4})[./-](\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    m = re.match(r"(\d{4})年(\d{1,2})月?", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    m = re.match(r"(\d{4})", s)
    if m:
        return m.group(1)
    return None


def slugify(name: str | None) -> str:
    if not name:
        return "resume"
    s = re.sub(r"[^\w一-鿿\-]+", "-", name, flags=re.UNICODE).strip("-")
    return s or "resume"


# --------------------------- plaintext parser ------------------------

_SECTION_HEADERS = {
    "summary": {"summary", "about", "自我介紹", "簡介", "自傳", "關於我"},
    "experience": {"experience", "work experience", "工作經歷", "經歷", "職涯", "employment"},
    "education": {"education", "學歷", "教育"},
    "skills": {"skills", "技能", "專長", "skill"},
    "languages": {"languages", "語言能力", "語言"},
    "certifications": {"certifications", "certificates", "證照", "認證"},
}


def _classify_header(line: str) -> str | None:
    norm = line.strip().lower().rstrip(":：")
    for key, alts in _SECTION_HEADERS.items():
        if norm in alts:
            return key
    return None


def parse_plaintext(text: str) -> dict[str, Any]:
    data = json.loads(json.dumps(EMPTY_RESUME))
    lines = [ln.rstrip() for ln in text.splitlines()]

    # name = first non-empty line (heuristic)
    # headline = second non-empty line if not a section header
    header_lines = []
    for ln in lines:
        t = ln.strip()
        if t:
            header_lines.append(t)
        if len(header_lines) >= 4:
            break
    if header_lines:
        data["name"] = header_lines[0]
    if len(header_lines) > 1 and _classify_header(header_lines[1]) is None:
        data["headline"] = header_lines[1]

    # contact from whole text
    text_all = "\n".join(lines)
    m = _EMAIL_RE.search(text_all)
    if m:
        data["contact"]["email"] = m.group(0)
    m = _PHONE_RE.search(text_all)
    if m:
        data["contact"]["phone"] = m.group(0).strip()
    data["contact"]["links"] = list(dict.fromkeys(_URL_RE.findall(text_all)))

    # Section split (preserve blank lines as they act as entry separators)
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for ln in lines:
        key = _classify_header(ln)
        if key:
            current = key
            sections.setdefault(current, [])
            continue
        if current is not None:
            sections[current].append(ln.rstrip())

    if "summary" in sections:
        data["summary"] = " ".join(l.strip() for l in sections["summary"] if l.strip()) or None

    if "experience" in sections:
        data["experiences"] = _parse_experience_block(sections["experience"])

    if "education" in sections:
        data["education"] = _parse_education_block(sections["education"])

    if "skills" in sections:
        skills_text = " ".join(sections["skills"])
        parts = re.split(r"[,，、;；\n]+", skills_text)
        data["skills"] = [s.strip() for s in parts if s.strip()]

    if "languages" in sections:
        for ln in sections["languages"]:
            t = ln.strip(" •·-*")
            if not t:
                continue
            m = re.match(r"([^\s,，:：\-（(]+)\s*[-:：()（]?\s*(.*)", t)
            if m:
                data["languages"].append({"name": m.group(1).strip(), "level": (m.group(2).strip(" )）") or None)})

    if "certifications" in sections:
        for ln in sections["certifications"]:
            t = ln.strip(" •·-*")
            if t:
                data["certifications"].append({"name": t, "issuer": None, "date": None})

    data["_source"] = "text-paste"
    return data


_BULLET_RE = re.compile(r"^\s*[-*•·●◦▪]\s+")


_SINGLE_YEAR_PAREN_RE = re.compile(r"[(（]\s*(\d{4})(?:\s*[/-]\s*(\d{1,2}))?\s*[)）]")


def _split_head_line(head: str) -> tuple[str | None, str | None, str | None, str | None]:
    """Return (title, company, start, end).

    Only returns title/company if a clear separator is present in the
    line. Lines without a separator return (None, None, dates...) and
    the caller decides positionally.
    """
    start = end = None
    m = _DATE_RANGE_RE.search(head)
    if m:
        start = norm_date(m.group(1))
        end = norm_date(m.group(2))
        head = (head[: m.start()] + head[m.end():])
    else:
        m2 = _SINGLE_YEAR_PAREN_RE.search(head)
        if m2:
            y = m2.group(1)
            mo = m2.group(2)
            start = f"{y}-{int(mo):02d}" if mo else y
            head = (head[: m2.start()] + head[m2.end():])
    head = head.strip(" -–—|,，·(（)）")

    title = company = None
    for sep in (" @ ", " @ ", "｜", " - ", " – "):
        if sep in head:
            a, b = head.split(sep, 1)
            title, company = a.strip(" (（)）"), b.strip(" )）(（")
            return title, company, start, end
    # Less-reliable single-char separators: only use if head has spaces on both sides
    for sep in ("|", "/"):
        if sep in head and head.count(sep) == 1:
            a, b = head.split(sep, 1)
            if a.strip() and b.strip():
                return a.strip(" (（)）"), b.strip(" )）(（"), start, end
    return None, None, start, end


def _parse_experience_block(lines: list[str]) -> list[dict[str, Any]]:
    """Anchor-driven: any line containing a date range is an anchor;
    the 1-2 preceding non-bullet lines form the title/company header,
    and subsequent lines (until next anchor or end) are bullets.

    Also supports blank-line-separated block form (plaintext).
    """
    # Collapse: drop leading empties; preserve internal structure.
    lines = [ln for ln in lines]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return []

    # Find anchors: indices of lines containing a date range.
    anchors = [i for i, ln in enumerate(lines) if _DATE_RANGE_RE.search(ln)]

    entries: list[tuple[int, int]] = []  # (header_start_idx, block_end_idx exclusive)

    if anchors:
        for ai, idx in enumerate(anchors):
            # header starts: walk upward over non-bullet, non-empty lines
            header_start = idx
            while header_start - 1 >= 0:
                prev = lines[header_start - 1]
                if not prev.strip():
                    break
                if _BULLET_RE.match(prev):
                    break
                # if previous is another anchor, stop
                if (header_start - 1) in anchors:
                    break
                header_start -= 1
                if idx - header_start >= 3:  # cap lookback at 3 lines
                    break
            # block end: up to but not including next header_start
            if ai + 1 < len(anchors):
                next_header_start = anchors[ai + 1]
                # same walk from next anchor
                ns = next_header_start
                while ns - 1 > idx:
                    prev = lines[ns - 1]
                    if not prev.strip():
                        break
                    if _BULLET_RE.match(prev):
                        break
                    ns -= 1
                    if next_header_start - ns >= 3:
                        break
                block_end = ns
            else:
                block_end = len(lines)
            entries.append((header_start, block_end))
    else:
        # Fallback: blank-line separated blocks
        cur_start = None
        for i, ln in enumerate(lines):
            if ln.strip():
                if cur_start is None:
                    cur_start = i
            else:
                if cur_start is not None:
                    entries.append((cur_start, i))
                    cur_start = None
        if cur_start is not None:
            entries.append((cur_start, len(lines)))

    out = []
    for start_idx, end_idx in entries:
        block = [ln for ln in lines[start_idx:end_idx] if ln.strip()]
        if not block:
            continue

        # Find anchor within block (if any) to identify header lines
        anchor_in_block = None
        for i, ln in enumerate(block):
            if _DATE_RANGE_RE.search(ln):
                anchor_in_block = i
                break

        if anchor_in_block is None:
            header_lines = [block[0]]
            bullet_lines = block[1:]
        else:
            header_lines = block[: anchor_in_block + 1]
            bullet_lines = block[anchor_in_block + 1:]

        # Combine header lines for parsing
        title = company = loc = None
        d_start = d_end = None
        for hl in header_lines:
            t, c, s, e = _split_head_line(hl)
            if s and not d_start:
                d_start = s
            if e and not d_end:
                d_end = e
            if t and not title:
                title = t
            if c and not company:
                company = c
            # If no sep in this line, but title/company both not yet set, take as single
            if not t and not c and hl.strip():
                stripped = hl.strip()
                stripped = _DATE_RANGE_RE.sub("", stripped).strip(" -–—|,，·(（)）")
                if stripped:
                    # location marker "·" splits out location
                    if "·" in stripped:
                        parts = [p.strip() for p in stripped.split("·") if p.strip()]
                        stripped = parts[0]
                        if len(parts) > 1 and not loc:
                            loc = parts[1]
                    if not title:
                        title = stripped
                    elif not company:
                        company = stripped

        bullets = []
        for ln in bullet_lines:
            t = _BULLET_RE.sub("", ln).strip()
            if t:
                bullets.append(t)

        out.append(
            {
                "company": company,
                "title": title,
                "start": d_start,
                "end": d_end,
                "bullets": bullets,
                "location": loc,
            }
        )
    return out


def _parse_education_block(lines: list[str]) -> list[dict[str, Any]]:
    out = []
    for ln in lines:
        t = ln.strip(" •·-*")
        if not t:
            continue
        start = end = None
        m = _DATE_RANGE_RE.search(t)
        if m:
            start = norm_date(m.group(1))
            end = norm_date(m.group(2))
            t = t[: m.start()].rstrip(" ,，-–—")
        school = t
        degree = field = None
        for sep in (",", "，", " - ", " – ", "｜", "|"):
            if sep in t:
                parts = [p.strip() for p in t.split(sep)]
                school = parts[0]
                if len(parts) >= 2:
                    degree = parts[1]
                if len(parts) >= 3:
                    field = parts[2]
                break
        out.append(
            {
                "school": school or None,
                "degree": degree,
                "field": field,
                "start": start,
                "end": end,
            }
        )
    return out


# --------------------------- html parsers ----------------------------

def parse_html_generic(html: str, source_tag: str) -> dict[str, Any]:
    """Collapse HTML to text lines and feed to plaintext parser, plus
    pull links/emails from raw HTML."""
    lines = html_to_lines(html)
    text = "\n".join(lines)
    data = parse_plaintext(text)

    raw_links = _URL_RE.findall(html)
    data["contact"]["links"] = _filter_contact_links(data["contact"]["links"] + raw_links)[:5]

    # title tag -> headline fallback
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    if m and not data.get("headline"):
        data["headline"] = re.sub(r"\s+", " ", m.group(1)).strip() or None

    data["_source"] = source_tag
    return data


def _filter_contact_links(links: list[str]) -> list[str]:
    allowed_hosts = {
        "github.com",
        "gitlab.com",
        "linkedin.com",
        "www.linkedin.com",
        "medium.com",
        "newway-explore.com",
        "www.newway-explore.com",
    }
    blocked_hosts = {
        "apps.apple.com",
        "www.youtube.com",
        "youtube.com",
        "youtu.be",
        "pda.104.com.tw",
        "104.com.tw",
        "www.googletagmanager.com",
        "connect.facebook.net",
        "player.vimeo.com",
    }
    out: list[str] = []
    seen: set[str] = set()
    for raw in links:
        m = re.match(r"https?://([^/]+)/?", raw.strip(), re.I)
        if not m:
            continue
        host = m.group(1).lower()
        is_allowed = host in allowed_hosts or host.endswith(".github.io")
        is_blocked = host in blocked_hosts or host.endswith(".104.com.tw")
        if not is_allowed or is_blocked:
            continue
        if raw not in seen:
            seen.add(raw)
            out.append(raw)
    return out


def parse_linkedin_zip(path: str) -> dict[str, Any]:
    data = json.loads(json.dumps(EMPTY_RESUME))
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()

        def read(name: str) -> str | None:
            hits = [n for n in names if n.lower().endswith(name.lower())]
            if not hits:
                return None
            with zf.open(hits[0]) as f:
                return f.read().decode("utf-8", errors="replace")

        profile_csv = read("Profile.csv")
        if profile_csv:
            reader = csv.DictReader(io.StringIO(profile_csv))
            row = next(reader, None)
            if row:
                first = (row.get("First Name") or "").strip()
                last = (row.get("Last Name") or "").strip()
                full = f"{first} {last}".strip()
                data["name"] = full or None
                data["headline"] = (row.get("Headline") or "").strip() or None
                data["summary"] = (row.get("Summary") or "").strip() or None
                data["contact"]["location"] = (
                    row.get("Geo Location") or row.get("Address") or ""
                ).strip() or None

        email_csv = read("Email Addresses.csv")
        if email_csv:
            reader = csv.DictReader(io.StringIO(email_csv))
            for row in reader:
                em = (row.get("Email Address") or "").strip()
                if em:
                    data["contact"]["email"] = em
                    break

        phone_csv = read("PhoneNumbers.csv")
        if phone_csv:
            reader = csv.DictReader(io.StringIO(phone_csv))
            for row in reader:
                num = (row.get("Number") or "").strip()
                if num:
                    data["contact"]["phone"] = num
                    break

        pos_csv = read("Positions.csv")
        if pos_csv:
            reader = csv.DictReader(io.StringIO(pos_csv))
            for row in reader:
                desc = (row.get("Description") or "").strip()
                bullets = [b.strip(" •·-*") for b in re.split(r"[\r\n]+", desc) if b.strip()]
                data["experiences"].append(
                    {
                        "company": (row.get("Company Name") or "").strip() or None,
                        "title": (row.get("Title") or "").strip() or None,
                        "start": norm_date((row.get("Started On") or "").strip()),
                        "end": norm_date((row.get("Finished On") or "").strip()) or ("present" if not (row.get("Finished On") or "").strip() else None),
                        "bullets": bullets,
                        "location": (row.get("Location") or "").strip() or None,
                    }
                )

        edu_csv = read("Education.csv")
        if edu_csv:
            reader = csv.DictReader(io.StringIO(edu_csv))
            for row in reader:
                data["education"].append(
                    {
                        "school": (row.get("School Name") or "").strip() or None,
                        "degree": (row.get("Degree Name") or "").strip() or None,
                        "field": (row.get("Field Of Study") or row.get("Notes") or "").strip() or None,
                        "start": norm_date((row.get("Start Date") or "").strip()),
                        "end": norm_date((row.get("End Date") or "").strip()),
                    }
                )

        skills_csv = read("Skills.csv")
        if skills_csv:
            reader = csv.DictReader(io.StringIO(skills_csv))
            for row in reader:
                name = (row.get("Name") or row.get("Skill") or "").strip()
                if name:
                    data["skills"].append(name)

        lang_csv = read("Languages.csv")
        if lang_csv:
            reader = csv.DictReader(io.StringIO(lang_csv))
            for row in reader:
                name = (row.get("Name") or row.get("Language") or "").strip()
                if name:
                    data["languages"].append({"name": name, "level": (row.get("Proficiency") or "").strip() or None})

        cert_csv = read("Certifications.csv")
        if cert_csv:
            reader = csv.DictReader(io.StringIO(cert_csv))
            for row in reader:
                name = (row.get("Name") or "").strip()
                if name:
                    data["certifications"].append(
                        {
                            "name": name,
                            "issuer": (row.get("Authority") or "").strip() or None,
                            "date": (row.get("Started On") or "").strip() or None,
                        }
                    )

    data["_source"] = "linkedin-zip"
    return data


# --------------------------- dispatcher ------------------------------

def auto_detect_kind(path: str, data: bytes) -> str:
    head = data[:512].decode("utf-8", errors="replace").lstrip().lower()
    if path.lower().endswith(".zip"):
        return "linkedin-zip"
    if head.startswith(("<!doctype", "<html", "<?xml")) or "<body" in head or "<div" in head:
        return "html-paste"
    # url check
    stripped = head.strip().splitlines()[0] if head.strip() else ""
    if stripped.startswith("http"):
        if "linkedin.com/in/" in stripped:
            return "linkedin-url"
        if "104.com.tw" in stripped:
            return "104-url"
    return "text-paste"


def parse(kind: str, path: str) -> dict[str, Any]:
    if kind == "linkedin-zip":
        return parse_linkedin_zip(path)
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8", errors="replace")
    if kind in ("linkedin-url",):
        # treat body as HTML snapshot if looks like HTML, else text
        if text.lstrip().lower().startswith(("<!doctype", "<html")) or "<body" in text.lower():
            return parse_html_generic(text, "linkedin-url")
        return {**parse_plaintext(text), "_source": "linkedin-url"}
    if kind == "104-url":
        if text.lstrip().lower().startswith(("<!doctype", "<html")) or "<body" in text.lower():
            return parse_html_generic(text, "104-url")
        return {**parse_plaintext(text), "_source": "104-url"}
    if kind == "html-paste":
        return parse_html_generic(text, "html-paste")
    if kind == "text-paste":
        return parse_plaintext(text)
    raise ValueError(f"unknown kind: {kind}")


def field_count(data: dict[str, Any]) -> int:
    n = 0
    for key in ("name", "headline", "summary"):
        if data.get(key):
            n += 1
    if data.get("contact", {}).get("email") or data.get("contact", {}).get("phone"):
        n += 1
    if data.get("experiences"):
        n += 1
    if data.get("education"):
        n += 1
    if data.get("skills"):
        n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=["linkedin-url", "104-url", "html-paste", "linkedin-zip", "text-paste"])
    ap.add_argument("--auto", action="store_true")
    ap.add_argument("--input", required=True)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2

    kind = args.kind
    if args.auto or not kind:
        with open(args.input, "rb") as f:
            head = f.read(1024)
        kind = auto_detect_kind(args.input, head)

    data = parse(kind, args.input)
    indent = 2 if args.pretty else None
    json.dump(data, sys.stdout, ensure_ascii=False, indent=indent)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
