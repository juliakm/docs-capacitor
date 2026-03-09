"""TopicRulesClassifier — deterministic topic-based classification.

Uses generic scope patterns (product_patterns/tool_patterns) from strategy
YAML and a generic section key from config instead of hardcoded product names.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from capacitor.classifiers.base import BaseClassifier
from capacitor.classifiers import register_classifier

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

CLASSIFICATIONS = ("P0_OUTDATED", "NEEDS_CLARIFICATION", "UP_TO_DATE", "EXCLUDED")


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _normalize_finding(rec: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(rec)
    if "url_or_file" not in out and "url" in out:
        out["url_or_file"] = out["url"]
    if "evidence_snippet" not in out and "conflict" in out:
        out["evidence_snippet"] = out["conflict"]
    return out


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key, val in override.items():
        if key == "topic_rules" and isinstance(val, list):
            base_topics: list = list(merged.get("topic_rules", []))
            override_ids = {t["id"] for t in val if isinstance(t, dict) and "id" in t}
            merged[key] = [t for t in base_topics if t.get("id") not in override_ids] + val
        elif key in merged and isinstance(merged[key], dict) and isinstance(val, dict):
            merged[key] = _deep_merge(merged[key], val)
        elif key in merged and isinstance(merged[key], list) and isinstance(val, list):
            seen: set = set()
            combined = []
            for item in merged[key] + val:
                s = str(item)
                if s not in seen:
                    seen.add(s)
                    combined.append(item)
            merged[key] = combined
        else:
            merged[key] = val
    return merged


def load_strategy(path: Path) -> Dict[str, Any]:
    if yaml is None:
        raise ImportError("pyyaml is required: pip install pyyaml")
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    extends = data.pop("extends", None)
    if extends:
        base_path = (path.parent / extends).resolve()
        base = load_strategy(base_path)
        data = _deep_merge(base, data)
    return data


def filter_strategy_by_areas(strategy: Dict[str, Any], selected_areas: List[str]) -> Dict[str, Any]:
    if not selected_areas:
        return strategy
    selected = {a.strip().lower() for a in selected_areas if a.strip()}
    if not selected:
        return strategy
    topic_rules = strategy.get("topic_rules", [])
    filtered = [
        t for t in topic_rules
        if str(t.get("area") or t.get("id") or "").strip().lower() in selected
        or str(t.get("id") or "").strip().lower() in selected
    ]
    new_strategy = dict(strategy)
    new_strategy["topic_rules"] = filtered
    meta = dict(new_strategy.get("meta") or {})
    meta["selected_areas"] = sorted(selected)
    new_strategy["meta"] = meta
    return new_strategy


def compile_patterns(patterns: Iterable[str]) -> List[re.Pattern]:
    return [re.compile(p) for p in patterns]


def any_match(patterns: List[re.Pattern], text: str) -> Optional[re.Match]:
    for p in patterns:
        m = p.search(text)
        if m:
            return m
    return None


def contains_any(patterns: List[re.Pattern], text: str) -> bool:
    return any(p.search(text) for p in patterns)


def first_match(patterns: List[re.Pattern], text: str) -> Optional[re.Match]:
    return any_match(patterns, text)


def extract_evidence(text: str, match: Optional[re.Match], max_chars: int = 220) -> str:
    if not match:
        return ""
    start = max(0, match.start() - max_chars // 2)
    end = min(len(text), match.end() + max_chars // 2)
    snippet = text[start:end].strip()
    return " ".join(snippet.split())


def normalize_url_for_compare(url: str) -> str:
    return url.split("#")[0].strip()


def aggregate_findings(findings: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    grouped: Dict[str, Dict[str, Any]] = {}
    for rec in (_normalize_finding(r) for r in findings):
        raw_url = (rec.get("url_or_file") or "").strip()
        if not raw_url:
            continue
        key = normalize_url_for_compare(raw_url)
        entry = grouped.setdefault(
            key,
            {"url": raw_url, "repo": rec.get("repo", "") or "", "records": [], "rule_ids": set(), "severities": set()},
        )
        entry["records"].append(rec)
        entry["rule_ids"].add(rec.get("rule_id", ""))
        entry["severities"].add(rec.get("severity", ""))
        if not entry["repo"]:
            entry["repo"] = rec.get("repo", "") or ""
    return grouped


def build_page_index(pages: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    index: Dict[str, Dict[str, Any]] = {}
    for rec in pages:
        raw_url = (rec.get("url") or "").strip()
        if not raw_url:
            continue
        index[normalize_url_for_compare(raw_url)] = rec
    return index


def regex_signal_for_group(group: Dict[str, Any]) -> str:
    severities = {str(s).upper() for s in group.get("severities", set())}
    rule_ids = {str(r).upper() for r in group.get("rule_ids", set())}
    if "P0" in severities:
        return "P0"
    if "INFO" in severities:
        return "INFO"
    if "EXCLUDED" in rule_ids:
        return "EXCLUDED"
    return "none"


def agrees_with_regex(classification: str, regex_signal: str) -> bool:
    if classification == "P0_OUTDATED":
        return regex_signal == "P0"
    if classification == "UP_TO_DATE":
        return regex_signal in {"INFO", "none"}
    if classification == "EXCLUDED":
        return regex_signal == "EXCLUDED"
    if classification == "NEEDS_CLARIFICATION":
        return regex_signal == "none"
    return False


def classify_page(
    url: str,
    repo: str,
    text: str,
    group: Dict[str, Any],
    regex_signal: str,
    strategy: Dict[str, Any],
    release_notes: Dict[str, Any],
    section_key: str = "product_sections",
) -> Dict[str, Any]:
    """Classify a single page using generic scope patterns from strategy."""
    hard_ex_url = compile_patterns(strategy.get("hard_exclusions", {}).get("url_regex", []))
    hard_ex_repo = compile_patterns(strategy.get("hard_exclusions", {}).get("repo_regex", []))

    # Generic scope patterns (not hardcoded to any product)
    scope_cfg = strategy.get("scope", {})
    product_patterns = compile_patterns(scope_cfg.get("product_patterns", []))
    tool_patterns = compile_patterns(scope_cfg.get("tool_patterns", []))

    confidence_cfg = strategy.get("classification", {}).get("default_confidence", {})
    topic_rules = strategy.get("topic_rules", [])

    lowered_text = (text or "").lower()
    product_sections = release_notes.get(section_key, [])

    regex_rule_ids = sorted([rid for rid in group.get("rule_ids", set()) if rid and rid not in {"NO_MATCH", "EXCLUDED"}])
    regex_evidence = [rec.get("evidence_snippet", "") for rec in group.get("records", []) if rec.get("evidence_snippet")][:2]

    release_conflict_topic_id = None
    release_conflict_topic_title = None
    release_conflict_section = None
    release_conflict_evidence = None

    if any_match(hard_ex_url, url) or any_match(hard_ex_repo, repo):
        classification = "EXCLUDED"
        reason = "Page matches hard exclusion rules from the rubric."
        evidence: List[str] = []
        suggested_fix = None
        confidence = confidence_cfg.get("excluded", "high")
    else:
        product_hit = any_match(product_patterns, lowered_text)
        tool_hit = any_match(tool_patterns, lowered_text)

        if not (product_hit and tool_hit):
            classification = "EXCLUDED"
            reason = "Page is out of scope: does not mention both the product and tool."
            evidence = [e for e in [extract_evidence(lowered_text, product_hit), extract_evidence(lowered_text, tool_hit)] if e]
            suggested_fix = None
            confidence = confidence_cfg.get("excluded", "high")
        else:
            matched_topic_id = None
            matched_topic_title = None
            matched_stale: Optional[re.Match] = None
            matched_current: Optional[re.Match] = None
            topic_seen_in_notes = False

            for topic in topic_rules:
                release_signals = compile_patterns(topic.get("release_signals", {}).get("any_regex", []))
                page_topic_signals = compile_patterns(topic.get("page_topic_signals", {}).get("any_regex", []))
                stale_signals = compile_patterns(topic.get("stale_signals", {}).get("any_regex", []))
                stale_exceptions = compile_patterns(topic.get("stale_exceptions", {}).get("any_regex", []))
                current_signals = compile_patterns(topic.get("current_signals", {}).get("any_regex", []))

                if not release_signals or not page_topic_signals:
                    continue

                matched_release_section = None
                matched_release_evidence = None
                for section in product_sections:
                    section_text = f"{section.get('heading', '')}\n{section.get('content', '')}"
                    match_release = first_match(release_signals, section_text)
                    if match_release is not None:
                        matched_release_section = section.get("heading", "")
                        matched_release_evidence = extract_evidence(section_text, match_release)
                        break

                if matched_release_section is None:
                    continue
                if not contains_any(page_topic_signals, lowered_text):
                    continue

                topic_seen_in_notes = True
                release_conflict_topic_id = topic.get("id", "topic")
                release_conflict_topic_title = topic.get("title", release_conflict_topic_id)
                release_conflict_section = matched_release_section
                release_conflict_evidence = matched_release_evidence

                stale_match = first_match(stale_signals, lowered_text)
                has_exception = contains_any(stale_exceptions, lowered_text)
                current_match = first_match(current_signals, lowered_text)

                if stale_match and not has_exception:
                    matched_topic_id = topic.get("id", "topic")
                    matched_topic_title = topic.get("title", matched_topic_id)
                    matched_stale = stale_match
                    break

                if current_match and matched_current is None:
                    matched_topic_id = topic.get("id", "topic")
                    matched_topic_title = topic.get("title", matched_topic_id)
                    matched_current = current_match

            if matched_stale is not None:
                classification = "P0_OUTDATED"
                reason = f"Page contains stale guidance conflicting with release notes for topic '{matched_topic_title}'."
                evidence = [extract_evidence(lowered_text, matched_stale)]
                suggested_fix = "Update this guidance to match the current release-notes-backed behavior for the same topic."
                confidence = confidence_cfg.get("p0_outdated", "high")
            elif matched_current is not None:
                classification = "UP_TO_DATE"
                reason = f"Page guidance aligns with release notes for topic '{matched_topic_title}'."
                evidence = [extract_evidence(lowered_text, matched_current)]
                suggested_fix = None
                confidence = confidence_cfg.get("up_to_date", "medium")
            else:
                classification = "NEEDS_CLARIFICATION"
                if topic_seen_in_notes:
                    reason = "No explicit stale or current signal was detected for matching release-note topics."
                else:
                    reason = "No matching release-note topic was detected for this page's guidance."
                evidence = [e for e in [extract_evidence(lowered_text, product_hit), extract_evidence(lowered_text, tool_hit)] if e]
                suggested_fix = "Clarify the guidance with version/topic-specific statements that can be validated."
                confidence = confidence_cfg.get("needs_clarification", "medium")

    return {
        "page_url": url,
        "repo": repo or "",
        "classification": classification,
        "confidence": confidence,
        "evidence": evidence,
        "reason": reason,
        "suggested_fix": suggested_fix,
        "regex_signal": regex_signal,
        "regex_rule_ids": regex_rule_ids,
        "regex_evidence": regex_evidence,
        "release_conflict_topic_id": release_conflict_topic_id,
        "release_conflict_topic_title": release_conflict_topic_title,
        "release_conflict_section": release_conflict_section,
        "release_conflict_evidence": release_conflict_evidence,
        "agrees_with_regex": agrees_with_regex(classification, regex_signal),
    }


# ------------------------------------------------------------------
# TopicRulesClassifier class
# ------------------------------------------------------------------

@register_classifier("topic_rules")
class TopicRulesClassifier(BaseClassifier):
    """Deterministic topic-rules classifier using strategy YAML + release notes."""

    @property
    def name(self) -> str:
        return "topic_rules"

    def __init__(
        self,
        *,
        strategy_path: str | Path | None = None,
        release_notes_path: str | Path | None = None,
        areas: list[str] | None = None,
        section_key: str = "product_sections",
    ):
        self.strategy_path = Path(strategy_path) if strategy_path else None
        self.release_notes_path = Path(release_notes_path) if release_notes_path else None
        self.areas = areas or []
        self.section_key = section_key

    def classify(
        self,
        findings: List[Dict[str, Any]],
        pages: List[Dict[str, Any]],
        **kwargs: Any,
    ) -> List[Dict[str, Any]]:
        if self.strategy_path is None or self.release_notes_path is None:
            raise ValueError("strategy_path and release_notes_path are required")

        strategy = load_strategy(self.strategy_path)
        strategy = filter_strategy_by_areas(strategy, self.areas)

        if not strategy.get("topic_rules"):
            selected = ", ".join(self.areas) if self.areas else "(none)"
            print(f"No topic rules available for selected area(s): {selected}")
            return []

        release_notes = json.loads(self.release_notes_path.read_text(encoding="utf-8"))
        grouped = aggregate_findings(findings)
        page_index = build_page_index(pages)

        classifications: List[Dict[str, Any]] = []
        for norm_url in sorted(grouped.keys()):
            group = grouped[norm_url]
            regex_signal = regex_signal_for_group(group)
            page = page_index.get(norm_url)
            if page is None:
                page = {"url": group["url"], "repo": group.get("repo", ""), "text": ""}
            rec = classify_page(
                url=page.get("url") or group["url"],
                repo=page.get("repo") or group.get("repo", ""),
                text=page.get("text", "") or "",
                group=group,
                regex_signal=regex_signal,
                strategy=strategy,
                release_notes=release_notes,
                section_key=self.section_key,
            )
            classifications.append(rec)

        _cls_order = {c: i for i, c in enumerate(CLASSIFICATIONS)}
        classifications.sort(key=lambda r: _cls_order.get(r.get("classification", ""), len(CLASSIFICATIONS)))
        return classifications
