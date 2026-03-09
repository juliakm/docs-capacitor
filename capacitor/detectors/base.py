"""Base class for detectors."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List


class BaseDetector(ABC):
    """Abstract base for finding detectors."""

    @abstractmethod
    def detect(self, pages: List[Dict[str, Any]], *, emit_all: bool = False) -> List[Dict[str, Any]]:
        """Return a list of finding dicts for the given pages."""
        ...
