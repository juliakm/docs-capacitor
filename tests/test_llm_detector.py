"""Tests for LLMDetector max_pages parameter."""

from pathlib import Path
from unittest.mock import MagicMock, patch
import json
import pytest

from capacitor.detectors.llm_detector import LLMDetector, _cache_key


def _make_pages(n: int, prefix: str = "https://learn.microsoft.com/page") -> list[dict]:
    return [{"url": f"{prefix}{i}", "text": f"some content about the product {i}"} for i in range(n)]


def _make_detector(tmp_path: Path, max_pages: int | None = None) -> LLMDetector:
    release_notes = tmp_path / "release_notes.json"
    release_notes.write_text(json.dumps({"key_facts": ["Fact A", "Fact B"]}))
    return LLMDetector(
        github_token="fake-token",
        release_notes_path=release_notes,
        cache_dir=tmp_path / "cache",
        use_cache=True,
        max_pages=max_pages,
    )


def _populate_cache(detector: LLMDetector, pages: list[dict]) -> None:
    """Pre-populate the cache for given pages so they are treated as cached."""
    key_facts = ["Fact A", "Fact B"]
    for page in pages:
        ck = _cache_key(page["url"], page["text"], key_facts, detector.max_article_chars)
        from capacitor.detectors.llm_detector import _set_cached
        _set_cached(detector.cache_dir, ck, [])


class TestMaxPagesLimitsUncached:
    """max_pages caps the number of uncached pages sent to the LLM."""

    def test_max_pages_limits_uncached(self, tmp_path: Path) -> None:
        detector = _make_detector(tmp_path, max_pages=3)
        pages = _make_pages(5)

        with patch.object(detector, "_is_configured", return_value=True), \
             patch.object(detector, "_check_page", return_value=[]) as mock_check:
            detector.detect(pages)

        assert mock_check.call_count == 3


class TestMaxPagesCachedPagesAreFree:
    """Cached pages are always processed; max_pages only limits uncached ones."""

    def test_max_pages_cached_pages_are_free(self, tmp_path: Path) -> None:
        detector = _make_detector(tmp_path, max_pages=3)
        cached = _make_pages(3, prefix="https://learn.microsoft.com/cached")
        uncached = _make_pages(4, prefix="https://learn.microsoft.com/uncached")
        _populate_cache(detector, cached)

        with patch.object(detector, "_is_configured", return_value=True), \
             patch.object(detector, "_check_page", return_value=[]) as mock_check:
            detector.detect(cached + uncached)

        # 3 cached (all free) + 3 uncached (capped) = 6 total
        assert mock_check.call_count == 6


class TestMaxPagesNoneProcessesAll:
    """With max_pages=None (default), all pages are processed."""

    def test_max_pages_none_processes_all(self, tmp_path: Path) -> None:
        detector = _make_detector(tmp_path, max_pages=None)
        pages = _make_pages(5)

        with patch.object(detector, "_is_configured", return_value=True), \
             patch.object(detector, "_check_page", return_value=[]) as mock_check:
            detector.detect(pages)

        assert mock_check.call_count == 5


class TestMaxPagesUnderLimitNoTrim:
    """When uncached pages are under max_pages, all are processed without trimming."""

    def test_max_pages_under_limit_no_trim(self, tmp_path: Path) -> None:
        detector = _make_detector(tmp_path, max_pages=5)
        pages = _make_pages(2)

        with patch.object(detector, "_is_configured", return_value=True), \
             patch.object(detector, "_check_page", return_value=[]) as mock_check:
            detector.detect(pages)

        assert mock_check.call_count == 2
