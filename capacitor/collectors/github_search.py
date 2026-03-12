"""GitHubSearchCollector — collect pages from GitHub repos.

Two collection paths:

1. **Tracker path** (legacy): reads a pre-built ``tracker.json`` with
   ``{files: [{repo, path}, ...]}`` and fetches content via
   ``raw.githubusercontent.com``.
2. **``gh`` CLI path** (default when no tracker exists): shells out to
   ``gh search code`` and ``gh api`` — works anywhere ``gh`` is installed
   and authenticated.

Auto-detection: if a ``tracker_path`` is provided and exists on disk the
tracker path is used; otherwise the CLI path kicks in.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Set

import yaml as _yaml

from capacitor.collectors.base import BaseCollector
from capacitor.collectors import register_collector

logger = logging.getLogger(__name__)


# ── front-matter helpers ──────────────────────────────────────────

def _extract_ms_date(text: str) -> Optional[str]:
    """Extract ``ms.date`` from YAML front matter in a markdown file.

    Returns the date string (e.g. ``"01/15/2023"``) or *None*.
    """
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    try:
        fm = _yaml.safe_load(text[3:end])
    except Exception:
        return None
    if not isinstance(fm, dict):
        return None
    # ms.date is stored with a dot-key in the front matter:
    #   ms.date: 01/15/2023
    # PyYAML parses this as {"ms.date": "01/15/2023"} (key is the literal string)
    raw = fm.get("ms.date")
    if raw is None:
        return None
    return str(raw).strip()


def _parse_ms_date(date_str: str) -> Optional[str]:
    """Normalise an ms.date value to ``YYYY-MM-DD``.

    Handles ``MM/DD/YYYY`` (most common) and ``YYYY-MM-DD``.
    Returns *None* on failure.
    """
    import re as _re
    # MM/DD/YYYY
    m = _re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", date_str)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    # YYYY-MM-DD (already normalised)
    m = _re.match(r"^\d{4}-\d{2}-\d{2}$", date_str)
    if m:
        return date_str
    return None

# ── rate-limit / retry defaults ───────────────────────────────────
RATE_LIMIT_DELAY = 3            # seconds between search API calls
MAX_RETRIES = 3
RETRY_BACKOFF = [15, 30, 60]    # seconds per retry
RESULTS_PER_QUERY = 100
CACHE_TTL_HOURS = 24


# ── repo-allowlist loader ─────────────────────────────────────────

def _load_repos_allowlist(repos_file: str | Path) -> Optional[Set[str]]:
    """Parse a markdown repos file for ``owner/repo`` names.

    Recognised line formats::

        - owner/repo
        owner/repo
        * owner/repo

    Returns a **lowercase** set (with ``-pr`` variants) or *None* if the
    file does not exist.
    """
    path = Path(repos_file)
    if not path.exists():
        return None
    allowed: Set[str] = set()
    pattern = re.compile(r"^[-*]?\s*([\w.-]+/[\w.-]+)\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        m = pattern.match(line.strip())
        if not m:
            continue
        name = m.group(1).lower()
        allowed.add(name)
        # Also match public/private variants (azure-docs ↔ azure-docs-pr)
        if name.endswith("-pr"):
            allowed.add(name[:-3])
        else:
            allowed.add(name + "-pr")
    return allowed or None


# ── gh CLI helpers ────────────────────────────────────────────────

def _check_gh_cli() -> None:
    """Verify ``gh`` is installed and authenticated.  Raises on failure."""
    try:
        subprocess.run(
            ["gh", "--version"],
            capture_output=True, check=True, text=True, timeout=10,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise RuntimeError(
            "GitHub CLI (gh) is required for live GitHub search. "
            "Install: https://cli.github.com  then run: gh auth login"
        ) from exc
    result = subprocess.run(
        ["gh", "auth", "status"],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "GitHub CLI is not authenticated. Run: gh auth login"
        )


def _gh_search_code(
    query: str,
    orgs: List[str],
    limit: int = RESULTS_PER_QUERY,
) -> List[Dict[str, str]]:
    """Run ``gh search code`` with org filters and return ``[{repo, path}]``."""
    all_hits: List[Dict[str, str]] = []
    total = len(orgs)
    for idx, org in enumerate(orgs, 1):
        full_query = f"{query} org:{org}"
        print(f"    [{idx}/{total}] gh search code '{query}' org:{org}", end="", flush=True)
        cmd = [
            "gh", "search", "code", full_query,
            "--extension", "md",
            "--json", "repository,path",
            "--limit", str(limit),
        ]
        for attempt in range(MAX_RETRIES + 1):
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=60,
            )
            if result.returncode == 0:
                try:
                    items = json.loads(result.stdout)
                except json.JSONDecodeError:
                    print(" — parse error", flush=True)
                    break
                for item in items:
                    repo_field = item.get("repository", "")
                    repo_name = (
                        repo_field.get("nameWithOwner", "")
                        if isinstance(repo_field, dict)
                        else str(repo_field)
                    )
                    all_hits.append({
                        "repo": repo_name,
                        "path": item.get("path", ""),
                    })
                print(f" — {len(items)} hits", flush=True)
                break
            # Rate-limited or transient error — retry with backoff
            if attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF[attempt] if attempt < len(RETRY_BACKOFF) else 120
                print(f" — rate limited, retrying in {wait}s…", flush=True)
                time.sleep(wait)
        else:
            print(" — failed after retries", flush=True)
            logger.warning("Search failed after %d retries: %s", MAX_RETRIES, full_query)
        # Rate-limit pause between org queries
        time.sleep(RATE_LIMIT_DELAY)
    return all_hits


def _gh_api_file(repo: str, path: str) -> Optional[str]:
    """Fetch raw file content from GitHub via ``gh api`` (base64 decode)."""
    api_path = f"/repos/{repo}/contents/{path}"
    cmd = [
        "gh", "api", api_path,
        "--jq", ".content",
        "-H", "Accept: application/vnd.github.v3+json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None
    try:
        content_b64 = result.stdout.strip().replace("\n", "")
        return base64.b64decode(content_b64).decode("utf-8")
    except Exception:
        return None


# ── raw.githubusercontent fallback (tracker mode) ─────────────────

def _fetch_raw_file(
    repo: str,
    path: str,
    branches: tuple[str, ...] = ("main", "master"),
) -> Dict[str, Any] | None:
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


# ── search-result cache helpers ───────────────────────────────────

def _load_search_cache(cache_path: Path, cache_key: str = "") -> Optional[List[Dict[str, Any]]]:
    """Load cached pages if present, younger than *CACHE_TTL_HOURS*, and matching the cache key."""
    if not cache_path.exists():
        return None
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        ts = data.get("timestamp", 0)
        age_hours = (time.time() - ts) / 3600
        if age_hours > CACHE_TTL_HOURS:
            logger.info("Cache expired (%.1fh old), refreshing", age_hours)
            return None
        # Invalidate if the queries/orgs changed since the cache was saved
        if cache_key and data.get("cache_key", "") != cache_key:
            logger.info("Cache invalidated — search configuration changed since last run")
            return None
        logger.info("Using cached results (%.1fh old)", age_hours)
        return data.get("pages", [])
    except Exception:
        return None


def _save_search_cache(cache_path: Path, pages: List[Dict[str, Any]], cache_key: str = "") -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"timestamp": time.time(), "cache_key": cache_key, "pages": pages}
    cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


# ── collector ─────────────────────────────────────────────────────

@register_collector("github")
class GitHubSearchCollector(BaseCollector):
    """Collect page content from GitHub repos.

    Supports two modes (auto-detected):
    * **tracker mode** — when *tracker_path* points to an existing JSON file
    * **gh CLI mode** — live ``gh search code`` + ``gh api`` content fetch
    """

    @property
    def name(self) -> str:
        return "github"

    def __init__(
        self,
        *,
        tracker_path: str | Path | None = None,
        excluded_repos: Set[str] | List[str] | None = None,
        orgs: List[str] | None = None,
        queries: List[str] | None = None,
        cache_dir: str | Path | None = None,
        use_cache: bool = True,
        repos_file: str | Path | None = None,
        allowed_repos: List[str] | None = None,
        dry_run: bool = False,
        date_filter: Dict[str, str] | None = None,
    ):
        self.tracker_path = Path(tracker_path) if tracker_path else None
        self.excluded_repos = set(excluded_repos) if excluded_repos else set()
        self.orgs = orgs or []
        self.queries = queries or []
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.use_cache = use_cache
        self.repos_file = repos_file
        self.allowed_repos: Set[str] | None = None
        if allowed_repos:
            self.allowed_repos = {r.lower() for r in allowed_repos}
        self.dry_run = dry_run
        # date_filter: {"after": "YYYY-MM-DD", "before": "YYYY-MM-DD", "mode": "exclude"|"flag"}
        self.date_filter = date_filter or {}

    # ── public API ────────────────────────────────────────────────

    def collect(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        """Yield page dicts fetched from tracked GitHub files or live search."""
        # Pre-built JSONL override
        pages_jsonl = kwargs.get("pages_jsonl")
        if pages_jsonl:
            yield from self._stream_jsonl(Path(pages_jsonl))
            return

        # Auto-detect: tracker exists → use it; otherwise use gh CLI
        if self.tracker_path and self.tracker_path.exists():
            yield from self._collect_tracker()
        elif self.orgs and self.queries:
            yield from self._collect_gh_cli()
        else:
            logger.info("No tracker file and no orgs/queries configured — nothing to collect")

    # ── tracker mode ──────────────────────────────────────────────

    def _collect_tracker(self) -> Iterator[Dict[str, Any]]:
        """Yield pages from a pre-built tracker.json."""
        assert self.tracker_path is not None
        tracker = json.loads(self.tracker_path.read_text(encoding="utf-8"))
        files = tracker.get("files", [])

        filter_mode = self.date_filter.get("mode", "exclude")
        date_after = self.date_filter.get("after")
        date_before = self.date_filter.get("before")

        for i, entry in enumerate(files, 1):
            repo = entry["repo"]
            path = entry["path"]
            if repo in self.excluded_repos:
                continue
            result = _fetch_raw_file(repo, path)
            if result:
                # Extract ms.date from content
                ms_date_raw = _extract_ms_date(result.get("text", ""))
                ms_date = _parse_ms_date(ms_date_raw) if ms_date_raw else None

                failed_date_check = False
                if ms_date:
                    if date_after and ms_date < date_after:
                        failed_date_check = True
                    if date_before and ms_date > date_before:
                        failed_date_check = True

                if failed_date_check and filter_mode == "exclude":
                    continue

                if ms_date:
                    result["ms_date"] = ms_date
                if failed_date_check:
                    result["date_flag"] = "outside_range"

                yield result
            if i % 50 == 0:
                time.sleep(1)

    # ── gh CLI mode ───────────────────────────────────────────────

    def _collect_gh_cli(self) -> Iterator[Dict[str, Any]]:
        """Search GitHub orgs via ``gh`` CLI and yield page records."""
        # Repo allowlist — allowed_repos (from scenario) takes priority over repos_file
        file_allowlist: Optional[Set[str]] = None
        if self.allowed_repos:
            logger.info("Using allowed_repos from scenario config: %d repos",
                        len(self.allowed_repos))
        elif self.repos_file:
            file_allowlist = _load_repos_allowlist(self.repos_file)
            if file_allowlist:
                logger.info("Repo allowlist loaded: %d repos from %s",
                            len(file_allowlist) // 2, self.repos_file)

        total_searches = len(self.orgs) * len(self.queries)

        # Dry-run mode
        if self.dry_run:
            print(f"Dry run — would perform {total_searches} searches:")
            for org in self.orgs:
                for q in self.queries:
                    print(f"  gh search code '{q} org:{org}' --extension md")
            print(f"Excluded repos: {', '.join(sorted(self.excluded_repos))}")
            return

        # Build a cache key from the search configuration so changes invalidate the cache
        import hashlib
        key_input = json.dumps({"orgs": sorted(self.orgs), "queries": sorted(self.queries),
                                "excluded": sorted(self.excluded_repos)}, sort_keys=True)
        cache_key = hashlib.sha256(key_input.encode()).hexdigest()[:16]

        # Check cache
        cache_path = (self.cache_dir / "github_search_cache.json") if self.cache_dir else None
        if self.use_cache and cache_path:
            cached = _load_search_cache(cache_path, cache_key)
            if cached is not None:
                yield from cached
                return

        # Verify gh CLI
        _check_gh_cli()

        # Search phase — deduplicate across queries
        seen: Set[str] = set()
        hits: List[Dict[str, str]] = []

        logger.info("Searching GitHub orgs: %s", ", ".join(self.orgs))
        search_count = 0
        for q in self.queries:
            search_count += 1
            logger.info("[%d/%d] %s", search_count, len(self.queries), q[:80])
            results = _gh_search_code(q, self.orgs)
            for item in results:
                repo = item["repo"]
                path = item["path"]
                key = f"{repo}/{path}"
                if key in seen:
                    continue
                if repo in self.excluded_repos:
                    continue
                repo_short = repo.split("/")[-1].lower()
                # allowed_repos from scenario config — works for all orgs
                if self.allowed_repos:
                    if repo_short not in self.allowed_repos:
                        continue
                # Legacy repos_file allowlist — only filters MicrosoftDocs
                elif file_allowlist and repo.startswith("MicrosoftDocs/"):
                    if repo_short not in file_allowlist:
                        continue
                seen.add(key)
                hits.append(item)
            # Rate-limit between queries
            time.sleep(RATE_LIMIT_DELAY)

        logger.info("Unique hits after dedup: %d", len(hits))

        # Fetch phase
        pages: List[Dict[str, Any]] = []
        date_skipped = 0
        for i, hit in enumerate(hits):
            content = _gh_api_file(hit["repo"], hit["path"])
            if content:
                # Extract ms.date from YAML front matter
                ms_date_raw = _extract_ms_date(content)
                ms_date = _parse_ms_date(ms_date_raw) if ms_date_raw else None

                # Date filtering
                filter_mode = self.date_filter.get("mode", "exclude")
                date_after = self.date_filter.get("after")
                date_before = self.date_filter.get("before")
                failed_date_check = False
                if ms_date:
                    if date_after and ms_date < date_after:
                        failed_date_check = True
                    if date_before and ms_date > date_before:
                        failed_date_check = True

                if failed_date_check and filter_mode == "exclude":
                    date_skipped += 1
                    continue

                page: Dict[str, Any] = {
                    "url": f"https://github.com/{hit['repo']}/blob/main/{hit['path']}",
                    "repo": hit["repo"],
                    "text": content,
                }
                if ms_date:
                    page["ms_date"] = ms_date
                if failed_date_check:
                    # mode == "flag": include but mark as outside date range
                    page["date_flag"] = "outside_range"

                pages.append(page)
                yield page
            if (i + 1) % 10 == 0:
                logger.info("Fetched %d/%d files", i + 1, len(hits))

        if date_skipped:
            logger.info("Skipped %d files outside date range", date_skipped)
            print(f"  Skipped {date_skipped} files outside date range")

        # Write cache
        if cache_path and pages:
            _save_search_cache(cache_path, pages, cache_key)

    # ── helpers ───────────────────────────────────────────────────

    @staticmethod
    def _stream_jsonl(path: Path) -> Iterator[Dict[str, Any]]:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    yield json.loads(line)
