"""Base class for collectors."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Iterator


class BaseCollector(ABC):
    """Abstract base for page collectors."""

    @abstractmethod
    def collect(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        """Yield page dicts with at least 'url', 'repo', and 'text' keys."""
        ...
