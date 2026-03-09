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
    """Validate a scenario YAML file against the schema."""
    config = _load_config(scenario)
    try:
        from capacitor.scenario_schema import validate_scenario
        errors = validate_scenario(config.raw)
        if errors:
            click.echo("Validation errors:", err=True)
            for error in errors:
                click.echo(f"  - {error}", err=True)
            sys.exit(1)
        click.echo(f"✓ Scenario '{config.scenario_name}' is valid.")
    except ImportError:
        click.echo("jsonschema not installed — skipping schema validation.")
        click.echo(f"Scenario '{config.scenario_name}' loaded successfully (basic check only).")


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
