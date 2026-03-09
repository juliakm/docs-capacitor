"""RegexDetector — deterministic regex-based freshness scanner.

Rules are loaded from YAML (path provided by scenario config).
The rule engine is fully generic — no product-specific logic.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from capacitor.detectors.base import BaseDetector
from capacitor.detectors import register_detector

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]


# ------------------------------------------------------------------
# Rule data model
# ------------------------------------------------------------------

@dataclass
class Rule:
    rule_id: str
    title: str
    severity: str
    any_patterns: List[re.Pattern]
    all_patterns: List[re.Pattern]
    unless_any: List[re.Pattern]


def _compile(patterns: List[str]) -> List[re.Pattern]:
    return [re.compile(p) for p in patterns]


def load_rules_config(path: Path) -> Dict[str, Any]:
    if yaml is None:
        raise ImportError("pyyaml is required: pip install pyyaml")
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def build_rules(cfg: Dict[str, Any]) -> List[Rule]:
    rules: List[Rule] = []
    for r in cfg.get("rules", []):
        match = r.get("match", {})
        unless = r.get("unless", {})
        rules.append(
            Rule(
                rule_id=r["id"],
                title=r.get("title", ""),
                severity=r.get("severity", "INFO"),
                any_patterns=_compile(match.get("any_regex", [])),
                all_patterns=_compile(match.get("all_regex", [])),
                unless_any=_compile(unless.get("any_regex", [])),
            )
        )
    return rules


# ------------------------------------------------------------------
# Filter & match helpers
# ------------------------------------------------------------------

def passes_filters(page: Dict[str, Any], filters_cfg: Dict[str, Any]) -> bool:
    url = page.get("url", "") or ""
    repo = page.get("repo", "") or ""
    include = filters_cfg.get("include", {})
    exclude = filters_cfg.get("exclude", {})

    inc_url = include.get("url_regex", [])
    if inc_url and not any(re.search(p, url) for p in inc_url):
        return False
    inc_repo = include.get("repo_regex", [])
    if inc_repo and not any(re.search(p, repo) for p in inc_repo):
        return False
    exc_url = exclude.get("url_regex", [])
    if exc_url and any(re.search(p, url) for p in exc_url):
        return False
    exc_repo = exclude.get("repo_regex", [])
    if exc_repo and any(re.search(p, repo) for p in exc_repo):
        return False
    return True


def extract_snippet(text: str, match: re.Match, window: int = 160) -> str:
    start = max(0, match.start() - window)
    end = min(len(text), match.end() + window)
    snippet = text[start:end].replace("\r", " ").replace("\n", " ")
    return re.sub(r"\s+", " ", snippet).strip()


def rule_match(rule: Rule, text: str) -> Optional[str]:
    for p in rule.unless_any:
        if p.search(text):
            return None
    for p in rule.all_patterns:
        if not p.search(text):
            return None
    if rule.any_patterns:
        for p in rule.any_patterns:
            m = p.search(text)
            if m:
                return extract_snippet(text, m)
        return None
    return "Matched all required patterns"


# ------------------------------------------------------------------
# RegexDetector class
# ------------------------------------------------------------------

@register_detector("regex")
class RegexDetector(BaseDetector):
    """Deterministic regex scanner using rules YAML."""

    @property
    def name(self) -> str:
        return "regex"

    def __init__(self, *, rules_yaml: str | Path | None = None):
        self.rules_yaml = Path(rules_yaml) if rules_yaml else None
        self._cfg: Dict[str, Any] | None = None
        self._rules: List[Rule] | None = None

    def _load(self) -> None:
        if self._cfg is not None:
            return
        if self.rules_yaml is None:
            raise ValueError("rules_yaml path is required for RegexDetector")
        self._cfg = load_rules_config(self.rules_yaml)
        self._rules = build_rules(self._cfg)

    def detect(
        self,
        pages: List[Dict[str, Any]],
        *,
        emit_all: bool = False,
        **kwargs: Any,
    ) -> List[Dict[str, Any]]:
        self._load()
        assert self._cfg is not None and self._rules is not None

        filters_cfg = self._cfg.get("filters", {})
        findings: List[Dict[str, Any]] = []

        for page in pages:
            url = page.get("url") or page.get("file") or ""
            repo = page.get("repo") or ""
            text = page.get("text") or ""

            if not passes_filters(page, filters_cfg):
                if emit_all:
                    findings.append({
                        "url_or_file": url,
                        "url": url,
                        "repo": repo,
                        "rule_id": "EXCLUDED",
                        "severity": "EXCLUDED",
                        "title": "Page excluded by scope filters",
                        "evidence_snippet": "",
                        "source": "regex",
                    })
                continue

            matched = False
            for rule in self._rules:
                evidence = rule_match(rule, text)
                if evidence:
                    matched = True
                    findings.append({
                        "url_or_file": url,
                        "url": url,
                        "repo": repo,
                        "rule_id": rule.rule_id,
                        "severity": rule.severity,
                        "title": rule.title,
                        "evidence_snippet": evidence,
                        "source": "regex",
                    })

            if not matched and emit_all:
                findings.append({
                    "url_or_file": url,
                    "url": url,
                    "repo": repo,
                    "rule_id": "NO_MATCH",
                    "severity": "NEEDS_CLARIFICATION",
                    "title": "In scope but no deterministic rule matched",
                    "evidence_snippet": "",
                    "source": "regex",
                })

        return findings
