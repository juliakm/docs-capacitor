# Docs Capacitor — VS Code Extension

A VS Code extension that provides a GUI for the **docs-capacitor** documentation freshness pipeline. Detect outdated API versions, deprecated CLI commands, and stale references in Microsoft Learn documentation.

## Prerequisites

- **Python 3.10+** with the `docs-capacitor` package installed (`pip install -e .` from the repo root)
- **VS Code 1.85+**

## Usage

1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Type **Docs Capacitor** to see available commands:
   - **Run Freshness Check** — select a scenario YAML and run the pipeline.
   - **Validate Scenario** — check that a scenario file is well-formed.
   - **Open Scenario File** — open an existing `.yaml` scenario in the editor.
   - **Create New Scenario** — scaffold a new scenario from a starter template.
3. Results appear in the **Freshness Results** sidebar panel grouped by classification.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `docs-capacitor.pythonPath` | `python3` | Path to the Python interpreter |
| `docs-capacitor.defaultScenario` | _(empty)_ | Default scenario YAML file path |
