import * as vscode from "vscode";
import * as path from "path";
import { ResultsProvider, PageResult, LlmFinding } from "./resultsProvider";
import { PipelineRunner } from "./runner";
import { ScenarioWizardPanel } from "./wizardPanel";
import { ResultsPanel } from "./resultsPanel";
import { SettingsPanel } from "./settingsPanel";
import { ScenarioProvider, ScenarioItem } from "./scenarioProvider";
import { showSetupReport, activationCheck, runAllChecks } from "./setupChecker";
import { analyzeTriage, TriageAnalysis, TriageSuggestion, ScenarioConfig } from "./triageAnalyzer";

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

/** Discover scenario.yaml files in the workspace and configured paths. */
function discoverScenarioFiles(): Array<{ label: string; description: string; path: string }> {
  const results: Array<{ label: string; description: string; path: string }> = [];
  const roots = vscode.workspace.workspaceFolders ?? [];
  const seen = new Set<string>();

  for (const folder of roots) {
    const wsRoot = folder.uri.fsPath;
    walkForYaml(wsRoot, 0, 3, results, wsRoot, seen);
  }

  // Also search configured extra paths
  const extraPaths = vscode.workspace.getConfiguration("docs-capacitor")
    .get<string[]>("scenarioPaths", []);
  const wsRoot = roots[0]?.uri.fsPath ?? "";
  const fs = require("fs") as typeof import("fs");
  const yaml = require("js-yaml");
  for (const extra of extraPaths) {
    const resolved = path.isAbsolute(extra) ? extra : wsRoot ? path.join(wsRoot, extra) : extra;
    if (!fs.existsSync(resolved)) { continue; }
    try {
      walkForYaml(resolved, 0, 1, results, wsRoot || resolved, seen);
    } catch { /* skip */ }
  }

  return results;
}

