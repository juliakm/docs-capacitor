"""CLI entry point for the capacitor pipeline.

Usage:
    capacitor check --scenario <path>       Full pipeline run
    capacitor collect --scenario <path>     Collect pages only
    capacitor detect --scenario <path>      Detect issues only
    capacitor classify --scenario <path>    Classify findings only
    capacitor validate --scenario <path>    Validate scenario YAML
    capacitor refresh-notes --scenario <path>  Refresh release notes
    capacitor list-strategies --scenario <path>  List strategy areas
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

import click

from capacitor.config import CapacitorConfig
from capacitor.pipeline import Pipeline


def _load_config(scenario: str) -> CapacitorConfig:
    path = Path(scenario)
    if not path.exists():
        click.echo(f"Error: Scenario file not found: {path}", err=True)
        sys.exit(1)
    return CapacitorConfig(path)


@click.group()
@click.version_option(package_name="docs-capacitor")
def main() -> None:
    """docs-capacitor — configurable documentation freshness pipeline."""
    pass


@main.command()
@click.option("--scenario", "-s", required=True, help="Path to scenario YAML file.")
@click.option("--out", "-o", default="output", help="Output directory.")
@click.option("--source", multiple=True, help="Data sources (github, learn, local). Repeatable.")
@click.option("--detector", multiple=True, help="Detectors (regex, llm). Repeatable.")
@click.option("--area", multiple=True, help="Classification areas to check. Repeatable.")
@click.option("--format", "formats", multiple=True, help="Output formats (markdown, csv). Repeatable.")
@click.option("--pages-jsonl", default=None, help="Use pre-collected pages JSONL file.")
def check(
    scenario: str,
    out: str,
    source: tuple[str, ...],
    detector: tuple[str, ...],
    area: tuple[str, ...],
    formats: tuple[str, ...],
    pages_jsonl: Optional[str],
) -> None:
    """Run the full freshness check pipeline."""
    config = _load_config(scenario)
    pipeline = Pipeline(config, out_dir=Path(out))
    reports = pipeline.run(
        sources=list(source) or None,
        detectors=list(detector) or None,
        areas=list(area) or None,
        formats=list(formats) or None,
        pages_jsonl=pages_jsonl,
    )
    for r in reports:
        click.echo(f"Report: {r}")


@main.command()
@click.option("--scenario", "-s", required=True, help="Path to scenario YAML file.")
@click.option("--out", "-o", default="output", help="Output directory.")
@click.option("--source", multiple=True, help="Data sources. Repeatable.")
def collect(scenario: str, out: str, source: tuple[str, ...]) -> None:
    """Collect pages from configured sources."""
    config = _load_config(scenario)
    pipeline = Pipeline(config, out_dir=Path(out))
    pages = pipeline.collect(sources=list(source) or None)
    out_path = Path(out) / "pages.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for page in pages:
            f.write(json.dumps(page) + "\n")
    click.echo(f"Collected {len(pages)} pages → {out_path}")


@main.command()
@click.option("--scenario", "-s", required=True, help="Path to scenario YAML file.")
@click.option("--out", "-o", default="output", help="Output directory.")
@click.option("--pages-jsonl", required=True, help="Path to pages JSONL file.")
@click.option("--detector", multiple=True, help="Detectors. Repeatable.")
@click.option("--emit-all", is_flag=True, help="Emit findings for all pages (including no-match).")
def detect(
    scenario: str,
    out: str,
    pages_jsonl: str,
    detector: tuple[str, ...],
    emit_all: bool,
) -> None:
    """Run detectors on collected pages."""
    config = _load_config(scenario)
    pipeline = Pipeline(config, out_dir=Path(out))
    # Load pre-collected pages
    pages_path = Path(pages_jsonl)
    pipeline.pages = [json.loads(line) for line in pages_path.read_text().splitlines() if line.strip()]
    findings = pipeline.detect(detectors=list(detector) or None, emit_all=emit_all)
    out_path = Path(out) / "findings.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for finding in findings:
            f.write(json.dumps(finding) + "\n")
    click.echo(f"Found {len(findings)} findings → {out_path}")


@main.command()
@click.option("--scenario", "-s", required=True, help="Path to scenario YAML file.")
@click.option("--out", "-o", default="output", help="Output directory.")
@click.option("--area", multiple=True, help="Classification areas. Repeatable.")
def classify(scenario: str, out: str, area: tuple[str, ...]) -> None:
    """Classify detected findings."""
    config = _load_config(scenario)
    pipeline = Pipeline(config, out_dir=Path(out))
    # Load pre-saved data
    pages_path = Path(out) / "pages.jsonl"
    findings_path = Path(out) / "findings.jsonl"
    if pages_path.exists():
        pipeline.pages = [json.loads(line) for line in pages_path.read_text().splitlines() if line.strip()]
    if findings_path.exists():
        pipeline.findings = [json.loads(line) for line in findings_path.read_text().splitlines() if line.strip()]
    rn_path = Path(out) / "release_notes_snapshot.json"
    if rn_path.exists():
        pipeline.release_notes = json.loads(rn_path.read_text())
    classifications = pipeline.classify(areas=list(area) or None)
    out_path = Path(out) / "classifications.json"
    out_path.write_text(json.dumps(classifications, indent=2), encoding="utf-8")
    click.echo(f"Classified {len(classifications)} pages → {out_path}")


@main.command()
@click.option("--scenario", "-s", required=True, help="Path to scenario YAML file.")
def validate(scenario: str) -> None:
    """Validate scenario YAML, configuration, plugins, and connections."""
    import os
    import subprocess

    errors: list[str] = []
    warnings: list[str] = []

    def _pass(msg: str) -> None:
        click.echo(click.style("  ✓ ", fg="green") + msg)

    def _fail(msg: str) -> None:
        click.echo(click.style("  ✗ ", fg="red") + msg)
        errors.append(msg)

    def _warn(msg: str) -> None:
        click.echo(click.style("  ✗ ", fg="yellow") + msg)
        warnings.append(msg)

    # --- 1. Scenario YAML parses correctly ---
    click.echo("Checking scenario…")
    scenario_path = Path(scenario)
    try:
        config = CapacitorConfig(scenario_path)
        _pass(f"Scenario YAML parses correctly ({config.scenario_name})")
    except Exception as exc:
        _fail(f"Scenario YAML failed to parse: {exc}")
        click.echo("")
        click.secho(f"✗ Cannot continue — scenario failed to load.", fg="red")
        sys.exit(1)

    # --- 2. Schema validation ---
    try:
        from capacitor.scenario_schema import validate_scenario
        schema_errors = validate_scenario(config.raw)
        if schema_errors:
            for e in schema_errors:
                _fail(f"Schema: {e}")
        else:
            _pass("Scenario passes JSON Schema validation")
    except ImportError:
        _warn("jsonschema not installed — schema validation skipped")

    # --- 3. Rules YAML exists and loads ---
    click.echo("Checking referenced files…")
    rules_rel = config.detection.get("regex_rules")
    if rules_rel:
        rules_path = config.scenario_dir / rules_rel
        if rules_path.exists():
            try:
                import yaml
                data = yaml.safe_load(rules_path.read_text(encoding="utf-8"))
                rule_count = len((data or {}).get("rules", []))
                _pass(f"Rules YAML loads — {rule_count} rule(s) ({rules_path})")
            except Exception as exc:
                _fail(f"Rules YAML failed to load: {exc}")
        else:
            _fail(f"Rules YAML not found: {rules_path}")
    else:
        _pass("No regex rules configured (skipped)")

    # --- 4. Strategy YAML exists and loads ---
    strategy_rel = config.classification.get("strategy")
    if strategy_rel:
        strategy_path = config.scenario_dir / strategy_rel
        if strategy_path.exists():
            try:
                import yaml
                data = yaml.safe_load(strategy_path.read_text(encoding="utf-8"))
                topic_count = len((data or {}).get("topic_rules", []))
                _pass(f"Strategy YAML loads — {topic_count} topic rule(s) ({strategy_path})")
            except Exception as exc:
                _fail(f"Strategy YAML failed to load: {exc}")
        else:
            _fail(f"Strategy YAML not found: {strategy_path}")
    else:
        _pass("No strategy configured (skipped)")

    # --- 5. All referenced files exist (prompt template, tracker, etc.) ---
    prompt_tpl = config.detection.get("llm", {}).get("prompt_template")
    if prompt_tpl:
        prompt_path = config.scenario_dir / prompt_tpl
        if prompt_path.exists():
            _pass(f"Prompt template exists ({prompt_path})")
        else:
            _fail(f"Prompt template not found: {prompt_path}")

    tracker = config.search.get("github", {}).get("tracker")
    if tracker:
        tracker_path = config.scenario_dir / tracker
        if tracker_path.exists():
            _pass(f"Tracker file exists ({tracker_path})")
        else:
            # Tracker may be created at runtime; warn, don't fail
            _warn(f"Tracker file not found (may be created on first run): {tracker_path}")

    # --- 6. Plugin availability ---
    click.echo("Checking plugins…")
    from capacitor.collectors import COLLECTOR_REGISTRY
    from capacitor.detectors import DETECTOR_REGISTRY
    from capacitor.classifiers import CLASSIFIER_REGISTRY
    from capacitor.reporters import REPORTER_REGISTRY

    for label, registry in [
        ("Collectors", COLLECTOR_REGISTRY),
        ("Detectors", DETECTOR_REGISTRY),
        ("Classifiers", CLASSIFIER_REGISTRY),
        ("Reporters", REPORTER_REGISTRY),
    ]:
        if registry:
            _pass(f"{label}: {', '.join(sorted(registry.keys()))}")
        else:
            _fail(f"{label}: none registered")

    # --- 7. GitHub CLI available ---
    click.echo("Checking external tools…")
    try:
        result = subprocess.run(
            ["gh", "--version"], capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            version_line = result.stdout.strip().splitlines()[0]
            _pass(f"GitHub CLI available ({version_line})")
        else:
            _warn("GitHub CLI (`gh`) returned non-zero exit code")
    except FileNotFoundError:
        _warn("GitHub CLI (`gh`) not found — GitHub collection will fail")
    except Exception as exc:
        _warn(f"GitHub CLI check failed: {exc}")

    # --- 8. LLM provider env vars (GitHub Models or Azure OpenAI) ---
    llm_configured = bool(config.detection.get("llm"))
    gh_token = os.environ.get("GITHUB_TOKEN", "")
    az_endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
    az_key = os.environ.get("AZURE_OPENAI_API_KEY", "")
    if gh_token:
        _pass("GitHub Models token set (GITHUB_TOKEN)")
    elif az_endpoint and az_key:
        _pass("Azure OpenAI env vars set (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY)")
    elif llm_configured:
        _warn("No LLM credentials found — set GITHUB_TOKEN (preferred) or AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY")
    else:
        _pass("LLM not needed (no LLM detection configured)")

    # --- Summary ---
    click.echo("")
    if errors:
        click.secho(f"✗ {len(errors)} error(s), {len(warnings)} warning(s)", fg="red")
        sys.exit(1)
    elif warnings:
        click.secho(f"✓ Valid with {len(warnings)} warning(s)", fg="yellow")
    else:
        click.secho("✓ All checks passed — ready to run.", fg="green")


@main.command("refresh-notes")
@click.option("--scenario", "-s", required=True, help="Path to scenario YAML file.")
@click.option("--out", "-o", default="output", help="Output directory.")
def refresh_notes(scenario: str, out: str) -> None:
    """Refresh the release notes snapshot."""
    config = _load_config(scenario)
    pipeline = Pipeline(config, out_dir=Path(out))
    rn = pipeline.refresh_release_notes()
    section_key = config.release_notes_config.get("section_key", "product_sections")
    click.echo(f"Refreshed: {len(rn.get(section_key, []))} sections saved.")


@main.command("list-strategies")
@click.option("--scenario", "-s", required=True, help="Path to scenario YAML file.")
def list_strategies(scenario: str) -> None:
    """List available classification strategy areas."""
    config = _load_config(scenario)
    strategy_path = config.classification.get("strategy")
    if not strategy_path:
        click.echo("No strategy configured.")
        return
    full_path = config.scenario_dir / strategy_path
    if not full_path.exists():
        click.echo(f"Strategy file not found: {full_path}", err=True)
        sys.exit(1)
    from capacitor.classifiers.topic_rules import load_strategy
    strategy = load_strategy(full_path)
    topic_rules = strategy.get("topic_rules", [])
    click.echo(f"Strategy: {full_path.name}")
    click.echo(f"Topics ({len(topic_rules)}):")
    for topic in topic_rules:
        tid = topic.get("id", "?")
        title = topic.get("title", tid)
        area = topic.get("area", "")
        area_str = f" [area: {area}]" if area else ""
        click.echo(f"  - {tid}: {title}{area_str}")
