"""JSON Schema for scenario YAML validation.

Provides clear, helpful error messages when users misconfigure scenarios.
"""

from __future__ import annotations

from typing import Any, Dict, List

SCENARIO_SCHEMA: Dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "docs-capacitor Scenario",
    "description": "Configuration file for a documentation freshness check scenario.",
    "type": "object",
    "required": ["name", "product"],
    "additionalProperties": False,
    "properties": {
        "name": {
            "type": "string",
            "description": "Human-readable name for this scenario.",
        },
        "description": {
            "type": "string",
            "description": "What this scenario checks for.",
        },
        "product": {
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": {"type": "string", "description": "Product name (e.g. 'GitHub Copilot')."},
                "tool": {"type": "string", "description": "Tool/IDE name (e.g. 'Visual Studio')."},
            },
        },
        "search": {
            "type": "object",
            "properties": {
                "github": {
                    "type": "object",
                    "properties": {
                        "orgs": {"type": "array", "items": {"type": "string"}},
                        "queries": {"type": "array", "items": {"type": "string"}},
                        "excluded_repos": {"type": "array", "items": {"type": "string"}},
                        "tracker": {"type": "string"},
                    },
                },
                "learn": {
                    "type": "object",
                    "properties": {
                        "api_url": {"type": "string", "format": "uri"},
                        "queries": {"type": "array", "items": {"type": "string"}},
                        "path_scopes": {"type": "array", "items": {"type": "string"}, "description": "URL path prefixes to scope searches (e.g. '/en-us/visualstudio/'). Empty string = no scope."},
                        "exclude_url_patterns": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
        },
        "url_filters": {
            "type": "object",
            "properties": {
                "relevant": {"type": "array", "items": {"type": "string"}},
                "skip": {"type": "array", "items": {"type": "string"}},
            },
        },
        "detection": {
            "type": "object",
            "properties": {
                "regex_rules": {"type": "string", "description": "Path to regex rules YAML (relative to scenario dir)."},
                "llm": {
                    "type": "object",
                    "properties": {
                        "prompt_template": {"type": "string"},
                        "key_facts": {"type": "array", "items": {"type": "string"}},
                        "max_article_chars": {"type": "integer", "minimum": 500},
                        "rate_limit_rpm": {"type": "integer", "minimum": 1},
                    },
                },
            },
        },
        "classification": {
            "type": "object",
            "properties": {
                "strategy": {"type": "string", "description": "Path to strategy YAML (relative to scenario dir)."},
                "scope": {
                    "type": "object",
                    "properties": {
                        "product_patterns": {"type": "array", "items": {"type": "string"}},
                        "tool_patterns": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
        },
        "release_notes": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "section_pattern": {"type": "string"},
                "section_key": {"type": "string"},
            },
        },
        "reporting": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "formats": {"type": "array", "items": {"type": "string", "enum": ["markdown", "csv"]}},
            },
        },
    },
}


def validate_scenario(data: Dict[str, Any]) -> List[str]:
    """Validate scenario data against the JSON Schema.

    Returns a list of human-readable error messages (empty = valid).
    """
    try:
        from jsonschema import Draft7Validator
    except ImportError:
        return ["jsonschema not installed — install with: pip install jsonschema"]

    validator = Draft7Validator(SCENARIO_SCHEMA)
    errors: List[str] = []
    for error in sorted(validator.iter_errors(data), key=lambda e: list(e.path)):
        path = " → ".join(str(p) for p in error.absolute_path) or "(root)"
        errors.append(f"{path}: {error.message}")
    return errors
