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
import random
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
API_MAX_RETRIES = 3
API_RETRY_BACKOFF = [5, 15, 30]
RESULTS_PER_QUERY = 300
MAX_FETCH_FILES_DEFAULT = 500   # hard cap on files fetched per run
SLOW_MODE_SEARCH_DELAY = 8
SLOW_MODE_API_DELAY = 0.5
CACHE_TTL_HOURS = 24
RATE_LIMIT_MAX_WAIT_SECONDS = max(30, int(os.getenv("CAPACITOR_GH_RATE_LIMIT_MAX_WAIT_SECONDS", "600")))
RATE_LIMIT_SLEEP_CHUNK_SECONDS = max(5, int(os.getenv("CAPACITOR_GH_RATE_LIMIT_SLEEP_CHUNK_SECONDS", "30")))


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


def _is_private_repo_variant(repo: str) -> bool:
    """Return True for paired private repo names like ``owner/repo-pr``."""
    repo_name = repo.split("/", 1)[-1]
    return repo_name.endswith("-pr")


def _canonical_repo_path_key(repo: str, path: str) -> str:
    """Build a dedupe key that treats ``repo`` and ``repo-pr`` as the same file source."""
    owner, sep, repo_name = repo.partition("/")
    canonical_repo = repo
    if sep and repo_name.endswith("-pr"):
        canonical_repo = f"{owner}/{repo_name[:-3]}"
    return f"{canonical_repo}/{path}"


def _merge_repo_variant_hit(
    selected_hits: Dict[str, Dict[str, str]],
    item: Dict[str, str],
) -> bool:
    """Merge a hit into *selected_hits*, preferring public repos over ``-pr`` variants.

    Returns True when a new canonical file key is added, False when only updated/skipped.
    """
    key = _canonical_repo_path_key(item["repo"], item["path"])
    existing = selected_hits.get(key)
    if existing is None:
        selected_hits[key] = item
        return True
    if _is_private_repo_variant(existing["repo"]) and not _is_private_repo_variant(item["repo"]):
        selected_hits[key] = item
    return False


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


def _parse_search_rate_limit_payload(payload: Dict[str, Any]) -> Dict[str, Optional[int] | str]:
    """Extract search bucket details from ``gh api rate_limit`` payload."""
    resources = payload.get("resources", {}) if isinstance(payload, dict) else {}
    bucket_name = "code_search"
    bucket = resources.get(bucket_name, {}) if isinstance(resources, dict) else {}
    if not isinstance(bucket, dict) or bucket.get("remaining") is None:
        bucket_name = "search"
        bucket = resources.get(bucket_name, {}) if isinstance(resources, dict) else {}
    if not isinstance(bucket, dict):
        bucket = {}
    remaining_raw = bucket.get("remaining")
    reset_raw = bucket.get("reset")
    limit_raw = bucket.get("limit")

    def _as_int(value: Any) -> Optional[int]:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return {
        "bucket": bucket_name,
        "remaining": _as_int(remaining_raw),
        "reset": _as_int(reset_raw),
        "limit": _as_int(limit_raw),
    }


def _gh_search_rate_limit_status() -> Optional[Dict[str, Optional[int] | str]]:
    """Return current ``code_search`` rate-limit state, falling back to ``search`` bucket."""
    cmd = ["gh", "api", "rate_limit"]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        logger.warning("Unable to query gh rate_limit: %s", (result.stderr or "").strip())
        return None
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        logger.warning("Unable to parse gh rate_limit response")
        return None
    return _parse_search_rate_limit_payload(payload)