function walkForYaml(
  dir: string,
  depth: number,
  maxDepth: number,
  results: Array<{ label: string; description: string; path: string }>,
  wsRoot: string,
  seen: Set<string>,
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
    if (entry.isFile() && entry.name === "scenario.yaml" && !seen.has(full)) {
      seen.add(full);
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
      walkForYaml(full, depth + 1, maxDepth, results, wsRoot, seen);
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
    vscode.commands.registerCommand("docs-capacitor.scenario.deepScan", async (item: ScenarioItem) => {
      const scenarioPath = item.scenarioPath;
      const folderUri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select repo folder to scan",
      });
      if (!folderUri || folderUri.length === 0) {
        return;
      }
      vscode.commands.executeCommand("docs-capacitor.deepScan", scenarioPath, folderUri[0].fsPath);
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
    vscode.commands.registerCommand("docs-capacitor.openResultUrl", (arg: string | { pageResult?: { url: string } }) => {
      const url = typeof arg === "string" ? arg : arg?.pageResult?.url;
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
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

  // --- Results: Triage - Mark as Valid ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.triageValid", (item: { pageResult?: { url: string } }) => {
      const url = item?.pageResult?.url;
      if (url) {
        resultsProvider.triageUrl(url, "valid");
        vscode.window.showInformationMessage(`✅ Marked as valid finding: ${url}`);
      }
    }),
  );

  // --- Results: Triage - Mark as False Positive ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.triageFalsePositive", (item: { pageResult?: { url: string } }) => {
      const url = item?.pageResult?.url;
      if (url) {
        resultsProvider.triageUrl(url, "false_positive");
        vscode.window.showInformationMessage(`❌ Marked as false positive: ${url}`);
      }
    }),
  );

  // --- Results: Triage - Ignore Repo ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.triageIgnoreRepo", (item: { pageResult?: PageResult }) => {
      const r = item?.pageResult;
      if (!r?.repo) {
        vscode.window.showWarningMessage("No repo information available for this result.");
        return;
      }
      resultsProvider.triageIgnoreRepo(r.repo);
      vscode.window.showInformationMessage(`🔇 Ignoring repo: ${r.repo}`);
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

  // --- Results: Triage - Suggest Improvements ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.triageSuggest", async () => {
      const results = resultsProvider.getResults();
      const triageState = resultsProvider.getTriageState();
      const scenarioName = resultsProvider.getActiveScenario() ?? "unknown";

      // Check we have triage decisions
      const hasDecisions = Object.keys(triageState.decisions).length > 0;
      if (!hasDecisions) {
        vscode.window.showInformationMessage("No triage decisions yet. Mark some results as valid or false positive first.");
        return;
      }

      // Load scenario config
      const scenarioDir = findScenarioDir(scenarioName);
      const scenarioConfig = loadScenarioConfig(scenarioDir);

      // Phase 1: Analyze
      const analysis = analyzeTriage(results, triageState, scenarioConfig);

      if (analysis.suggestions.length === 0 && analysis.remaining_fps.length === 0) {
        vscode.window.showInformationMessage("No improvement suggestions — precision looks good!");
        return;
      }

      // Phase 2: Show QuickPick loop
      await showTriageQuickPick(analysis, scenarioName, scenarioDir, scenarioConfig, results, triageState);
    }),
  );

  // --- Results: Filter ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.filterResults", async () => {
      const choices = [
        { label: "Show All", value: undefined, untriaged: false },
        { label: "Show Untriaged Only", value: undefined, untriaged: true },
        { label: "P0_OUTDATED", value: "P0_OUTDATED", untriaged: false },
        { label: "NEEDS_CLARIFICATION", value: "NEEDS_CLARIFICATION", untriaged: false },
        { label: "UP_TO_DATE", value: "UP_TO_DATE", untriaged: false },
        { label: "EXCLUDED", value: "EXCLUDED", untriaged: false },
      ];
      const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: "Filter results by classification",
      });
      if (picked !== undefined) {
        resultsProvider.setFilter(picked.value);
        resultsProvider.setShowUntriagedOnly(picked.untriaged);
      }
    }),
  );

  // --- Results: Refresh ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.refreshResults", () => {
      resultsProvider.refresh();
    }),
  );

  // --- Open Report File ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.openReport", async () => {
      const reportPath = resultsProvider.getActiveReportPath();
      if (reportPath) {
        const doc = await vscode.workspace.openTextDocument(reportPath);
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showInformationMessage("No report file found for the active scenario.");
      }
    }),
  );

  // --- Open Results in Panel ---
  ResultsPanel.onTriageCallback = (url, decision) => {
    resultsProvider.triageUrl(url, decision);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.openResultsPanel", () => {
      const results = resultsProvider.getResults();
      const scenario = resultsProvider.getActiveScenario() ?? "Results";
      const triageState = resultsProvider.getTriageState();
      if (results.length === 0) {
        vscode.window.showInformationMessage("No results to display. Run a freshness check first.");
        return;
      }
      ResultsPanel.createOrShow(context.extensionUri, results, scenario, triageState);
    }),
  );

  // --- Switch Results Scenario ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.switchResults", async () => {
      const scenarios = resultsProvider.getAvailableScenarios();
      if (scenarios.length === 0) {
        vscode.window.showInformationMessage("No results found. Run a freshness check first.");
        return;
      }
      const active = resultsProvider.getActiveScenario();
      const items = scenarios.map((s) => ({
        label: s === active ? `$(check) ${s}` : s,
        description: s === active ? "currently viewing" : undefined,
        scenario: s,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a scenario to view results for",
      });
      if (picked) {
        resultsProvider.loadScenario(picked.scenario);
      }
    }),
  );

  // --- Load Results from File ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.loadResults", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { "JSON / CSV": ["json", "csv"] },
        title: "Select a classifications.json or report.csv file",
      });
      if (!picked || picked.length === 0) { return; }
      resultsProvider.loadFile(picked[0].fsPath);
    }),
  );

  // --- Run Freshness Check ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.check", async (scenarioPathArg?: string | unknown) => {
      // When invoked from a tree-view toolbar, VS Code passes the tree item — not a string.
      const rawArg = typeof scenarioPathArg === "string" ? scenarioPathArg : undefined;
      const scenarioPath = rawArg ?? await pickScenario("Select a scenario to check");
      if (!scenarioPath) {
        return;
      }

      // Animate status bar while running
      statusBarItem.text = "$(sync~spin) Capacitor: Running…";
      statusBarItem.tooltip = "Freshness check in progress — click to cancel";
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

      const scenarioName = path.basename(path.dirname(scenarioPath));
      const scenarioParent = path.dirname(path.dirname(scenarioPath));
      const outputDir = path.join(scenarioParent, "output", scenarioName);
      const runner = createRunner();
      const result = await runner.runCheck(scenarioPath, outputDir, { timeoutMs: getTimeoutMs() });

      // Restore status bar
      statusBarItem.backgroundColor = undefined;
      if (result.success) {
        const now = new Date().toLocaleTimeString();
        statusBarItem.text = `$(beaker) Capacitor ✓ ${now}`;
        statusBarItem.tooltip = `Last check: ${scenarioName} at ${now}`;
        vscode.window.showInformationMessage(`✅ Freshness check complete for ${scenarioName} — see Results panel.`);
        resultsProvider.loadScenario(scenarioName);
      } else {
        statusBarItem.text = "$(beaker) Capacitor ✗ Failed";
        statusBarItem.tooltip = "Last check failed — click to retry";
        vscode.window.showErrorMessage(`Freshness check failed (exit ${result.exitCode}). See Output panel for details.`);
      }
    }),
  );

  // --- Scan Local Repo ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.deepScan", async (scenarioPathArg?: string | unknown, localPathArg?: string) => {
      const rawArg = typeof scenarioPathArg === "string" ? scenarioPathArg : undefined;
      const scenarioPath = rawArg ?? await pickScenario("Select a scenario for deep scan");
      if (!scenarioPath) {
        return;
      }

      let localPath = typeof localPathArg === "string" ? localPathArg : undefined;
      if (!localPath) {
        const folderUri = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: "Select repo folder to scan",
        });
        if (!folderUri || folderUri.length === 0) {
          return;
        }
        localPath = folderUri[0].fsPath;
      }

      statusBarItem.text = "$(sync~spin) Capacitor: Local Scan…";
      statusBarItem.tooltip = "Local scan in progress — this may take a while";
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

      const scenarioName = path.basename(path.dirname(scenarioPath));
      const scenarioParent = path.dirname(path.dirname(scenarioPath));
      const outputDir = path.join(scenarioParent, "output", scenarioName);
      const runner = createRunner();
      const result = await runner.runDeepScan(scenarioPath, outputDir, localPath, { timeoutMs: getTimeoutMs() });

      statusBarItem.backgroundColor = undefined;
      if (result.success) {
        const now = new Date().toLocaleTimeString();
        statusBarItem.text = `$(beaker) Capacitor ✓ ${now}`;
        statusBarItem.tooltip = `Local scan: ${scenarioName} at ${now}`;
        vscode.window.showInformationMessage(`✅ Local scan complete for ${scenarioName} — see Results panel.`);
        resultsProvider.loadScenario(scenarioName);
      } else {
        statusBarItem.text = "$(beaker) Capacitor ✗ Failed";
        statusBarItem.tooltip = "Deep scan failed — click to retry";
        vscode.window.showErrorMessage(`Deep scan failed (exit ${result.exitCode}). See Output panel for details.`);
      }
    }),
  );

  // --- Validate Scenario ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.validate", async (scenarioPathArg?: string | unknown) => {
      const rawArg = typeof scenarioPathArg === "string" ? scenarioPathArg : undefined;
      const scenarioPath = rawArg ?? await pickScenario("Select a scenario to validate");
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

  // --- Setup Environment / Settings ---
  context.subscriptions.push(
    vscode.commands.registerCommand("docs-capacitor.setupEnvironment", async () => {
      SettingsPanel.createOrShow(context.extensionUri);

      // Run checks and send state to the panel
      const checks = await runAllChecks();

      // Read current settings
      const config = vscode.workspace.getConfiguration("docs-capacitor");
      const pythonPath = config.get<string>("pythonPath", "python3");
      const timeoutMs = config.get<number>("timeoutMs", 1800000);
      const scenarioPaths = config.get<string[]>("scenarioPaths", []);

      // Read GITHUB_MODELS_USER from .env
      let modelsUser = process.env.GITHUB_MODELS_USER ?? "";
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!modelsUser && cwd) {
        try {
          const envPath = require("path").join(cwd, ".env");
          const envContent = require("fs").readFileSync(envPath, "utf-8") as string;
          const match = envContent.match(/GITHUB_MODELS_USER\s*=\s*(.+)/);
          if (match) { modelsUser = match[1].trim(); }
        } catch { /* no .env */ }
      }

      SettingsPanel.postState(checks, modelsUser, pythonPath, timeoutMs, scenarioPaths);
    }),
  );

  // --- Settings Panel Message Handlers ---
  SettingsPanel.onMessage = async (msg) => {
    switch (msg.command) {
      case "checkStatus": {
        const checks = await runAllChecks();
        SettingsPanel.postStatusUpdate(checks);
        break;
      }
      case "switchGitHubAccount":
      case "addModelsAccount": {
        const terminal = vscode.window.createTerminal("GitHub Auth");
        terminal.show();
        terminal.sendText("gh auth login -h github.com");
        break;
      }
      case "saveModelsUser": {
        const user = (msg as { user?: string }).user ?? "";
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot) {
          const fs = require("fs") as typeof import("fs");
          const envPath = require("path").join(wsRoot, ".env");
          let content = "";
          try { content = fs.readFileSync(envPath, "utf-8"); } catch { /* new file */ }
          if (content.match(/GITHUB_MODELS_USER\s*=/)) {
            content = content.replace(/GITHUB_MODELS_USER\s*=.*/, `GITHUB_MODELS_USER=${user}`);
          } else {
            content += `${content && !content.endsWith("\n") ? "\n" : ""}GITHUB_MODELS_USER=${user}\n`;
          }
          fs.writeFileSync(envPath, content, "utf-8");
          vscode.window.showInformationMessage(`Saved GITHUB_MODELS_USER=${user} to .env`);
        }
        break;
      }
      case "testModelsConnection": {
        const { spawn } = require("child_process") as typeof import("child_process");
        const user = (msg as { user?: string }).user ?? "";
        const args = user ? ["auth", "token", "-u", user] : ["auth", "token"];
        try {
          const child = spawn("gh", args, { timeout: 5000 });
          let stdout = "";
          child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
          child.on("close", (code: number | null) => {
            SettingsPanel.postTestResult(
              code === 0 && stdout.trim().length > 0,
              code === 0 ? `Token retrieved for ${user || "active account"}` : "Failed to get token",
            );
          });
          child.on("error", () => {
            SettingsPanel.postTestResult(false, "gh CLI not found");
          });
        } catch {
          SettingsPanel.postTestResult(false, "Failed to run gh CLI");
        }
        break;
      }
      case "saveSettings": {
        const { pythonPath, timeoutMs, scenarioPaths } = msg as {
          pythonPath?: string; timeoutMs?: number; scenarioPaths?: string[];
        };
        const config = vscode.workspace.getConfiguration("docs-capacitor");
        if (pythonPath !== undefined) { await config.update("pythonPath", pythonPath, true); }
        if (timeoutMs !== undefined) { await config.update("timeoutMs", timeoutMs, true); }
        if (scenarioPaths !== undefined) { await config.update("scenarioPaths", scenarioPaths, true); }
        vscode.window.showInformationMessage("Settings saved.");
        break;
      }
    }
  };

  outputChannel.appendLine("Docs Capacitor extension activated.");

  // Run a lightweight prerequisite check after activation
  activationCheck();
}

