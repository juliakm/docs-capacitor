import * as vscode from "vscode";
import * as path from "path";
import { ResultsProvider } from "./resultsProvider";
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

/** Ask the user to pick a scenario file, falling back to the configured default. */
async function pickScenario(title: string): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("docs-capacitor");
  const defaultScenario = config.get<string>("defaultScenario", "");
  if (defaultScenario) {
    return defaultScenario;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "YAML files": ["yaml", "yml"] },
    title,
  });
  return picked?.[0]?.fsPath;
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
        `Confidence: ${(r.confidence * 100).toFixed(0)}%`,
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
    vscode.commands.registerCommand("docs-capacitor.check", async () => {
      const scenarioPath = await pickScenario("Select a scenario file");
      if (!scenarioPath) {
        return;
      }

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const outputDir = path.join(cwd, "output");
      const runner = createRunner();
      const result = await runner.runCheck(scenarioPath, outputDir, { timeoutMs: getTimeoutMs() });

      if (result.success) {
        vscode.window.showInformationMessage("Freshness check complete.");
        resultsProvider.refresh();
        const now = new Date().toLocaleTimeString();
        statusBarItem.text = `$(beaker) Capacitor ✓ ${now}`;
        statusBarItem.tooltip = `Last check: ${now}`;
      } else {
        vscode.window.showErrorMessage(`Freshness check failed (exit ${result.exitCode}).`);
      }
    }),
  );

  // --- Validate Scenario ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.validate", async () => {
      const scenarioPath = await pickScenario("Select a scenario file to validate");
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