def _wait_for_search_rate_limit(max_wait_seconds: int = RATE_LIMIT_MAX_WAIT_SECONDS) -> None:
    """Gate ``gh search code`` requests when the search bucket is exhausted."""
    status = _gh_search_rate_limit_status()
    if not status:
        return
    remaining = status.get("remaining")
    reset_epoch = status.get("reset")
    bucket = status.get("bucket", "search")
    if remaining is None or remaining > 0:
        return
    now = int(time.time())
    if reset_epoch is None:
        wait_seconds = min(max_wait_seconds, RATE_LIMIT_SLEEP_CHUNK_SECONDS)
        print(
            f" — {bucket} rate limit exhausted (remaining=0, reset unknown), waiting {wait_seconds}s…",
            flush=True,
        )
        time.sleep(wait_seconds)
        return
    wait_until_reset = max(0, reset_epoch - now + 1)
    wait_seconds = min(wait_until_reset, max_wait_seconds)
    if wait_seconds <= 0:
        return
    if wait_seconds < wait_until_reset:
        print(
            f" — {bucket} rate limit exhausted; reset in {wait_until_reset}s, capped wait {wait_seconds}s…",
            flush=True,
        )
    else:
        print(
            f" — {bucket} rate limit exhausted; waiting {wait_seconds}s for reset…",
            flush=True,
        )
    remaining_wait = wait_seconds
    while remaining_wait > 0:
        sleep_for = min(remaining_wait, RATE_LIMIT_SLEEP_CHUNK_SECONDS)
        time.sleep(sleep_for)
        remaining_wait -= sleep_for


def _is_retryable_search_error(result: subprocess.CompletedProcess[str]) -> bool:
    """Return True for rate-limits/transient failures worth retrying."""
    combined = f"{result.stderr or ''}\n{result.stdout or ''}".lower()
    has_rate_marker = any(
        marker in combined for marker in (
            "rate limit",
            "rate-limit",
            "secondary rate",
            "abuse detection",
            "too many requests",
            "api quota exceeded",
        )
    )
    has_rate_status = bool(re.search(r"\b(403|429)\b", combined))
    if has_rate_marker and has_rate_status:
        return True
    return any(token in combined for token in ("502", "503", "504", "timed out", "timeout"))


def _retry_delay_seconds(attempt: int, backoff: List[int]) -> float:
    """Backoff + small jitter for retries."""
    base = backoff[attempt] if attempt < len(backoff) else backoff[-1] if backoff else 30
    return float(base) + random.uniform(0, max(1.0, base * 0.1))


