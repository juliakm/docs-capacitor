# docs-capacitor

Configurable documentation freshness detection pipeline for Microsoft Docs.

Find outdated references, stale instructions, and incorrect links across any set of documentation repositories — fully customizable via YAML scenario files.

## Architecture

**4-stage pipeline:** Collect → Detect → Classify → Report

| Stage | What it does |
|-------|-------------|
| **Collect** | Search for docs pages via GitHub CLI or Learn API |
| **Detect** | Find issues using regex rules and/or LLM analysis |
| **Classify** | Assign severity (P0_OUTDATED, NEEDS_CLARIFICATION, UP_TO_DATE, EXCLUDED) |
| **Report** | Generate Markdown and CSV reports |

## Quick Start

```bash
# Install
pip install -e .

# Run with a scenario
capacitor check --scenario scenarios/copilot-vs/scenario.yaml

# Check a single article
capacitor check-article https://learn.microsoft.com/... --scenario scenarios/copilot-vs/scenario.yaml

# Validate your scenario config
capacitor validate --scenario scenarios/copilot-vs/scenario.yaml
```

## Scenarios

Everything domain-specific lives in a **scenario file** — a single YAML that defines what product you're checking, where to search, what patterns to look for, and how to classify findings.

See `scenarios/` for examples:
- `copilot-vs/` — GitHub Copilot install path checker
- `starter/` — Minimal template for creating your own

## Creating Your Own Scenario

```bash
# Start from the template
cp -r scenarios/starter scenarios/my-check
# Edit scenarios/my-check/scenario.yaml with your product details
capacitor validate --scenario scenarios/my-check/scenario.yaml
capacitor check --scenario scenarios/my-check/scenario.yaml
```

## VS Code Extension

See `extension/` for the VS Code extension that provides a GUI for managing scenarios and viewing results.

For install, quick-start, and troubleshooting instructions used by coworkers, see `extension/README.md`.

## Development

```bash
pip install -e ".[dev]"
pytest
```
