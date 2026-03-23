"""Internal Learn Knowledge Service collector with Entra authentication.

Uses DefaultAzureCredential by default (or an explicit bearer token via env)
to query an internal Learn service endpoint and collect page content.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, Iterator, List, Optional

import requests
from bs4 import BeautifulSoup

from capacitor.collectors import register_collector
from capacitor.collectors.base import BaseCollector


def _matches_any(text: str, patterns: List[str]) -> bool:
    return any(pattern in text for pattern in patterns)


def _extract_url(item: Dict[str, Any]) -> str:
    for key in ("url", "contentUrl", "webUrl", "uri"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


@register_collector("learn_internal")
class LearnInternalCollector(BaseCollector):
    """Collect pages via internal Learn Knowledge Service."""

    @property
    def name(self) -> str:
        return "learn_internal"

    def __init__(
        self,
        *,
        service_url: str,
        scope: str,
        queries: list[str] | None = None,
        path_scopes: list[str] | None = None,
        exclude_url_patterns: list[str] | None = None,
        relevance_terms: list[str] | None = None,
        search_path: str = "/api/search",
        max_workers: int = 5,
    ):
        if not service_url:
            raise ValueError("service_url is required for learn_internal collector")
        if not scope:
            raise ValueError("scope is required for learn_internal collector")

        self.service_url = service_url.rstrip("/")
        self.scope = scope
        self.search_path = search_path
        self.queries = queries or []
        self.path_scopes = path_scopes or [""]
        self.exclude_url_patterns = exclude_url_patterns or []
        self.relevance_terms = relevance_terms or []
        self.max_workers = max_workers

    def _auth_headers(self) -> Dict[str, str]:
        explicit = os.getenv("LEARN_KNOWLEDGE_SERVICE_TOKEN", "").strip()
        if explicit:
            return {"Authorization": f"Bearer {explicit}"}

        try:
            from azure.identity import DefaultAzureCredential
        except Exception as exc:
            raise RuntimeError(
                "azure-identity is required for internal Learn auth. "
                "Install with: pip install 'docs-capacitor[learn-auth]'"
            ) from exc

        credential = DefaultAzureCredential(exclude_interactive_browser_credential=False)
        token = credential.get_token(self.scope).token
        return {"Authorization": f"Bearer {token}"}

    def _search_internal(self, query: str, scope: str = "", top: int = 30) -> List[Dict[str, Any]]:
        scoped_query = f"{query} {scope.strip('/')}" if scope else query
        url = f"{self.service_url}{self.search_path}"
        params = {"search": scoped_query, "locale": "en-us", "$top": top}
        resp = requests.get(url, params=params, headers=self._auth_headers(), timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        if isinstance(payload, dict):
            results = payload.get("results", [])
            return results if isinstance(results, list) else []
        return []

    def _fetch_page_text(self, url: str, timeout: int = 20) -> str:
        resp = requests.get(url, headers=self._auth_headers(), timeout=timeout)
        resp.raise_for_status()
        ctype = (resp.headers.get("content-type") or "").lower()
        if "application/json" in ctype:
            body = resp.json()
            if isinstance(body, dict):
                for key in ("text", "content", "body", "markdown"):
                    val = body.get(key)
                    if isinstance(val, str) and val.strip():
                        return val
            return ""
        soup = BeautifulSoup(resp.text, "html.parser")
        main = soup.find("main") or soup.find("article") or soup.body
        return main.get_text(separator=" ", strip=True) if main else ""

    def collect(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
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
                    results = self._search_internal(query, scope=scope)
                except requests.exceptions.HTTPError:
                    print(" — error")
                    continue
                new_count = 0
                for item in results:
                    if not isinstance(item, dict):
                        continue
                    url = _extract_url(item)
                    if not url or url in all_results:
                        continue
                    normalized = dict(item)
                    normalized["url"] = url
                    all_results[url] = normalized

                    title = (normalized.get("title", "") or "").lower()
                    url_lower = url.lower()
                    combined = f"{title} {url_lower}"
                    if self.exclude_url_patterns and _matches_any(combined, self.exclude_url_patterns):
                        continue

                    if self.relevance_terms:
                        preview = (normalized.get("preview", "") or "").lower()
                        search_text = f"{title} {url_lower} {preview}"
                        if not any(term.lower() in search_text for term in self.relevance_terms):
                            continue

                    filtered[url] = normalized
                    new_count += 1
                print(f" — {len(results)} results, {new_count} new")

        print(f"  Internal Learn search: {len(all_results)} total, {len(filtered)} after filtering")
        return list(filtered.values())

    def _fetch_pages(self, urls: List[str]) -> Iterator[Dict[str, Any]]:
        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            future_to_url = {pool.submit(self._fetch_page_text, u): u for u in urls}
            for future in as_completed(future_to_url):
                url = future_to_url[future]
                try:
                    text = future.result()
                    yield {"url": url, "repo": "", "text": text}
                except Exception:
                    pass