def _gh_search_code(
    query: str,
    orgs: List[str],
    limit: int = RESULTS_PER_QUERY,
    inter_org_delay: float = RATE_LIMIT_DELAY,
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
            _wait_for_search_rate_limit()
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
            retryable = _is_retryable_search_error(result)
            if retryable and attempt < MAX_RETRIES:
                wait = _retry_delay_seconds(attempt, RETRY_BACKOFF)
                print(f" — retriable search error, retrying in {wait:.1f}s…", flush=True)
                time.sleep(wait)
                continue
            err_text = (result.stderr or result.stdout or "").strip()
            if retryable:
                print(" — failed after retries", flush=True)
                logger.warning(
                    "Search failed after %d retries: %s (%s)",
                    MAX_RETRIES,
                    full_query,
                    err_text[:300],
                )
            else:
                print(" — non-retriable search error", flush=True)
                logger.warning("Non-retriable search failure: %s (%s)", full_query, err_text[:300])
            break
        else:
            print(" — failed after retries", flush=True)
            logger.warning("Search failed after %d retries: %s", MAX_RETRIES, full_query)
        # Rate-limit pause between org queries
        time.sleep(inter_org_delay)
    return all_hits


def _gh_api_file(repo: str, path: str) -> Optional[Dict[str, str]]:
    """Fetch file content and metadata from GitHub via ``gh api``.

    Returns ``{"content": <text>, "html_url": <browser URL>}`` or *None*.
    Using the API-provided ``html_url`` avoids hardcoding a branch name.
    """
    api_path = f"/repos/{repo}/contents/{path}"
    cmd = [
        "gh", "api", api_path,
        "-H", "Accept: application/vnd.github.v3+json",
    ]
    for attempt in range(API_MAX_RETRIES + 1):
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                content_b64 = (data.get("content") or "").replace("\n", "")
                text = base64.b64decode(content_b64).decode("utf-8")
                html_url = data.get("html_url", f"https://github.com/{repo}/blob/main/{path}")
                return {"content": text, "html_url": html_url}
            except Exception:
                return None

        if attempt < API_MAX_RETRIES:
            stderr = (result.stderr or "").lower()
            stdout = (result.stdout or "").lower()
            combined = f"{stderr}\n{stdout}"
            if "rate limit" in combined or "secondary rate" in combined or "502" in combined:
                wait = API_RETRY_BACKOFF[attempt] if attempt < len(API_RETRY_BACKOFF) else 45
                print(f"    gh api rate-limited for {repo}/{path}, retrying in {wait}s…", flush=True)
                time.sleep(wait)
                continue
        return None
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
        max_fetch_files: int = MAX_FETCH_FILES_DEFAULT,
        slow_mode: bool = False,
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
        self.max_fetch_files = max(1, int(max_fetch_files))
        self.slow_mode = bool(slow_mode)
        # date_filter: {"after": "MM/DD/YYYY" or "YYYY-MM-DD", "before": ..., "mode": "exclude"|"flag"}
        self.date_filter = date_filter or {}
        # Normalize config dates so users can write either MM/DD/YYYY or YYYY-MM-DD
        for key in ("after", "before"):
            raw = self.date_filter.get(key)
            if raw:
                self.date_filter[key] = _parse_ms_date(str(raw)) or str(raw)
        self.date_skipped = 0  # count of articles excluded by date filter

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
        selected_hits: Dict[str, Dict[str, str]] = {}
        for entry in files:
            repo = entry["repo"]
            path = entry["path"]
            if repo in self.excluded_repos:
                continue
            _merge_repo_variant_hit(selected_hits, {"repo": repo, "path": path})

        filter_mode = self.date_filter.get("mode", "exclude")
        date_after = self.date_filter.get("after")
        date_before = self.date_filter.get("before")

        tracker_hits = list(selected_hits.values())[: self.max_fetch_files]
        for i, entry in enumerate(tracker_hits, 1):
            repo = entry["repo"]
            path = entry["path"]
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
                    self.date_skipped += 1
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
                if len(cached) > self.max_fetch_files:
                    logger.info(
                        "Using first %d cached pages out of %d total (max_fetch_files)",
                        self.max_fetch_files,
                        len(cached),
                    )
                yield from cached[: self.max_fetch_files]
                return

        # Verify gh CLI
        _check_gh_cli()
        search_delay = SLOW_MODE_SEARCH_DELAY if self.slow_mode else RATE_LIMIT_DELAY
        api_delay = SLOW_MODE_API_DELAY if self.slow_mode else 0.0
        if self.slow_mode:
            print("  GitHub slow mode enabled (extra throttling to reduce API rate limits)")

        # Search phase — deduplicate across queries
        selected_hits: Dict[str, Dict[str, str]] = {}

        logger.info("Searching GitHub orgs: %s", ", ".join(self.orgs))
        search_count = 0
        limit_reached = False
        for q in self.queries:
            search_count += 1
            logger.info("[%d/%d] %s", search_count, len(self.queries), q[:80])
            results = _gh_search_code(q, self.orgs, inter_org_delay=search_delay)
            for item in results:
                repo = item["repo"]
                path = item["path"]
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
                is_new = _merge_repo_variant_hit(selected_hits, item)
                if is_new and len(selected_hits) >= self.max_fetch_files:
                    limit_reached = True
                    logger.info(
                        "Reached max_fetch_files=%d — stopping search phase early",
                        self.max_fetch_files,
                    )
                    break
            if limit_reached:
                break
            # Rate-limit between queries
            time.sleep(search_delay)

        hits: List[Dict[str, str]] = list(selected_hits.values())
        logger.info("Unique hits after dedup: %d", len(hits))
        print(f"  Unique GitHub files queued for fetch: {len(hits)} (cap: {self.max_fetch_files})")

        # Fetch phase
        pages: List[Dict[str, Any]] = []
        for i, hit in enumerate(hits, 1):
            if i == 1 or i % 25 == 0 or i == len(hits):
                print(f"  Fetching GitHub file content: {i}/{len(hits)}", flush=True)
            if api_delay:
                time.sleep(api_delay)
            file_data = _gh_api_file(hit["repo"], hit["path"])
            if file_data:
                content = file_data["content"]
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
                    self.date_skipped += 1
                    continue

                page: Dict[str, Any] = {
                    "url": file_data["html_url"],
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
            if i % 10 == 0:
                logger.info("Fetched %d/%d files", i, len(hits))

        if self.date_skipped:
            logger.info("Skipped %d files outside date range", self.date_skipped)
            print(f"  Skipped {self.date_skipped} files outside date range")

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
