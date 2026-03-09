"""Classifier plugins — assign severity to findings."""

from typing import Dict, Type

CLASSIFIER_REGISTRY: Dict[str, Type] = {}


def register_classifier(name: str):
    """Decorator to register a classifier class."""
    def decorator(cls):
        CLASSIFIER_REGISTRY[name] = cls
        return cls
    return decorator


# Import built-in classifiers to trigger registration
from capacitor.classifiers.topic_rules import TopicRulesClassifier  # noqa: E402,F401
