"""GitHubSearchCollector — collect pages from GitHub repos.

Queries, orgs, and excluded repos all come from scenario config.
"""

from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, Iterator, List, Set

from capacitor.collectors.base import BaseCollector
from capacitor.collectors import register_collector


def _fetch_raw_file(repo: str, path: str, branches: tuple[str, ...] = ("main", "master")) -> Dict[str, Any] | None:
    """Fetch a single file from raw.githubusercontent.com, trying each branch."""
    for branch in branches:
        raw_url = f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
        try:
            req = urllib.request.Request(raw_url)
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode("utf-8", errors="replace")
                url = f"https://github.com/{repo}/blob/{branch}/{path}"
                return {"url": url, "repo": repo, "text": text}
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            return None
        except Exception:
            return None
    return None


@register_collector("github")
class GitHubSearchCollector(BaseCollector):
    """Collect page content from GitHub repos via raw file fetch."""

    @property
    def name(self) -> str:
        return "github"

    def __init__(
        self,
        *,
        tracker_path: str | Path | None = None,
        excluded_repos: Set[str] | List[str] | None = None,
    ):
        self.tracker_path = Path(tracker_path) if tracker_path else None
        self.excluded_repos = set(excluded_repos) if excluded_repos else set()

    def collect(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        """Yield page dicts fetched from tracked GitHub files."""
        pages_jsonl = kwargs.get("pages_jsonl")
        if pages_jsonl:
            yield from self._stream_jsonl(Path(pages_jsonl))
            return

        if not self.tracker_path or not self.tracker_path.exists():
            return

        tracker = json.loads(self.tracker_path.read_text(encoding="utf-8"))
        files = tracker.get("files", [])

        for i, entry in enumerate(files, 1):
            repo = entry["repo"]
            path = entry["path"]
            if repo in self.excluded_repos:
                continue
            result = _fetch_raw_file(repo, path)
            if result:
                yield result
            if i % 50 == 0:
                time.sleep(1)

    @staticmethod
    def _stream_jsonl(path: Path) -> Iterator[Dict[str, Any]]:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    yield json.loads(line)
