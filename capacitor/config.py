"""Scenario-based configuration loader.

Replaces the hardcoded FreshnessConfig with a generic system that loads
all product-specific settings from a scenario YAML file.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]


def _find_dotenv() -> Optional[Path]:
    """Walk up from CWD looking for .env."""
    cwd = Path.cwd()
    for parent in [cwd, *cwd.parents]:
        candidate = parent / ".env"
        if candidate.exists():
            return candidate
    return None


def _interpolate_env(value: str) -> str:
    """Replace ${VAR} and $VAR with environment variable values."""
    def _replace(m: re.Match) -> str:
        var = m.group(1) or m.group(2)
        return os.environ.get(var, m.group(0))
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", _replace, value)


def _deep_interpolate(obj: Any) -> Any:
    if isinstance(obj, str):
        return _interpolate_env(obj)
    if isinstance(obj, dict):
        return {k: _deep_interpolate(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_deep_interpolate(v) for v in obj]
    return obj


def load_scenario_yaml(path: Path) -> Dict[str, Any]:
    """Load a scenario YAML file with env-var interpolation."""
    if yaml is None:
        raise ImportError("pyyaml is required: pip install pyyaml")
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return _deep_interpolate(data)


class CapacitorConfig:
    """Scenario-based configuration for the capacitor pipeline.

    All product-specific settings come from the scenario YAML — nothing
    is hardcoded to a particular product or documentation set.
    """

    def __init__(
        self,
        scenario_path: Optional[str | Path] = None,
    ):
        dotenv = _find_dotenv()
        if dotenv:
            load_dotenv(str(dotenv))

        self._scenario: Dict[str, Any] = {}
        self._scenario_dir: Optional[Path] = None

        if scenario_path:
            p = Path(scenario_path)
            self._scenario = load_scenario_yaml(p)
            self._scenario_dir = p.parent

        # Azure OpenAI settings (always from env)
        self.azure_openai_endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
        self.azure_openai_api_key = os.environ.get("AZURE_OPENAI_API_KEY", "")
        self.azure_openai_deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
        self.azure_openai_api_version = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")

    # -- Convenience accessors -------------------------------------------------

    @property
    def raw(self) -> Dict[str, Any]:
        """Raw scenario dict (for schema validation)."""
        return self._scenario

    @property
    def scenario(self) -> Dict[str, Any]:
        return self._scenario

    @property
    def scenario_dir(self) -> Path:
        return self._scenario_dir or Path(".")

    @property
    def scenario_name(self) -> str:
        return self._scenario.get("name", "Unnamed Scenario")

    @property
    def name(self) -> str:
        return self._scenario.get("name", "Unnamed Scenario")

    # -- Section accessors (used by Pipeline) ----------------------------------

    @property
    def search(self) -> Dict[str, Any]:
        return self._scenario.get("search", {})

    @property
    def url_filters(self) -> Dict[str, Any]:
        return self._scenario.get("url_filters", {})

    @property
    def detection(self) -> Dict[str, Any]:
        return self._scenario.get("detection", {})

    @property
    def classification(self) -> Dict[str, Any]:
        return self._scenario.get("classification", {})

    @property
    def release_notes_config(self) -> Dict[str, Any]:
        return self._scenario.get("release_notes", {})

    @property
    def reporting(self) -> Dict[str, Any]:
        return self._scenario.get("reporting", {})

    @property
    def description(self) -> str:
        return self._scenario.get("description", "")

    @property
    def product(self) -> Dict[str, str]:
        return self._scenario.get("product", {})

    @property
    def product_name(self) -> str:
        return self.product.get("name", "")

    @property
    def tool_name(self) -> str:
        return self.product.get("tool", "")

    # -- Search settings -------------------------------------------------------

    @property
    def learn_queries(self) -> List[str]:
        return self._scenario.get("search", {}).get("learn", {}).get("queries", [])

    @property
    def learn_api_url(self) -> str:
        return self._scenario.get("search", {}).get("learn", {}).get(
            "api_url", "https://learn.microsoft.com/api/search"
        )

    @property
    def learn_exclude_url_patterns(self) -> List[str]:
        return self._scenario.get("search", {}).get("learn", {}).get("exclude_url_patterns", [])

    @property
    def github_orgs(self) -> List[str]:
        return self._scenario.get("search", {}).get("github", {}).get("orgs", [])

    @property
    def github_excluded_repos(self) -> List[str]:
        return self._scenario.get("search", {}).get("github", {}).get("excluded_repos", [])

    # -- URL filters -----------------------------------------------------------

    @property
    def relevant_url_patterns(self) -> List[str]:
        return self._scenario.get("url_filters", {}).get("relevant", [])

    @property
    def skip_url_patterns(self) -> List[str]:
        return self._scenario.get("url_filters", {}).get("skip", [])

    # -- Detection settings ----------------------------------------------------

    @property
    def regex_rules_path(self) -> Optional[Path]:
        rel = self._scenario.get("detection", {}).get("regex_rules")
        if rel and self._scenario_dir:
            return (self._scenario_dir / rel).resolve()
        return None

    @property
    def llm_prompt_template_path(self) -> Optional[Path]:
        rel = self._scenario.get("detection", {}).get("llm", {}).get("prompt_template")
        if rel and self._scenario_dir:
            return (self._scenario_dir / rel).resolve()
        return None

    @property
    def llm_key_facts(self) -> List[str]:
        return self._scenario.get("detection", {}).get("llm", {}).get("key_facts", [])

    @property
    def llm_max_article_chars(self) -> int:
        return self._scenario.get("detection", {}).get("llm", {}).get("max_article_chars", 8000)

    @property
    def llm_rate_limit_rpm(self) -> int:
        return self._scenario.get("detection", {}).get("llm", {}).get("rate_limit_rpm", 10)

    # -- Classification settings -----------------------------------------------

    @property
    def strategy_path(self) -> Optional[Path]:
        rel = self._scenario.get("classification", {}).get("strategy")
        if rel and self._scenario_dir:
            return (self._scenario_dir / rel).resolve()
        return None

    @property
    def scope_product_patterns(self) -> List[str]:
        return self._scenario.get("classification", {}).get("scope", {}).get("product_patterns", [])

    @property
    def scope_tool_patterns(self) -> List[str]:
        return self._scenario.get("classification", {}).get("scope", {}).get("tool_patterns", [])

    # -- Release notes ---------------------------------------------------------

    @property
    def release_notes_url(self) -> str:
        return self._scenario.get("release_notes", {}).get("url", "")

    @property
    def release_notes_section_pattern(self) -> str:
        return self._scenario.get("release_notes", {}).get("section_pattern", "")

    @property
    def release_notes_section_key(self) -> str:
        return self._scenario.get("release_notes", {}).get("section_key", "product_sections")

    # -- Reporting -------------------------------------------------------------

    @property
    def report_title(self) -> str:
        return self._scenario.get("reporting", {}).get(
            "title", f"{self.product_name} Freshness Report"
        )

    @property
    def report_formats(self) -> List[str]:
        return self._scenario.get("reporting", {}).get("formats", ["markdown", "csv"])

    # -- Helper to resolve relative paths within scenario ----------------------

    def resolve_path(self, relative: str) -> Optional[Path]:
        """Resolve a path relative to the scenario directory."""
        if self._scenario_dir:
            return (self._scenario_dir / relative).resolve()
        return None
