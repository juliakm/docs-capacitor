"""MarkdownReporter — generate a Markdown freshness report.

Report title and section references come from scenario config.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from capacitor.reporters.base import BaseReporter
from capacitor.reporters import register_reporter

from capacitor.classifiers.topic_rules import CLASSIFICATIONS


@register_reporter("markdown")
class MarkdownReporter(BaseReporter):
    """Write a Markdown report of classified results."""

    @property
    def name(self) -> str:
        return "markdown"

    def report(
        self,
        classifications: List[Dict[str, Any]],
        out_dir: Path,
        *,
        release_notes: Dict[str, Any] | None = None,
        strategy: Dict[str, Any] | None = None,
        report_title: str = "Documentation Freshness Report",
        section_key: str = "product_sections",
        **kwargs: Any,
    ) -> Path:
        release_notes = release_notes or {}
        strategy = strategy or {}

        from collections import Counter
        counts = Counter(row["classification"] for row in classifications)
        disagreements = [row for row in classifications if not row.get("agrees_with_regex", False)]

        latest_version = ""
        for section in release_notes.get(section_key, []):
            version = section.get("version", "")
            if version:
                latest_version = version
                break

        lines: List[str] = [
            f"# {report_title}",
            "",
            f"Generated at: {datetime.now(timezone.utc).isoformat()}",
            "",
            "## Summary",
            f"- Total pages scanned: {len(classifications)}",
        ]
        for cls in CLASSIFICATIONS:
            lines.append(f"- {cls}: {counts.get(cls, 0)}")
        lines += [
            "",
            "## Release Notes Ground Truth",
            f"- Source: {release_notes.get('source_url', '')}",
            f"- Latest version seen: {latest_version or 'unknown'}",
            "- Baseline: classifications are based on configurable topic conflicts between "
            "release notes and article content.",
            "",
        ]

        scenario_name = str((strategy.get("meta") or {}).get("name") or "selected scenario")
        scenario_notes_raw = (strategy.get("meta") or {}).get("narrative_instructions") or []
        scenario_notes = [scenario_notes_raw] if isinstance(scenario_notes_raw, str) else [str(n) for n in scenario_notes_raw if str(n).strip()]

        topic_notes: List[str] = []
        for topic in strategy.get("topic_rules", []):
            tid = str(topic.get("id") or "topic")
            ttitle = str(topic.get("title") or tid)
            raw = topic.get("narrative_instructions") or []
            notes = [raw] if isinstance(raw, str) else [str(n) for n in raw if str(n).strip()]
            for note in notes:
                topic_notes.append(f"{ttitle} ({tid}): {note}")

        if scenario_notes or topic_notes:
            lines.append("## Scenario Guidance")
            lines.append(f"- Scenario: {scenario_name}")
            for note in scenario_notes:
                lines.append(f"- {note}")
            for note in topic_notes:
                lines.append(f"- {note}")
            lines.append("")

        lines += [
            "## Detailed Table",
            "",
            "| URL | Regex Signal | Regex Rule IDs | Release Topic | Release Note Section | Agent Classification | Agrees? | Confidence | Reason | Suggested Fix |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for row in classifications:
            url = row["page_url"].replace("|", "%7C")
            rids = ", ".join(row.get("regex_rule_ids", []))
            rtopic = str(row.get("release_conflict_topic_title") or "").replace("|", "\\|")
            rsection = str(row.get("release_conflict_section") or "").replace("|", "\\|")
            reason = str(row.get("reason", "")).replace("|", "\\|")
            fix = row.get("suggested_fix")
            fix_str = "" if fix is None else str(fix).replace("|", "\\|")
            lines.append(
                f"| {url} | {row.get('regex_signal', 'none')} | {rids} | {rtopic} | {rsection} | "
                f"{row.get('classification')} | {row.get('agrees_with_regex')} | {row.get('confidence')} | "
                f"{reason} | {fix_str} |"
            )

        lines += ["", "## Classification vs Regex Disagreements"]
        if not disagreements:
            lines.append("- None")
        else:
            for row in disagreements:
                regex_rules = ", ".join(row.get("regex_rule_ids", [])) or "none"
                release_ref = row.get("release_conflict_section") or row.get("release_conflict_topic_title") or "none"
                lines.append(
                    f"- {row['page_url']}: regex={row.get('regex_signal')} vs classification={row.get('classification')} "
                    f"(regex_rules={regex_rules}; release_note_ref={release_ref}; {row.get('reason')})"
                )

        report_path = out_dir / "report.md"
        out_dir.mkdir(parents=True, exist_ok=True)
        report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return report_path
