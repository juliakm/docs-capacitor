"""Smoke tests for docs-capacitor package and copilot-vs scenario."""

from pathlib import Path

import pytest

SCENARIO_PATH = Path(__file__).resolve().parent.parent / "scenarios" / "copilot-vs" / "scenario.yaml"


class TestPackageImports:
    """Verify all capacitor subpackages import without error."""

    def test_import_capacitor(self):
        import capacitor  # noqa: F401

    def test_import_config(self):
        from capacitor.config import CapacitorConfig  # noqa: F401

    def test_import_pipeline(self):
        from capacitor.pipeline import Pipeline  # noqa: F401

    def test_import_collectors(self):
        from capacitor.collectors import COLLECTOR_REGISTRY
        assert "github" in COLLECTOR_REGISTRY
        assert "learn" in COLLECTOR_REGISTRY

    def test_import_detectors(self):
        from capacitor.detectors import DETECTOR_REGISTRY
        assert "regex" in DETECTOR_REGISTRY
        assert "llm" in DETECTOR_REGISTRY

    def test_import_classifiers(self):
        from capacitor.classifiers import CLASSIFIER_REGISTRY
        assert "topic_rules" in CLASSIFIER_REGISTRY

    def test_import_reporters(self):
        from capacitor.reporters import REPORTER_REGISTRY
        assert "markdown" in REPORTER_REGISTRY
        assert "csv" in REPORTER_REGISTRY


class TestScenarioLoading:
    """Verify the copilot-vs scenario loads and validates."""

    def test_scenario_file_exists(self):
        assert SCENARIO_PATH.exists(), f"Scenario not found: {SCENARIO_PATH}"

    def test_scenario_loads(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert config.scenario_name == "Copilot VS Install Path"

    def test_scenario_validates(self):
        from capacitor.config import CapacitorConfig
        from capacitor.scenario_schema import validate_scenario
        config = CapacitorConfig(SCENARIO_PATH)
        errors = validate_scenario(config.raw)
        assert errors == [], f"Validation errors: {errors}"

    def test_scenario_product(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert config.product_name == "GitHub Copilot"
        assert config.tool_name == "Visual Studio"

    def test_scenario_search_config(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert len(config.github_orgs) >= 4
        assert "MicrosoftDocs" in config.github_orgs
        assert len(config.learn_queries) >= 3
        assert len(config.github_excluded_repos) >= 3

    def test_scenario_url_filters(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert len(config.relevant_url_patterns) >= 6
        assert len(config.skip_url_patterns) >= 10

    def test_scenario_key_facts(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert len(config.llm_key_facts) >= 5


class TestPipelineInstantiation:
    """Verify Pipeline builds all components without error."""

    def test_pipeline_creates(self):
        from capacitor.config import CapacitorConfig
        from capacitor.pipeline import Pipeline
        config = CapacitorConfig(SCENARIO_PATH)
        pipeline = Pipeline(config, out_dir=Path("/tmp/capacitor-test-smoke"))
        assert pipeline is not None

    def test_pipeline_builds_collectors(self):
        from capacitor.config import CapacitorConfig
        from capacitor.pipeline import Pipeline
        config = CapacitorConfig(SCENARIO_PATH)
        pipeline = Pipeline(config, out_dir=Path("/tmp/capacitor-test-smoke"))
        assert pipeline._build_github_collector() is not None
        assert pipeline._build_learn_collector() is not None

    def test_pipeline_builds_detectors(self):
        from capacitor.config import CapacitorConfig
        from capacitor.pipeline import Pipeline
        config = CapacitorConfig(SCENARIO_PATH)
        pipeline = Pipeline(config, out_dir=Path("/tmp/capacitor-test-smoke"))
        assert pipeline._build_regex_detector() is not None
        assert pipeline._build_llm_detector() is not None

    def test_pipeline_builds_classifier(self):
        from capacitor.config import CapacitorConfig
        from capacitor.pipeline import Pipeline
        config = CapacitorConfig(SCENARIO_PATH)
        pipeline = Pipeline(config, out_dir=Path("/tmp/capacitor-test-smoke"))
        assert pipeline._build_classifier() is not None
