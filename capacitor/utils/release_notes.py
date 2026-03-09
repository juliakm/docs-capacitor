"""Release notes fetcher — download and extract product-relevant sections.

Fully parameterized: URL, section pattern, and output keys all come from
the scenario config rather than being hardcoded to any specific product.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import requests
from bs4 import BeautifulSoup, Tag


def _heading_level(tag: Tag) -> int:
    if tag.name and re.match(r"^h([1-6])$", tag.name):
        return int(tag.name[1])
    return 0


def _section_text(start: Tag, max_level: int) -> str:
    parts: list[str] = []
    for sibling in start.next_siblings:
        if isinstance(sibling, Tag):
            lvl = _heading_level(sibling)
            if lvl and lvl <= max_level:
                break
            parts.append(sibling.get_text(separator=" ", strip=True))
        elif isinstance(sibling, str) and sibling.strip():
            parts.append(sibling.strip())
    return "\n".join(p for p in parts if p)


def _detect_version(heading_text: str) -> str:
    m = re.search(r"\b(\d+\.\d+(?:\.\d+)?)\b", heading_text)
    return m.group(1) if m else ""


def fetch_page(url: str, timeout: int = 30) -> str:
    headers = {"User-Agent": "Mozilla/5.0 (compatible; DocsCapacitor/1.0)"}
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def extract_sections(html: str, section_pattern: str) -> List[Dict[str, Any]]:
    """Extract sections matching a regex pattern from an HTML page."""
    soup = BeautifulSoup(html, "lxml")
    main = soup.find("main") or soup.find("article") or soup.find("div", {"id": "main"}) or soup
    pattern_re = re.compile(section_pattern, re.IGNORECASE)
    sections: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for heading in main.find_all(re.compile(r"^h[2-4]$")):
        heading_text = heading.get_text(strip=True)
        level = _heading_level(heading)
        content = _section_text(heading, level)
        if pattern_re.search(heading_text) or pattern_re.search(content):
            key = heading_text.lower().strip()
            if key in seen:
                continue
            seen.add(key)
            sections.append({
                "heading": heading_text,
                "heading_level": level,
                "version": _detect_version(heading_text),
                "content": content,
            })

    return sections


def build_snapshot(
    url: str,
    sections: List[Dict[str, Any]],
    section_key: str = "product_sections",
) -> Dict[str, Any]:
    """Build a release notes snapshot dict."""
    version_match = re.search(r"/releases/(\d{4})/", url)
    version_year = version_match.group(1) if version_match else ""
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source_url": url,
        "version_year": version_year,
        "section_count": len(sections),
        section_key: sections,
    }


def refresh_release_notes(
    url: str,
    section_pattern: str,
    section_key: str = "product_sections",
    output: str | Path = "release_notes_snapshot.json",
) -> Path:
    """Fetch release notes and save snapshot. Returns output path."""
    html = fetch_page(url)
    sections = extract_sections(html, section_pattern)
    snapshot = build_snapshot(url, sections, section_key)
    output_path = Path(output)
    output_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return output_path
