"""Collector plugins — discover and fetch documentation pages."""

from typing import Dict, Type

COLLECTOR_REGISTRY: Dict[str, Type] = {}


def register_collector(name: str):
    """Decorator to register a collector class."""
    def decorator(cls):
        COLLECTOR_REGISTRY[name] = cls
        return cls
    return decorator


# Import built-in collectors to trigger registration
from capacitor.collectors.github_search import GitHubSearchCollector  # noqa: E402,F401
from capacitor.collectors.learn_api import LearnAPICollector  # noqa: E402,F401
from capacitor.collectors.learn_internal import LearnInternalCollector  # noqa: E402,F401
from capacitor.collectors.local_files import LocalFilesCollector  # noqa: E402,F401
