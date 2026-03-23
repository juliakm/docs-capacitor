"""Reporter plugins — generate output reports."""

from typing import Dict, Type

REPORTER_REGISTRY: Dict[str, Type] = {}


def register_reporter(name: str):
    """Decorator to register a reporter class."""
    def decorator(cls):
        REPORTER_REGISTRY[name] = cls
        return cls
    return decorator


# Import built-in reporters to trigger registration
from capacitor.reporters.markdown import MarkdownReporter  # noqa: E402,F401
from capacitor.reporters.csv_report import CSVReporter  # noqa: E402,F401
from capacitor.reporters.json_report import JSONReporter  # noqa: E402,F401
