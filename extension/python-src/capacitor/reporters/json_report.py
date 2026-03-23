"""JSONReporter — generate a JSON freshness report for the VS Code extension."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from capacitor.reporters.base import BaseReporter
from capacitor.reporters import register_reporter


@register_reporter("json")
class JSONReporter(BaseReporter):
    """Write a JSON file of all classified results (used by the VS Code extension)."""

    @property
    def name(self) -> str:
        return "json"

    def report(
        self,
        classifications: List[Dict[str, Any]],
        out_dir: Path,
        *,
        release_notes: Dict[str, Any] | None = None,
        strategy: Dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Path:
        json_path = out_dir / f"classifications{kwargs.get('file_suffix', '')}.json"
        out_dir.mkdir(parents=True, exist_ok=True)

        # Only include actionable results — UP_TO_DATE and EXCLUDED are noise
        ACTIONABLE = {"P0_OUTDATED", "NEEDS_CLARIFICATION"}

        output = []
        skipped = 0
        for row in classifications:
            classification = row.get("classification", "unknown")
            if classification not in ACTIONABLE:
                skipped += 1
                continue
            # Normalize evidence to a single string
            evidence_raw = row.get("evidence", [])
            if isinstance(evidence_raw, list):
                evidence = " | ".join(str(e) for e in evidence_raw if e)
            else:
                evidence = str(evidence_raw or "")

            regex_evidence_raw = row.get("regex_evidence", [])
            if isinstance(regex_evidence_raw, list):
                regex_evidence = " | ".join(str(e) for e in regex_evidence_raw if e)
            else:
                regex_evidence = str(regex_evidence_raw or "")

            output.append({
                "url": row.get("page_url", ""),
                "title": row.get("title", _title_from_url(row.get("page_url", ""))),
                "classification": row.get("classification", "unknown"),
                "confidence": row.get("confidence", 0),
                "topic": row.get("release_conflict_topic_title", ""),
                "reason": row.get("reason", ""),
                "suggested_fix": row.get("suggested_fix", ""),
                "evidence": evidence,
                "regex_evidence": regex_evidence,
                "regex_signals": row.get("regex_rule_ids", []),
                "regex_signal": row.get("regex_signal", "none"),
                "release_conflict_section": row.get("release_conflict_section", ""),
                "agrees_with_regex": row.get("agrees_with_regex", False),
                "repo": row.get("repo", ""),
                "llm_findings": row.get("llm_findings", []),
                "ms_date": row.get("ms_date", ""),
                "date_flag": row.get("date_flag", ""),
            })

        date_skipped = kwargs.get("date_skipped", 0)
        metadata = {
            "actionable": len(output),
            "non_actionable": skipped,
            "date_excluded": date_skipped,
            "total": len(output) + skipped + date_skipped,
        }

        json_path.write_text(
            json.dumps({"meta": metadata, "results": output}, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        if skipped:
            print(f"  JSON report: {len(output)} actionable, {skipped} non-actionable omitted")
        return json_path


def _title_from_url(url: str) -> str:
    """Extract a human-readable title from a Learn URL path."""
    if not url:
        return ""
    # e.g. https://learn.microsoft.com/en-us/visualstudio/ide/copilot-chat -> "copilot-chat"
    path = url.rstrip("/").split("/")[-1]
    return path.replace("-", " ").title() if path else ""
