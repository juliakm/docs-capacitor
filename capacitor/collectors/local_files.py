"""LocalFilesCollector — collect pages from local file system."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterator

from capacitor.collectors.base import BaseCollector
from capacitor.collectors import register_collector


@register_collector("local")
class LocalFilesCollector(BaseCollector):
    """Collect page content from local Markdown/text files."""

    @property
    def name(self) -> str:
        return "local"

    def __init__(self, *, root: str | Path = ".", glob_pattern: str = "**/*.md"):
        self.root = Path(root)
        self.glob_pattern = glob_pattern

    def collect(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        for path in sorted(self.root.glob(self.glob_pattern)):
            try:
                text = path.read_text(encoding="utf-8")
            except Exception:
                continue
            yield {
                "url": str(path),
                "repo": "",
                "text": text,
            }
