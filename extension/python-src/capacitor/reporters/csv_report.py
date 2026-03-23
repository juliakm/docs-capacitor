"""CSVReporter — generate a CSV freshness report."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Dict, List

from capacitor.reporters.base import BaseReporter
from capacitor.reporters import register_reporter

CSV_FIELDS = [
    "page_url",
    "repo",
    "classification",
    "confidence",
    "reason",
    "suggested_fix",
    "regex_signal",
    "regex_rule_ids",
    "release_conflict_topic_id",
    "release_conflict_topic_title",
    "release_conflict_section",
    "agrees_with_regex",
    "evidence",
    "regex_evidence",
    "release_conflict_evidence",
]

_CSV_SKIP_CLASSIFICATIONS = {"UP_TO_DATE", "EXCLUDED"}


@register_reporter("csv")
class CSVReporter(BaseReporter):
    """Write a CSV report of classified results (skips UP_TO_DATE/EXCLUDED)."""

    @property
    def name(self) -> str:
        return "csv"

    def report(
        self,
        classifications: List[Dict[str, Any]],
        out_dir: Path,
        *,
        release_notes: Dict[str, Any] | None = None,
        strategy: Dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Path:
        suffix = kwargs.get("file_suffix", "")
        csv_path = out_dir / f"report{suffix}.csv"
        out_dir.mkdir(parents=True, exist_ok=True)

        with csv_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
            writer.writeheader()
            for row in classifications:
                if row.get("classification", "") in _CSV_SKIP_CLASSIFICATIONS:
                    continue
                writer.writerow({
                    "page_url": row.get("page_url", ""),
                    "repo": row.get("repo", ""),
                    "classification": row.get("classification", ""),
                    "confidence": row.get("confidence", ""),
                    "reason": row.get("reason", ""),
                    "suggested_fix": row.get("suggested_fix", ""),
                    "regex_signal": row.get("regex_signal", ""),
                    "regex_rule_ids": " | ".join(row.get("regex_rule_ids", []) or []),
                    "release_conflict_topic_id": row.get("release_conflict_topic_id", ""),
                    "release_conflict_topic_title": row.get("release_conflict_topic_title", ""),
                    "release_conflict_section": row.get("release_conflict_section", ""),
                    "agrees_with_regex": row.get("agrees_with_regex", ""),
                    "evidence": " | ".join(row.get("evidence", []) or []),
                    "regex_evidence": " | ".join(row.get("regex_evidence", []) or []),
                    "release_conflict_evidence": row.get("release_conflict_evidence", ""),
                })

        return csv_path
