"""Tests for GitHub search rate-limit helper logic."""

from __future__ import annotations

import subprocess

import capacitor.collectors.github_search as gh_search


def test_parse_rate_limit_prefers_code_search_bucket() -> None:
    payload = {
        "resources": {
            "code_search": {"remaining": 7, "reset": 123456, "limit": 10},
            "search": {"remaining": 50, "reset": 654321, "limit": 60},
        }
    }
    parsed = gh_search._parse_search_rate_limit_payload(payload)
    assert parsed == {"bucket": "code_search", "remaining": 7, "reset": 123456, "limit": 10}


def test_parse_rate_limit_falls_back_to_search_bucket() -> None:
    payload = {
        "resources": {
            "code_search": {},
            "search": {"remaining": "3", "reset": "987654", "limit": "30"},
        }
    }
    parsed = gh_search._parse_search_rate_limit_payload(payload)
    assert parsed == {"bucket": "search", "remaining": 3, "reset": 987654, "limit": 30}


def test_retryable_error_detects_rate_limit_markers() -> None:
    result = subprocess.CompletedProcess(
        args=["gh", "search", "code"],
        returncode=1,
        stdout="",
        stderr="HTTP 403: API rate limit exceeded",
    )
    assert gh_search._is_retryable_search_error(result)


def test_retryable_error_rejects_non_retriable_status() -> None:
    result = subprocess.CompletedProcess(
        args=["gh", "search", "code"],
        returncode=1,
        stdout="",
        stderr="HTTP 404: Not Found",
    )
    assert not gh_search._is_retryable_search_error(result)


def test_wait_for_search_rate_limit_uses_bounded_chunked_sleep(monkeypatch) -> None:
    sleeps: list[float] = []

    monkeypatch.setattr(
        gh_search,
        "_gh_search_rate_limit_status",
        lambda: {"bucket": "code_search", "remaining": 0, "reset": 1200, "limit": 30},
    )
    monkeypatch.setattr(gh_search.time, "time", lambda: 1000)
    monkeypatch.setattr(gh_search, "RATE_LIMIT_SLEEP_CHUNK_SECONDS", 20)
    monkeypatch.setattr(gh_search.time, "sleep", lambda seconds: sleeps.append(seconds))

    gh_search._wait_for_search_rate_limit(max_wait_seconds=65)

    assert sleeps == [20, 20, 20, 5]
