# Docs Capacitor: Global Search and Replace — VS Code Extension

Search Microsoft Learn for outdated content and generate prioritized reports — powered by configurable scenarios that combine regex rules and LLM analysis.

Docs Capacitor searches the Learn Knowledge Service and GitHub across thousands of documentation articles to find content that references outdated product instructions, deprecated tasks, or stale branding. Each search is driven by a **scenario** — a YAML file that defines what to look for, where to search, and how to classify findings.

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

### 2) Get the scenarios

You only need the `scenarios/` folder — **not the full repo zip**.

**Option A: Download just the scenarios (GitHub CLI)**

```bash
gh repo clone microsoft/docs-capacitor -- --filter=blob:none --sparse
cd docs-capacitor
git sparse-checkout set scenarios
```

Then note the full path to the `scenarios/` folder (e.g., `/Users/you/docs-capacitor/scenarios`).

**Option B: Already have the repo zip?**

Extract the zip file and locate the `scenarios/` folder inside it. Note its full path — you'll use it in the next step.

> **Tip:** You do **not** need to clone or build the Python source to use the extension. The extension manages its own runtime.

### 3) First-run checklist

1. Open **Setup & Configuration** from the toolbar.
2. Under **Environment → Scenario Paths**, paste the absolute path to your `scenarios/` folder (e.g. `/Users/you/docs-capacitor/scenarios`). This must point to the folder containing `scenario.yaml` files, not the repo root.
3. Click **Save Settings**.
4. Confirm scenarios appear in the **Scenarios** view.
5. Select a scenario and click **Run Check**.

After clicking **Run Check**, continue to the next section to understand what happens during and after the run.

### 3) Verify extension/runtime versions

Open **Output** → select **Docs Capacitor** and verify startup/runtime lines:

- `[startup] Extension version: ...`
- `[startup] Bundled runtime source version: ...`
- `[startup] Installed runtime marker version: ...`
- `[runtime] Installed docs-capacitor package version: ...`

## What happens when you run a check

**Before you start:** Runs can take **2–10 minutes** depending on repo size and GitHub API load.

- **Progress:** Watch the notification in the **bottom-right corner** for status updates (e.g., "Searching for X", "Analyzing results").
- **Logs:** For detailed output, open **View → Output** and select the **Docs Capacitor** channel.
- **Status bar:** The animated spinner in the **bottom-left corner** indicates the pipeline is running.

When the check completes, results are loaded automatically in the **Freshness Results** sidebar panel, grouped by classification.

## Usage

1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Type **Docs Capacitor** to see available commands:
   - **Run Freshness Check** — select a scenario YAML and run the pipeline.
   - **Validate Scenario** — check that a scenario file is well-formed.
   - **Open Scenario File** — open an existing `.yaml` scenario in the editor.
   - **Create New Scenario** — scaffold a new scenario from a starter template.
3. Results appear in the **Freshness Results** sidebar panel grouped by classification.
4. You can also use the Scenarios/Results view toolbars for common actions (run, refresh, setup, switch results).

## Configuration

The extension has two layers of settings — use the **Setup & Configuration** panel (toolbar icon) rather than editing `settings.json` directly.

> **Extension settings vs Python tool settings**  
> The fields in **Setup & Configuration** are VS Code extension settings (stored in your VS Code profile). They control how the extension finds and launches the Python pipeline. The Python tool itself is configured by the `scenario.yaml` files in your scenarios folder — you don't need to configure the Python tool separately.

### Required settings

| Setting | Where to set it | Description |
|---------|-----------------|-------------|
| `docs-capacitor.scenarioPaths` | Setup panel → Environment → Scenario Paths | **Required.** One or more absolute paths to folders containing `scenario.yaml` files. The extension won't show any scenarios until this is set. |
| `docs-capacitor.pythonPath` | Setup panel → Environment → Python Path | Path to Python 3.9+ interpreter. Defaults to `python` (usually correct). |

### Optional settings (leave blank unless you know you need them)

| Setting | Default | Description |
|---------|---------|-------------|
| `docs-capacitor.defaultScenario` | _(empty)_ | Pre-select a scenario YAML on startup |
| `docs-capacitor.timeoutMs` | `1800000` | Pipeline timeout in milliseconds |
| `docs-capacitor.defaultReposFile` | _(empty)_ | Allowed repos file for new scenario scaffolding |
| `docs-capacitor.learnKnowledgeServiceUrl` | _(empty)_ | **Internal Microsoft users only.** URL of a private Learn instance. Leave blank for most users — `usePublicLearnFallback` handles external access. |
| `docs-capacitor.learnKnowledgeServiceScope` | _(empty)_ | **Internal Microsoft users only.** Azure authentication scope for internal Learn instances. Leave blank for most users. |
| `docs-capacitor.usePublicLearnFallback` | `true` | Falls back to public learn.microsoft.com search when internal auth is unavailable — **keep enabled for most users**. |

## Troubleshooting (quick)

- **"Run didn't seem to start" or no visible progress**
  - Watch the **notification area (bottom-right)** and **status bar (bottom-left, animated spinner)** for activity.
  - If still unclear, open **View → Output** and select **Docs Capacitor** for detailed logs.
  - Runs can take 2–10 minutes — this is normal.

- **Results panel empty after a run completes**
  - Click **Refresh** (toolbar icon in the Freshness Results panel).
  - Or use **Load Results from File** and select `classifications.json` from `output/<scenario>/`.

- **CSV file is empty after a run**
  - This is **not an error** — it means no outdated content was found. This is success.
  - For a full summary, check `output/<scenario>/report.md` (includes page counts and details).

- **No results loaded on startup**
  - Run **Refresh Results** once.
  - Confirm `classifications.json` exists under `output/<scenario>/`.
  - Check `Docs Capacitor` output for startup/runtime version lines.

- **Switch Results shows no results**
  - Confirm output files exist under a discovered output root.
  - Verify `docs-capacitor.scenarioPaths` points to your scenario root.

- **Runtime appears stale after updating extension**
  - In `Docs Capacitor` output, compare:
    - extension version
    - bundled runtime source version
    - installed runtime marker version
    - installed runtime package version
