# Docs Capacitor: Global Search and Replace

Search Microsoft Learn for outdated content and generate prioritized reports — powered by configurable scenarios that combine regex rules and LLM analysis.

## What it does

Docs Capacitor searches the Learn Knowledge Service and GitHub across thousands of documentation articles to find content that references outdated product instructions, deprecated tasks, or stale branding. Each search is driven by a **scenario** — a YAML file that defines what to look for, where to search, and how to classify findings.

**Built-in scenarios include:**
- `copilot-vs/` — GitHub Copilot install instructions for Visual Studio (built-in since VS 2022 17.10+)
- `outdated-devops-tasks/` — Deprecated Azure DevOps pipeline tasks
- `vs-versionless-branding/` — Incorrect Visual Studio version-specific branding
- `azure-cli/` — Outdated Azure CLI command references
- `security-devops/` — Security and DevOps tooling references
- `starter/` — Minimal template for creating your own scenario

## Pipeline

**4 stages:** Collect → Detect → Classify → Report

| Stage | What it does |
|-------|-------------|
| **Collect** | Search the Learn Knowledge Service API and GitHub (across MicrosoftDocs and related orgs) |
| **Detect** | Apply regex rules and LLM prompts to identify issues in each article |
| **Classify** | Assign severity: `P0_OUTDATED`, `NEEDS_CLARIFICATION`, `UP_TO_DATE`, or `EXCLUDED` |
| **Report** | Generate Markdown, CSV, and JSON reports with prioritized findings |

## Quick Start

```bash
# Install
pip install -e .

# Run a scenario
capacitor check --scenario scenarios/copilot-vs/scenario.yaml

# Check a single article
capacitor check-article https://learn.microsoft.com/... --scenario scenarios/copilot-vs/scenario.yaml

# Validate your scenario config
capacitor validate --scenario scenarios/copilot-vs/scenario.yaml
```

## Scenarios

Everything domain-specific lives in a **scenario file** — a YAML that defines the product, search queries, regex rules, LLM key facts, URL filters, and classification strategy.

Each scenario folder contains:
- `scenario.yaml` — search targets, URL filters, LLM key facts, reporting config
- `rules.yaml` — regex patterns for fast pre-filtering
- `strategy.yaml` — classification logic and severity thresholds

## Creating Your Own Scenario

```bash
cp -r scenarios/starter scenarios/my-check
# Edit scenarios/my-check/scenario.yaml
capacitor validate --scenario scenarios/my-check/scenario.yaml
capacitor check --scenario scenarios/my-check/scenario.yaml
```

## VS Code Extension

The VS Code extension (see `extension/`) provides a GUI for managing scenarios, running checks, and browsing results without leaving your editor.

For install, quick-start, and troubleshooting, see `extension/README.md`.

## Release & artifact hygiene

- Keep source and extension in this single repo.
- Do not commit old `.vsix` files to git.
- Build VSIX in CI and store binaries as workflow/release artifacts.
- Tag versions (`vX.Y.Z`) for reproducible rollbacks.

## Development

```bash
pip install -e ".[dev]"
pytest
```
