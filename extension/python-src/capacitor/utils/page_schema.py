"""Page schema — JSON schema for page records."""

from __future__ import annotations

PAGE_SCHEMA = {
    "type": "object",
    "required": ["url", "text"],
    "properties": {
        "url": {"type": "string"},
        "repo": {"type": "string"},
        "text": {"type": "string"},
    },
}
