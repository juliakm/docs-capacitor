"""Base class for reporters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List


class BaseReporter(ABC):
    """Abstract base for report generators."""

    @abstractmethod
    def report(
        self,
        classifications: List[Dict[str, Any]],
        out_dir: Path,
        *,
        release_notes: Dict[str, Any] | None = None,
        strategy: Dict[str, Any] | None = None,
    ) -> Path:
        """Write a report and return the output file path."""
        ...
