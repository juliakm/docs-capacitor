import * as vscode from "vscode";
import * as path from "path";
import { ResultsProvider, PageResult, LlmFinding } from "./resultsProvider";
import { PipelineRunner } from "./runner";
import { ScenarioWizardPanel } from "./wizardPanel";
import { ScenarioProvider, ScenarioItem } from "./scenarioProvider";

const OUTPUT_CHANNEL_NAME = "Docs Capacitor";

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

/** Build a PipelineRunner using current workspace settings. */
function createRunner(): PipelineRunner {
  const config = vscode.workspace.getConfiguration("docs-capacitor");
  const pythonPath = config.get<string>("pythonPath", "python3");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const timeoutMs = config.get<number>("timeoutMs", 300_000);
  // timeoutMs is stored on the runner for convenience but passed per-call via RunOptions
  void timeoutMs;
  return PipelineRunner.withOutputChannel(pythonPath, cwd, outputChannel);
}

/** Read the configured (or default) timeout in ms. */
function getTimeoutMs(): number {
  return vscode.workspace.getConfiguration("docs-capacitor").get<number>("timeoutMs", 300_000);
}

/** Discover scenario.yaml files in the workspace (mirrors ScenarioProvider logic). */
function discoverScenarioFiles(): Array<{ label: string; description: string; path: string }> {
  const results: Array<{ label: string; description: string; path: string }> = [];
  const roots = vscode.workspace.workspaceFolders ?? [];

  for (const folder of roots) {
    const wsRoot = folder.uri.fsPath;
    walkForYaml(wsRoot, 0, 3, results, wsRoot);
  }
  return results;
}

function walkForYaml(
  dir: string,
  depth: number,
  maxDepth: number,
  results: Array<{ label: string; description: string; path: string }>,
  wsRoot: string,
): void {
  if (depth > maxDepth) { return; }
  let entries: import("fs").Dirent[];
  try {
    const fs = require("fs");
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }
  const fs = require("fs");
  const yaml = require("js-yaml");
  for (const entry of entries) {
    if (["node_modules", ".git", "out", "__pycache__"].includes(entry.name)) { continue; }
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "scenario.yaml") {
      try {
        const raw = fs.readFileSync(full, "utf-8");
        const doc = yaml.load(raw) as { name?: string; product?: { name?: string } } | undefined;
        const scenarioName = doc?.name ?? path.basename(path.dirname(full));
        const productName = doc?.product?.name ?? "";
        const relPath = path.relative(wsRoot, full);
        results.push({
          label: `$(beaker) ${scenarioName}`,
          description: productName ? `${productName}  —  ${relPath}` : relPath,
          path: full,
        });
      } catch { /* skip unparseable */ }
    } else if (entry.isDirectory()) {
      walkForYaml(full, depth + 1, maxDepth, results, wsRoot);
    }
  }
}

