"""LearnAPICollector — search Learn.microsoft.com and fetch page content.

Queries, API URL, and exclusion patterns all come from scenario config.
The relevance filter is generic — it checks for the product name from config.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, Iterator, List

import requests
from bs4 import BeautifulSoup

from capacitor.collectors.base import BaseCollector
from capacitor.collectors import register_collector


def _matches_any(text: str, patterns: List[str]) -> bool:
    return any(pattern in text for pattern in patterns)


def _search_learn(api_url: str, query: str, scope: str = "", top: int = 30) -> List[Dict[str, Any]]:
    scoped_query = f"{query} {scope.strip('/')}" if scope else query
    params = {"search": scoped_query, "locale": "en-us", "$top": top}
    resp = requests.get(api_url, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json().get("results", [])


def _fetch_page_text(url: str, timeout: int = 15) -> str:
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    main = soup.find("main") or soup.find("article") or soup.body
    return main.get_text(separator=" ", strip=True) if main else ""


@register_collector("learn")
class LearnAPICollector(BaseCollector):
    """Collect pages from Learn.microsoft.com via search + fetch."""

    @property
    def name(self) -> str:
        return "learn"

    def __init__(
        self,
        *,
        api_url: str = "https://learn.microsoft.com/api/search",
        queries: list[str] | None = None,
        path_scopes: list[str] | None = None,
        exclude_url_patterns: list[str] | None = None,
        relevance_terms: list[str] | None = None,
        max_workers: int = 5,
    ):
        self.api_url = api_url
        self.queries = queries or []
        self.path_scopes = path_scopes or [""]  # empty string = no scope filter
        self.exclude_url_patterns = exclude_url_patterns or []
        self.relevance_terms = relevance_terms or []
        self.max_workers = max_workers

    def collect(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        """Search, filter, fetch, and yield page dicts."""
        filtered = self._search_and_filter()
        urls = [item.get("url", "") for item in filtered if item.get("url")]
        yield from self._fetch_pages(urls)

    def _search_and_filter(self) -> List[Dict[str, Any]]:
        all_results: dict[str, Dict[str, Any]] = {}
        filtered: dict[str, Dict[str, Any]] = {}

        total = len(self.queries) * len(self.path_scopes)
        search_count = 0

        for query in self.queries:
            for scope in self.path_scopes:
                search_count += 1
                scope_label = scope or "(all)"
                print(f"  [{search_count}/{total}] {query[:40]} | scope: {scope_label}", end="")
                try:
                    results = _search_learn(self.api_url, query, scope=scope)
                except requests.exceptions.HTTPError:
                    print(f" — error")
                    continue
                new_count = 0
                for item in results:
                    url = item.get("url", "")
                    if not url or url in all_results:
                        continue
                    all_results[url] = item

                    title = (item.get("title", "") or "").lower()
                    url_lower = url.lower()
                    combined = f"{title} {url_lower}"
                    if self.exclude_url_patterns and _matches_any(combined, self.exclude_url_patterns):
                        continue

                    if self.relevance_terms:
                        preview = (item.get("preview", "") or "").lower()
                        search_text = f"{title} {url_lower} {preview}"
                        if not any(term.lower() in search_text for term in self.relevance_terms):
                            continue

                    filtered[url] = item
                    new_count += 1
                print(f" — {len(results)} results, {new_count} new")

        print(f"  Learn search: {len(all_results)} total results, {len(filtered)} after filtering")
        return list(filtered.values())

    def _fetch_pages(self, urls: List[str]) -> Iterator[Dict[str, Any]]:
        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            future_to_url = {pool.submit(_fetch_page_text, u): u for u in urls}
            for future in as_completed(future_to_url):
                url = future_to_url[future]
                try:
                    text = future.result()
                    yield {"url": url, "repo": "", "text": text}
                except Exception:
                    pass