export function deactivate(): void {
  outputChannel?.dispose();
}

// ── Triage suggestion helpers ────────────────────────────────────────

function findScenarioDir(scenarioName: string): string | undefined {
  const fs = require("fs") as typeof import("fs");

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const wsRoot = folder.uri.fsPath;
    // Direct child: <root>/<scenarioName>/scenario.yaml
    const direct = path.join(wsRoot, scenarioName);
    if (fs.existsSync(path.join(direct, "scenario.yaml"))) { return direct; }
    // Under scenarios/: <root>/scenarios/<scenarioName>/scenario.yaml
    const sub = path.join(wsRoot, "scenarios", scenarioName);
    if (fs.existsSync(path.join(sub, "scenario.yaml"))) { return sub; }
  }

  const scenarioPaths = vscode.workspace
    .getConfiguration("docs-capacitor")
    .get<string[]>("scenarioPaths", []);
  for (const sp of scenarioPaths) {
    const resolved = path.isAbsolute(sp)
      ? sp
      : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", sp);
    const dir = path.join(resolved, scenarioName);
    if (fs.existsSync(path.join(dir, "scenario.yaml"))) { return dir; }
    // sp itself might be the scenario dir
    if (path.basename(resolved) === scenarioName && fs.existsSync(path.join(resolved, "scenario.yaml"))) {
      return resolved;
    }
  }
  return undefined;
}

