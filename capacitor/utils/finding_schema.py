"""Finding schema — JSON schema for classification records."""

from __future__ import annotations

from typing import Any, Dict, List

FINDING_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Documentation Freshness Finding",
    "type": "object",
    "required": ["page_url", "repo", "classification", "confidence", "evidence", "reason"],
    "properties": {
        "page_url": {"type": "string"},
        "repo": {"type": "string"},
        "classification": {
            "type": "string",
            "enum": ["EXCLUDED", "UP_TO_DATE", "P0_OUTDATED", "NEEDS_CLARIFICATION"],
        },
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "reason": {"type": "string"},
        "suggested_fix": {"type": ["string", "null"]},
    },
}


def validate_finding(obj: Dict[str, Any]) -> List[str]:
    """Return a list of validation error strings (empty if valid)."""
    errors: List[str] = []
    for field in FINDING_SCHEMA["required"]:
        if field not in obj:
            errors.append(f"Missing required field: {field}")

    classification = obj.get("classification")
    valid_cls = FINDING_SCHEMA["properties"]["classification"]["enum"]
    if classification and classification not in valid_cls:
        errors.append(f"Invalid classification: {classification}")

    if classification == "EXCLUDED" and obj.get("suggested_fix") is not None:
        errors.append("EXCLUDED records must have suggested_fix = null")
    if classification == "P0_OUTDATED" and obj.get("suggested_fix") is None:
        errors.append("P0_OUTDATED records should include a suggested_fix")

    return errors