/** Show a QuickPick of discovered scenarios, or fall back to file browser. */
async function pickScenario(title: string): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("docs-capacitor");
  const defaultScenario = config.get<string>("defaultScenario", "");
  if (defaultScenario) {
    return defaultScenario;
  }

  const scenarios = discoverScenarioFiles();

  if (scenarios.length === 1) {
    return scenarios[0].path;
  }

  if (scenarios.length > 1) {
    const picked = await vscode.window.showQuickPick(scenarios, {
      placeHolder: title,
      matchOnDescription: true,
    });
    return picked?.path;
  }

  // No scenarios found — fall back to file browser
  const browseItem = await vscode.window.showInformationMessage(
    "No scenario.yaml files found in this workspace. Browse for one?",
    "Browse…",
    "Create New Scenario",
  );
  if (browseItem === "Create New Scenario") {
    vscode.commands.executeCommand("docs-capacitor.createScenario");
    return undefined;
  }
  if (browseItem === "Browse…") {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "YAML files": ["yaml", "yml"] },
      title,
    });
    return picked?.[0]?.fsPath;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

  // Status bar: last check time
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = "docs-capacitor.check";
  statusBarItem.text = "$(beaker) Capacitor";
  statusBarItem.tooltip = "Run Freshness Check";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const resultsProvider = new ResultsProvider();
  const resultsTreeView = vscode.window.createTreeView("docsCapacitorResults", {
    treeDataProvider: resultsProvider,
    showCollapseAll: true,
  });
  resultsProvider.setTreeView(resultsTreeView);
  context.subscriptions.push(resultsTreeView);

  const scenarioProvider = new ScenarioProvider();
  vscode.window.registerTreeDataProvider("docsCapacitorScenarios", scenarioProvider);

  // --- Scenario tree commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.scenario.refresh", () => {
      scenarioProvider.refresh();
    }),
    vscode.commands.registerCommand("docs-capacitor.scenario.runCheck", (item: ScenarioItem) => {
      scenarioProvider.runCheck(item);
    }),
    vscode.commands.registerCommand("docs-capacitor.scenario.validate", (item: ScenarioItem) => {
      scenarioProvider.validate(item);
    }),
    vscode.commands.registerCommand("docs-capacitor.scenario.edit", (item: ScenarioItem) => {
      scenarioProvider.editScenario(item);
    }),
    vscode.commands.registerCommand("docs-capacitor.scenario.duplicate", (item: ScenarioItem) => {
      scenarioProvider.duplicateScenario(item);
    }),
    vscode.commands.registerCommand("docs-capacitor.scenario.export", (item: ScenarioItem) => {
      scenarioProvider.exportScenario(item);
    }),
    vscode.commands.registerCommand("docs-capacitor.scenario.delete", (item: ScenarioItem) => {
      scenarioProvider.deleteScenario(item);
    }),
    vscode.commands.registerCommand("docs-capacitor.scenario.addSearchQuery", (item: ScenarioItem) => {
      scenarioProvider.addSearchQuery(item);
    }),
    vscode.commands.registerCommand("docs-capacitor.scenario.addKeyFact", (item: ScenarioItem) => {
      scenarioProvider.addKeyFact(item);
    }),
  );

  // --- Results: Open URL ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.openResultUrl", (url: string) => {
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
  );

  // --- Results: Copy URL ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.copyResultUrl", (item: { pageResult?: { url: string } }) => {
      const url = item?.pageResult?.url;
      if (url) {
        vscode.env.clipboard.writeText(url);
        vscode.window.showInformationMessage(`Copied: ${url}`);
      }
    }),
  );

  // --- Results: View Details ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.viewResultDetails", (item: { pageResult?: import("./resultsProvider").PageResult }) => {
      const r = item?.pageResult;
      if (!r) { return; }
      const lines = [
        `URL: ${r.url}`,
        `Classification: ${r.classification}`,
        `Confidence: ${typeof r.confidence === "string" ? r.confidence : (r.confidence * 100).toFixed(0) + "%"}`,
        r.topic ? `Topic: ${r.topic}` : "",
        r.reason ? `Reason: ${r.reason}` : "",
        r.suggested_fix ? `Suggested Fix: ${r.suggested_fix}` : "",
        r.evidence ? `Evidence: ${r.evidence}` : "",
        r.regex_signals?.length ? `Regex Signals: ${r.regex_signals.join(", ")}` : "",
      ].filter(Boolean);
      outputChannel.show(true);
      outputChannel.appendLine("─".repeat(60));
      lines.forEach((l) => outputChannel.appendLine(l));
      outputChannel.appendLine("─".repeat(60));
    }),
  );

  // --- Results: Mark as Reviewed ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.markReviewed", (item: { pageResult?: { url: string } }) => {
      const url = item?.pageResult?.url;
      if (url) {
        resultsProvider.markReviewed(url);
        vscode.window.showInformationMessage(`Marked as reviewed: ${url}`);
      }
    }),
  );

  // --- Results: Fix with Copilot ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.fixWithCopilot", (item: { pageResult?: PageResult }) => {
      const r = item?.pageResult;
      if (!r) { return; }

      const parts: string[] = [
        `I need to fix an outdated documentation page on Microsoft Learn.`,
        ``,
        `**Page:** ${r.url}`,
      ];

      if (r.topic) { parts.push(`**Topic:** ${r.topic}`); }
      parts.push(`**Classification:** ${r.classification}`);

      if (r.llm_findings && r.llm_findings.length > 0) {
        parts.push("", "## Issues Found");
        for (const f of r.llm_findings as LlmFinding[]) {
          if (f.title) { parts.push(`\n### ${f.title}`); }
          if (f.conflict) { parts.push(`**Problem:** ${f.conflict}`); }
          if (f.article_quote) { parts.push(`**The article says:** "${f.article_quote}"`); }
          if (f.fact) { parts.push(`**Correct information:** ${f.fact}`); }
        }
      } else {
        if (r.reason) { parts.push(`**Reason:** ${r.reason}`); }
        if (r.evidence) { parts.push(`**Evidence:** ${r.evidence}`); }
      }

      parts.push("", "Please help me draft the corrected text for this article. Show me the specific paragraphs that need to change, with before/after versions.");

      const prompt = parts.join("\n");

      // Try GitHub Copilot Chat first, fall back to opening as a document
      vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt }).then(
        undefined,
        () => {
          // Copilot Chat not available — copy to clipboard as fallback
          vscode.env.clipboard.writeText(prompt);
          vscode.window.showInformationMessage(
            "Copilot Chat not available. Fix prompt copied to clipboard.",
          );
        },
      );
    }),
  );

  // --- Results: Filter ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.filterResults", async () => {
      const choices = [
        { label: "Show All", value: undefined },
        { label: "P0_OUTDATED", value: "P0_OUTDATED" },
        { label: "NEEDS_CLARIFICATION", value: "NEEDS_CLARIFICATION" },
        { label: "UP_TO_DATE", value: "UP_TO_DATE" },
        { label: "EXCLUDED", value: "EXCLUDED" },
      ];
      const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: "Filter results by classification",
      });
      if (picked !== undefined) {
        resultsProvider.setFilter(picked.value);
      }
    }),
  );

  // --- Results: Refresh ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.refreshResults", () => {
      resultsProvider.refresh();
    }),
  );

  // --- Run Freshness Check ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.check", async (scenarioPathArg?: string) => {
      const scenarioPath = scenarioPathArg ?? await pickScenario("Select a scenario to check");
      if (!scenarioPath) {
        return;
      }

      // Animate status bar while running
      statusBarItem.text = "$(sync~spin) Capacitor: Running…";
      statusBarItem.tooltip = "Freshness check in progress — click to cancel";
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const outputDir = path.join(cwd, "output");
      const runner = createRunner();
      const result = await runner.runCheck(scenarioPath, outputDir, { timeoutMs: getTimeoutMs() });

      // Restore status bar
      statusBarItem.backgroundColor = undefined;
      if (result.success) {
        const now = new Date().toLocaleTimeString();
        statusBarItem.text = `$(beaker) Capacitor ✓ ${now}`;
        statusBarItem.tooltip = `Last check: ${now}`;
        vscode.window.showInformationMessage("✅ Freshness check complete — see Results panel.");
        resultsProvider.refresh();
      } else {
        statusBarItem.text = "$(beaker) Capacitor ✗ Failed";
        statusBarItem.tooltip = "Last check failed — click to retry";
        vscode.window.showErrorMessage(`Freshness check failed (exit ${result.exitCode}). See Output panel for details.`);
      }
    }),
  );

  // --- Validate Scenario ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.validate", async (scenarioPathArg?: string) => {
      const scenarioPath = scenarioPathArg ?? await pickScenario("Select a scenario to validate");
      if (!scenarioPath) {
        return;
      }

      const runner = createRunner();
      const result = await runner.runValidate(scenarioPath, { timeoutMs: getTimeoutMs() });

      if (result.success) {
        vscode.window.showInformationMessage(`Scenario is valid.\n${result.output.trim()}`);
      } else {
        vscode.window.showErrorMessage(`Validation failed (exit ${result.exitCode}).`);
      }
    }),
  );

  // --- Open Scenario File ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.openScenario", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "YAML files": ["yaml", "yml"] },
        title: "Open a scenario file",
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument(picked[0]);
      await vscode.window.showTextDocument(doc);
    }),
  );

  // --- Create New Scenario (Wizard) ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.createScenario", () => {
      ScenarioWizardPanel.createOrShow(context.extensionUri);
    }),
  );

  outputChannel.appendLine("Docs Capacitor extension activated.");
}

export function deactivate(): void {
  outputChannel?.dispose();
}
