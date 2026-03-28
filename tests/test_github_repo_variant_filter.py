"""Tests for repo variant dedupe (public repo vs private -pr mirror)."""

from capacitor.collectors.github_search import (
    _canonical_repo_path_key,
    _merge_repo_variant_hit,
)


def test_canonical_key_collapses_pr_variant() -> None:
    pub = _canonical_repo_path_key("MicrosoftDocs/windows-dev-docs", "foo/bar.md")
    prv = _canonical_repo_path_key("MicrosoftDocs/windows-dev-docs-pr", "foo/bar.md")
    assert pub == prv


def test_merge_prefers_public_when_private_seen_first() -> None:
    selected: dict[str, dict[str, str]] = {}
    _merge_repo_variant_hit(
        selected,
        {"repo": "MicrosoftDocs/windows-dev-docs-pr", "path": "hub/apps/get-started/ai-setup.md"},
    )
    _merge_repo_variant_hit(
        selected,
        {"repo": "MicrosoftDocs/windows-dev-docs", "path": "hub/apps/get-started/ai-setup.md"},
    )
    assert len(selected) == 1
    only = next(iter(selected.values()))
    assert only["repo"] == "MicrosoftDocs/windows-dev-docs"


def test_merge_keeps_public_when_seen_first() -> None:
    selected: dict[str, dict[str, str]] = {}
    _merge_repo_variant_hit(
        selected,
        {"repo": "MicrosoftDocs/windows-dev-docs", "path": "hub/apps/get-started/ai-setup.md"},
    )
    _merge_repo_variant_hit(
        selected,
        {"repo": "MicrosoftDocs/windows-dev-docs-pr", "path": "hub/apps/get-started/ai-setup.md"},
    )
    assert len(selected) == 1
    only = next(iter(selected.values()))
    assert only["repo"] == "MicrosoftDocs/windows-dev-docs"

