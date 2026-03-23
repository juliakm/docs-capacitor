"""Tests for the Azure CLI scenario — loads, validates, and pipeline instantiates."""

from pathlib import Path

import pytest

SCENARIO_PATH = Path(__file__).resolve().parent.parent / "scenarios" / "azure-cli" / "scenario.yaml"
pytestmark = pytest.mark.skipif(
    not SCENARIO_PATH.exists(),
    reason="Optional azure-cli scenario fixtures are not present in this checkout.",
)


class TestAzureCliScenarioLoading:
    """Verify the azure-cli scenario loads and validates."""

    def test_scenario_file_exists(self):
        assert SCENARIO_PATH.exists(), f"Scenario not found: {SCENARIO_PATH}"

    def test_rules_file_exists(self):
        rules_path = SCENARIO_PATH.parent / "rules.yaml"
        assert rules_path.exists(), f"Rules file not found: {rules_path}"

    def test_strategy_file_exists(self):
        strategy_path = SCENARIO_PATH.parent / "strategy.yaml"
        assert strategy_path.exists(), f"Strategy file not found: {strategy_path}"

    def test_scenario_loads(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert config.scenario_name == "Azure CLI Command Freshness"

    def test_scenario_validates(self):
        from capacitor.config import CapacitorConfig
        from capacitor.scenario_schema import validate_scenario
        config = CapacitorConfig(SCENARIO_PATH)
        errors = validate_scenario(config.raw)
        assert errors == [], f"Validation errors: {errors}"

    def test_scenario_product(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert config.product_name == "Azure CLI"
        assert config.tool_name == ""

    def test_scenario_search_config(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert len(config.learn_queries) >= 5
        assert any("az" in q for q in config.learn_queries)
        assert len(config.github_orgs) >= 2

    def test_scenario_url_filters(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert len(config.relevant_url_patterns) >= 4
        assert len(config.skip_url_patterns) >= 2
        assert any("release-notes" in p for p in config.skip_url_patterns)

    def test_scenario_key_facts(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert len(config.llm_key_facts) >= 5
        assert any("az acs" in f for f in config.llm_key_facts)
        assert any("az upgrade" in f for f in config.llm_key_facts)

    def test_scenario_report_title(self):
        from capacitor.config import CapacitorConfig
        config = CapacitorConfig(SCENARIO_PATH)
        assert config.report_title == "Azure CLI — Documentation Freshness Report"


class TestAzureCliPipeline:
    """Verify Pipeline builds all components without error."""

    def test_pipeline_creates(self):
        from capacitor.config import CapacitorConfig
        from capacitor.pipeline import Pipeline
        config = CapacitorConfig(SCENARIO_PATH)
        pipeline = Pipeline(config, out_dir=Path("/tmp/capacitor-test-azure-cli"))
        assert pipeline is not None

    def test_pipeline_builds_learn_collector(self):
        from capacitor.config import CapacitorConfig
        from capacitor.pipeline import Pipeline
        config = CapacitorConfig(SCENARIO_PATH)
        pipeline = Pipeline(config, out_dir=Path("/tmp/capacitor-test-azure-cli"))
        assert pipeline._build_learn_collector() is not None

    def test_pipeline_builds_regex_detector(self):
        from capacitor.config import CapacitorConfig
        from capacitor.pipeline import Pipeline
        config = CapacitorConfig(SCENARIO_PATH)
        pipeline = Pipeline(config, out_dir=Path("/tmp/capacitor-test-azure-cli"))
        assert pipeline._build_regex_detector() is not None

    def test_pipeline_builds_classifier(self):
        from capacitor.config import CapacitorConfig
        from capacitor.pipeline import Pipeline
        config = CapacitorConfig(SCENARIO_PATH)
        pipeline = Pipeline(config, out_dir=Path("/tmp/capacitor-test-azure-cli"))
        assert pipeline._build_classifier() is not None


class TestAzureCliRegexRules:
    """Verify regex rules load and have expected rule IDs."""

    def test_rules_load(self):
        import yaml
        rules_path = SCENARIO_PATH.parent / "rules.yaml"
        with rules_path.open() as f:
            data = yaml.safe_load(f)
        assert "rules" in data
        rule_ids = [r["id"] for r in data["rules"]]
        assert "DEPRECATED_ACS" in rule_ids
        assert "OLD_LOGIN" in rule_ids
        assert "DEPRECATED_WEBAPP_LOG" in rule_ids
        assert "OLD_IMAGE_FORMAT" in rule_ids

    def test_rules_have_severity(self):
        import yaml
        rules_path = SCENARIO_PATH.parent / "rules.yaml"
        with rules_path.open() as f:
            data = yaml.safe_load(f)
        for rule in data["rules"]:
            assert "severity" in rule, f"Rule {rule['id']} missing severity"


class TestAzureCliStrategy:
    """Verify strategy loads and has expected topic rules."""

    def test_strategy_loads(self):
        from capacitor.classifiers.topic_rules import load_strategy
        strategy_path = SCENARIO_PATH.parent / "strategy.yaml"
        strategy = load_strategy(strategy_path)
        assert strategy is not None
        topic_rules = strategy.get("topic_rules", [])
        assert len(topic_rules) == 3

    def test_strategy_topic_ids(self):
        from capacitor.classifiers.topic_rules import load_strategy
        strategy_path = SCENARIO_PATH.parent / "strategy.yaml"
        strategy = load_strategy(strategy_path)
        topic_ids = [t["id"] for t in strategy["topic_rules"]]
        assert "deprecated-commands" in topic_ids
        assert "auth-changes" in topic_ids
        assert "vm-image-format" in topic_ids

    def test_strategy_hard_exclusions(self):
        from capacitor.classifiers.topic_rules import load_strategy
        strategy_path = SCENARIO_PATH.parent / "strategy.yaml"
        strategy = load_strategy(strategy_path)
        exclusions = strategy.get("hard_exclusions", {}).get("url_regex", [])
        assert any("release-notes" in e for e in exclusions)
