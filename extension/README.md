# Docs Capacitor — VS Code Extension

A VS Code extension that provides a GUI for the **docs-capacitor** documentation freshness pipeline. Detect outdated API versions, deprecated CLI commands, and stale references in Microsoft Learn documentation.

## Prerequisites

- **VS Code 1.85+**
- Python is managed automatically by the extension runtime bootstrap.

## Quick Start for Internal Users

### 1) Install from VSIX

Recommended: Extensions panel → `...` → **Install from VSIX...**.

Or CLI:

```powershell
code --install-extension docs-capacitor-<version>.vsix --force
```

### 2) First-run checklist

1. Open **Setup & Configuration** from the toolbar.
2. Set `docs-capacitor.scenarioPaths` to your scenarios location.
3. Confirm scenarios appear in the **Scenarios** view.
4. Run a scenario with **Run Check**.

### 3) Verify extension/runtime versions

Open **Output** → select **Docs Capacitor** and verify startup/runtime lines:

- `[startup] Extension version: ...`
- `[startup] Bundled runtime source version: ...`
- `[startup] Installed runtime marker version: ...`
- `[runtime] Installed docs-capacitor package version: ...`

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
| `docs-capacitor.pythonPath` | `python` | Path to the Python interpreter |
| `docs-capacitor.defaultScenario` | _(empty)_ | Default scenario YAML file path |

## Troubleshooting (quick)

- **No results loaded on startup**
  - Run **Refresh Results** once.
  - Confirm `classifications.json` exists under `output/<scenario>/`.

- **Switch Results shows no results**
  - Confirm output files exist under a discovered output root.
  - Verify `docs-capacitor.scenarioPaths` points to your scenario root.

- **Need an immediate workaround**
  - Use **Load Results from File** and select `classifications.json`.