function loadScenarioConfig(scenarioDir: string | undefined): ScenarioConfig {
  const empty: ScenarioConfig = {
    excluded_repos: [],
    allowed_repos: [],
    hard_exclusion_url_regex: [],
    hard_exclusion_repo_regex: [],
    queries: [],
  };
  if (!scenarioDir) { return empty; }

  const fs = require("fs") as typeof import("fs");
  const yaml = require("js-yaml");

  const config = { ...empty };

  // Load scenario.yaml
  const scenarioPath = path.join(scenarioDir, "scenario.yaml");
  if (fs.existsSync(scenarioPath)) {
    try {
      const doc = yaml.load(fs.readFileSync(scenarioPath, "utf-8")) as Record<string, unknown>;
      const search = doc?.search as Record<string, unknown> | undefined;
      const github = search?.github as Record<string, unknown> | undefined;
      if (Array.isArray(github?.excluded_repos)) {
        config.excluded_repos = github.excluded_repos as string[];
      }
      if (Array.isArray(github?.allowed_repos)) {
        config.allowed_repos = github.allowed_repos as string[];
      }
      if (Array.isArray(github?.queries)) {
        config.queries = github.queries as string[];
      }
    } catch { /* ignore parse errors */ }
  }

  // Load strategy.yaml
  const strategyPath = path.join(scenarioDir, "strategy.yaml");
  if (fs.existsSync(strategyPath)) {
    try {
      const doc = yaml.load(fs.readFileSync(strategyPath, "utf-8")) as Record<string, unknown>;
      const hard = doc?.hard_exclusions as Record<string, unknown> | undefined;
      if (Array.isArray(hard?.url_regex)) {
        config.hard_exclusion_url_regex = hard.url_regex as string[];
      }
      if (Array.isArray(hard?.repo_regex)) {
        config.hard_exclusion_repo_regex = hard.repo_regex as string[];
      }
    } catch { /* ignore parse errors */ }
  }

  return config;
}

