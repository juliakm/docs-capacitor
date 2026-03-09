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


def _search_learn(api_url: str, query: str, top: int = 25) -> List[Dict[str, Any]]:
    params = {"search": query, "locale": "en-us", "top": top}
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
        exclude_url_patterns: list[str] | None = None,
        relevance_terms: list[str] | None = None,
        max_workers: int = 5,
    ):
        self.api_url = api_url
        self.queries = queries or []
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

        for query in self.queries:
            try:
                results = _search_learn(self.api_url, query)
            except requests.exceptions.HTTPError:
                continue
            for item in results:
                url = item.get("url", "")
                if not url or url in all_results:
                    continue
                all_results[url] = item

                # Check exclusion patterns against URL and title
                title = (item.get("title", "") or "").lower()
                url_lower = url.lower()
                combined = f"{title} {url_lower}"
                if self.exclude_url_patterns and _matches_any(combined, self.exclude_url_patterns):
                    continue

                # Check relevance (product keywords in title/url/preview)
                if self.relevance_terms:
                    preview = (item.get("preview", "") or "").lower()
                    search_text = f"{title} {url_lower} {preview}"
                    if not any(term.lower() in search_text for term in self.relevance_terms):
                        continue

                filtered[url] = item

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
