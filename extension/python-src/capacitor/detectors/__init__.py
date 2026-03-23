"""Detector plugins — find issues in documentation pages."""

from typing import Dict, Type

DETECTOR_REGISTRY: Dict[str, Type] = {}


def register_detector(name: str):
    """Decorator to register a detector class."""
    def decorator(cls):
        DETECTOR_REGISTRY[name] = cls
        return cls
    return decorator


# Import built-in detectors to trigger registration
from capacitor.detectors.regex import RegexDetector  # noqa: E402,F401
from capacitor.detectors.llm_detector import LLMDetector  # noqa: E402,F401