interface QuickPickSuggestionItem extends vscode.QuickPickItem {
  suggestion?: TriageSuggestion;
  action?: "copilot_chat";
}

async function showTriageQuickPick(
  analysis: TriageAnalysis,
  scenarioName: string,
  scenarioDir: string | undefined,
  scenarioConfig: ScenarioConfig,
  results: PageResult[],
  triageState: import("./resultsProvider").TriageState,
): Promise<void> {
  const { summary, suggestions } = analysis;
  let remainingFps = [...analysis.remaining_fps];

  // Loop so user can apply multiple suggestions
  while (true) {
    const precisionPct = Math.round(summary.current_precision * 100);
    const items: QuickPickSuggestionItem[] = [];

    // Header item (not selectable)
    items.push({
      label: `$(target) Precision: ${precisionPct}% (${summary.valid_count} valid, ${summary.fp_count} false positive)`,
      kind: vscode.QuickPickItemKind.Separator,
    });

    // Suggestion items
    const activeSuggestions = suggestions.filter((s) => s.impact.fp_removed > 0);
    for (const s of activeSuggestions) {
      const icon = s.safe ? "$(check)" : "$(warning)";
      const risk = s.safe ? "" : `, ${s.impact.valid_at_risk} valid at risk`;
      items.push({
        label: `${icon} ${s.description}`,
        detail: `    ${s.yamlFile} → ${s.yamlKey} — removes ${s.impact.fp_removed} FPs${risk}`,
        description: s.confidence === "high" ? "" : `(${s.confidence} confidence)`,
        suggestion: s,
      });
    }

    // Separator before Copilot Chat option
    if (remainingFps.length > 0) {
      items.push({
        label: "Copilot Chat",
        kind: vscode.QuickPickItemKind.Separator,
      });
      items.push({
        label: `$(comment-discussion) Open Copilot Chat for ${remainingFps.length} remaining FPs without clear patterns`,
        action: "copilot_chat",
      });
    }

    if (activeSuggestions.length === 0 && remainingFps.length === 0) {
      vscode.window.showInformationMessage("All suggestions applied or no more improvements found.");
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `Precision Tuning — ${scenarioName}`,
      placeHolder: "Select a suggestion to apply",
      canPickMany: false,
    });

    if (!picked) { return; } // User cancelled

    if (picked.action === "copilot_chat") {
      openCopilotChatForRemainingFps(
        remainingFps, scenarioName, summary, scenarioDir, results, triageState,
      );
      return;
    }

    if (picked.suggestion) {
      const applied = await applySuggestion(picked.suggestion, scenarioDir);
      if (applied) {
        // Remove this suggestion and update remaining FPs
        const idx = suggestions.indexOf(picked.suggestion);
        if (idx !== -1) { suggestions.splice(idx, 1); }
        // FP URLs handled by this suggestion are no longer "remaining"
        const handled = new Set(picked.suggestion.impact.fp_urls);
        remainingFps = remainingFps.filter((u) => !handled.has(u));
      }
    }
  }
}

