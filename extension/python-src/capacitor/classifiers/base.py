"""Base class for classifiers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List


class BaseClassifier(ABC):
    """Abstract base for finding classifiers."""

    @abstractmethod
    def classify(
        self,
        findings: List[Dict[str, Any]],
        pages: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Return classified finding dicts with severity labels."""
        ...