async function applySuggestion(
  suggestion: TriageSuggestion,
  scenarioDir: string | undefined,
): Promise<boolean> {
  if (!scenarioDir) {
    vscode.window.showErrorMessage("Cannot find scenario directory to apply changes.");
    return false;
  }

  const fs = require("fs") as typeof import("fs");
  const yaml = require("js-yaml");
  const filePath = path.join(scenarioDir, suggestion.yamlFile);

  if (!fs.existsSync(filePath)) {
    vscode.window.showErrorMessage(`File not found: ${filePath}`);
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const doc = yaml.load(raw) as Record<string, unknown>;

    if (suggestion.type === "remove_allowed_repo" || suggestion.type === "remove_query") {
      // Remove from the target array
      const arr = getNestedArray(doc, suggestion.yamlKey);
      if (arr) {
        const idx = arr.findIndex(
          (v: string) => v.toLowerCase() === suggestion.value.toLowerCase(),
        );
        if (idx !== -1) { arr.splice(idx, 1); }
      }
    } else if (suggestion.type === "refine_query" && suggestion.replacement) {
      // Replace query with the refined version
      const arr = getNestedArray(doc, suggestion.yamlKey);
      if (arr) {
        const idx = arr.findIndex(
          (v: string) => v.toLowerCase() === suggestion.value.toLowerCase(),
        );
        if (idx !== -1) {
          arr[idx] = suggestion.replacement;
        }
      }
    } else {
      // Add to the target array
      const arr = ensureNestedArray(doc, suggestion.yamlKey);
      if (!arr.includes(suggestion.value)) {
        arr.push(suggestion.value);
      }
    }

    const output = yaml.dump(doc, { lineWidth: -1, quotingType: "'", forceQuotes: false });
    fs.writeFileSync(filePath, output, "utf-8");

    const actionVerb = suggestion.type === "remove_allowed_repo" || suggestion.type === "remove_query"
      ? "Removed" : suggestion.type === "refine_query" ? "Refined" : "Added";
    const preposition = suggestion.type === "remove_allowed_repo" || suggestion.type === "remove_query"
      ? "from" : suggestion.type === "refine_query" ? "in" : "to";
    const displayValue = suggestion.type === "refine_query"
      ? `"${suggestion.value}" → "${suggestion.replacement}"` : `'${suggestion.value}'`;
    vscode.window.showInformationMessage(
      `${actionVerb} ${displayValue} ${preposition} ${suggestion.yamlKey} in ${suggestion.yamlFile} — ${suggestion.impact.fp_removed} false positives will be filtered on next run`,
    );
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to update ${suggestion.yamlFile}: ${err}`);
    return false;
  }
}

function getNestedArray(obj: Record<string, unknown>, keyPath: string): string[] | undefined {
  const keys = keyPath.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current) ? current as string[] : undefined;
}

function ensureNestedArray(obj: Record<string, unknown>, keyPath: string): string[] {
  const keys = keyPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] === undefined || current[keys[i]] === null || typeof current[keys[i]] !== "object") {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1];
  if (!Array.isArray(current[lastKey])) {
    current[lastKey] = [];
  }
  return current[lastKey] as string[];
}

function openCopilotChatForRemainingFps(
  remainingFps: string[],
  scenarioName: string,
  summary: TriageAnalysis["summary"],
  scenarioDir: string | undefined,
  results: PageResult[],
  triageState: import("./resultsProvider").TriageState,
): void {
  const fs = require("fs") as typeof import("fs");
  const yaml = require("js-yaml");

  // Gather valid URLs for context
  const validUrls = Object.entries(triageState.decisions)
    .filter(([, d]) => d === "valid")
    .map(([url]) => url);

  // Group remaining FPs by repo for structure
  const fpsByRepo: Record<string, string[]> = {};
  for (const url of remainingFps) {
    const result = results.find((r) => r.url === url);
    const repo = result?.repo ?? "unknown";
    if (!fpsByRepo[repo]) { fpsByRepo[repo] = []; }
    fpsByRepo[repo].push(url);
  }

  // Load current config for context
  let scenarioYamlContent = "";
  let strategyYamlContent = "";
  if (scenarioDir) {
    try { scenarioYamlContent = fs.readFileSync(path.join(scenarioDir, "scenario.yaml"), "utf-8"); } catch { /* */ }
    try { strategyYamlContent = fs.readFileSync(path.join(scenarioDir, "strategy.yaml"), "utf-8"); } catch { /* */ }
  }

  const precisionPct = Math.round(summary.current_precision * 100);
  const parts: string[] = [
    `I'm tuning retrieval precision for the "${scenarioName}" docs freshness scenario.`,
    `Current precision: ${precisionPct}% (${summary.valid_count} valid, ${summary.fp_count} false positive).`,
    "",
    `These ${remainingFps.length} false positive URLs don't match any simple repo or path pattern. I need specific regex exclusion rules.`,
    "",
    "**Remaining false positive URLs (grouped by repo):**",
  ];

  for (const [repo, urls] of Object.entries(fpsByRepo)) {
    parts.push(`\n_${repo}:_`);
    for (const url of urls.slice(0, 10)) {
      parts.push(`- ${url}`);
    }
    if (urls.length > 10) {
      parts.push(`- ... and ${urls.length - 10} more`);
    }
  }

  parts.push("");
  parts.push("**Valid URLs to PRESERVE (do not exclude these):**");
  for (const url of validUrls.slice(0, 15)) {
    parts.push(`- ${url}`);
  }
  if (validUrls.length > 15) {
    parts.push(`- ... and ${validUrls.length - 15} more`);
  }

  if (scenarioYamlContent) {
    parts.push("");
    parts.push("**Current scenario.yaml:**");
    parts.push("```yaml");
    parts.push(scenarioYamlContent.trim());
    parts.push("```");
  }
  if (strategyYamlContent) {
    parts.push("");
    parts.push("**Current strategy.yaml:**");
    parts.push("```yaml");
    parts.push(strategyYamlContent.trim());
    parts.push("```");
  }

  parts.push("");
  parts.push("Suggest specific `hard_exclusions.url_regex` patterns for strategy.yaml that would exclude the false positives above WITHOUT matching any of the valid URLs. For each pattern, show which FP URLs it matches.");

  const prompt = parts.join("\n");

  vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt }).then(
    undefined,
    () => {
      vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(
        "Copilot Chat not available. Suggestions prompt copied to clipboard.",
      );
    },
  );
}
