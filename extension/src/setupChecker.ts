/**
 * Setup checker — verifies prerequisites and guides writers through fixes.
 *
 * Checks: Python interpreter, capacitor package, gh CLI, gh auth status.
 * Each check returns a result with status and a fix action that can open
 * an integrated terminal with the right command.
 */

import * as vscode from "vscode";
import * as https from "https";
import * as path from "path";

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  /** If not ok, the action that can fix it. */
  fixLabel?: string;
  fixCommand?: string;
}

/** Run a shell command and return { ok, stdout }. */
async function probe(cmd: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; stdout: string }> {
  const { spawn } = require("child_process") as typeof import("child_process");
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { timeout: timeoutMs });
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.on("close", (code: number | null) => resolve({ ok: code === 0, stdout: stdout.trim() }));
      child.on("error", () => resolve({ ok: false, stdout: "" }));
    } catch {
      resolve({ ok: false, stdout: "" });
    }
  });
}

/** Get the configured Python path. */
function pythonPath(): string {
  return vscode.workspace.getConfiguration("docs-capacitor").get<string>("pythonPath", "python");
}

async function discoverPythonCommand(configured: string): Promise<string | undefined> {
  const configuredTrimmed = configured.trim();
  const candidates = process.platform === "win32"
    ? [configuredTrimmed, "python", "py", "python3"]
    : [configuredTrimmed, "python3", "python"];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) { continue; }
    seen.add(candidate);
    const result = await probe(candidate, ["--version"]);
    if (result.ok) { return candidate; }
  }
  return undefined;
}

function installPythonCommand(): string {
  if (process.platform === "darwin") {
    return "brew install python3";
  }
  if (process.platform === "win32") {
    return "winget install --id Python.Python.3";
  }
  return "# Install Python 3.9+ from https://python.org or your distro package manager";
}

function installGhCommand(): string {
  if (process.platform === "darwin") {
    return "brew install gh";
  }
  if (process.platform === "win32") {
    return "winget install --id GitHub.cli";
  }
  return "# Install from https://cli.github.com";
}

function usePublicLearnFallback(): boolean {
  return vscode.workspace.getConfiguration("docs-capacitor").get<boolean>("usePublicLearnFallback", true);
}

function discoverScenarioLearnDefaults(): { url?: string; scope?: string } {
  const fs = require("fs") as typeof import("fs");
  const yaml = require("js-yaml");
  const roots: string[] = [];
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) {
    roots.push(path.join(wsRoot, "scenarios"));
    roots.push(wsRoot);
  }
  const extraPaths = vscode.workspace.getConfiguration("docs-capacitor").get<string[]>("scenarioPaths", []);
  for (const p of extraPaths) {
    roots.push(path.isAbsolute(p) ? p : path.join(wsRoot ?? "", p));
  }

  const seen = new Set<string>();
  const out: { url?: string; scope?: string } = {};

  const walk = (dir: string, depth: number): void => {
    if (!dir || depth > 4 || !fs.existsSync(dir)) { return; }
    let entries: import("fs").Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if ([".git", "node_modules", "out", "__pycache__"].includes(entry.name)) { continue; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name !== "scenario.yaml" || seen.has(full)) { continue; }
      seen.add(full);
      try {
        const raw = fs.readFileSync(full, "utf-8");
        const doc = yaml.load(raw) as Record<string, unknown> | undefined;
        const search = doc?.search as Record<string, unknown> | undefined;
        const learn = search?.learn as Record<string, unknown> | undefined;
        const url = typeof learn?.knowledge_service_url === "string" ? learn.knowledge_service_url.trim() : "";
        const scope = typeof learn?.knowledge_service_scope === "string" ? learn.knowledge_service_scope.trim() : "";
        if (!out.url && url) { out.url = url; }
        if (!out.scope && scope) { out.scope = scope; }
        if (out.url && out.scope) { return; }
      } catch {
        // ignore parse errors
      }
    }
  };

  for (const root of roots) {
    walk(root, 0);
    if (out.url && out.scope) { break; }
  }
  return out;
}

function learnServiceUrl(): string {
  const cfg = vscode.workspace.getConfiguration("docs-capacitor");
  const explicit = (cfg.get<string>("learnKnowledgeServiceUrl", "") ?? "").trim() || (process.env.LEARN_KNOWLEDGE_SERVICE_URL ?? "").trim();
  if (explicit) { return explicit; }
  return discoverScenarioLearnDefaults().url ?? "";
}

function learnServiceScope(): string {
  const cfg = vscode.workspace.getConfiguration("docs-capacitor");
  const explicit = (cfg.get<string>("learnKnowledgeServiceScope", "") ?? "").trim() || (process.env.LEARN_KNOWLEDGE_SERVICE_SCOPE ?? "").trim();
  if (explicit) { return explicit; }
  return discoverScenarioLearnDefaults().scope ?? "";
}

// ── Individual checks ──────────────────────────────────────────────────

async function checkPython(): Promise<CheckResult> {
  const configured = pythonPath();
  const discovered = await discoverPythonCommand(configured);
  if (discovered) {
    const result = await probe(discovered, ["--version"]);
    return {
      name: "Python",
      ok: true,
      message: `${result.stdout || "Python detected"}${discovered !== configured ? ` (using ${discovered})` : ""} ✓`,
    };
  }
  return {
    name: "Python",
    ok: false,
    message: `Python not found at "${configured}"`,
    fixLabel: "Install Python",
    fixCommand: installPythonCommand(),
  };
}

async function checkCapacitorPackage(): Promise<CheckResult> {
  const configured = pythonPath();
  const py = await discoverPythonCommand(configured) ?? configured;
  const result = await probe(py, ["-m", "capacitor", "--help"]);
  if (result.ok) {
    return { name: "Capacitor package", ok: true, message: "capacitor Python package installed ✓" };
  }
  const bundled = vscode.extensions.getExtension("microsoft.docs-capacitor");
  const bundledSource = bundled ? path.join(bundled.extensionPath, "python-src", "pyproject.toml") : "";
  const fs = require("fs") as typeof import("fs");
  if (bundledSource && fs.existsSync(bundledSource)) {
    return {
      name: "Capacitor package",
      ok: true,
      message: "Bundled runtime available — auto-installed on first run ✓",
    };
  }
  return {
    name: "Capacitor package",
    ok: false,
    message: "capacitor Python package not installed",
    fixLabel: "Install capacitor",
    fixCommand: `${py} -m pip install "docs-capacitor[llm]"`,
  };
}

async function checkGhCli(): Promise<CheckResult> {
  const result = await probe("gh", ["--version"]);
  if (result.ok) {
    const version = result.stdout.split("\n")[0] ?? "gh CLI";
    return { name: "GitHub CLI", ok: true, message: `${version} ✓` };
  }
  return {
    name: "GitHub CLI",
    ok: false,
    message: "GitHub CLI (gh) not installed",
    fixLabel: "Install GitHub CLI",
    fixCommand: installGhCommand(),
  };
}

function parseGhAccount(statusOutput: string): string | undefined {
  const patterns = [
    /account\s+([a-zA-Z0-9-]+)\s*\(/i,
    /Logged in to [^\s]+ account\s+([a-zA-Z0-9-]+)/i,
    /as\s+([a-zA-Z0-9-]+)\s+\(/i,
  ];
  for (const p of patterns) {
    const m = statusOutput.match(p);
    if (m?.[1]) { return m[1]; }
  }
  return undefined;
}

async function getActiveGhAccount(): Promise<string | undefined> {
  const status = await probe("gh", ["auth", "status", "-h", "github.com"]);
  if (!status.ok) { return undefined; }
  return parseGhAccount(status.stdout);
}

async function checkGhAuth(): Promise<CheckResult> {
  const result = await probe("gh", ["auth", "status", "-h", "github.com"]);
  if (result.ok) {
    const account = parseGhAccount(result.stdout);
    return {
      name: "GitHub auth",
      ok: true,
      message: account ? `Authenticated as ${account} ✓` : "Authenticated with GitHub ✓",
    };
  }
  // gh CLI might not be installed at all
  const ghInstalled = await probe("gh", ["--version"]);
  if (!ghInstalled.ok) {
    return {
      name: "GitHub auth",
      ok: false,
      message: "GitHub CLI not installed (install first)",
      fixLabel: "Install GitHub CLI",
      fixCommand: installGhCommand(),
    };
  }
  return {
    name: "GitHub auth",
    ok: false,
    message: "Not authenticated — needed for search and AI detection",
    fixLabel: "Sign in to GitHub",
    fixCommand: "gh auth login",
  };
}

async function checkModelsAuth(): Promise<CheckResult> {
  const modelsToken = process.env.GITHUB_MODELS_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  const modelsUser = (process.env.GITHUB_MODELS_USER ?? "").trim();
  const activeAccount = await getActiveGhAccount();
  if (modelsToken.trim().length > 0) {
    const account = modelsUser || activeAccount;
    return {
      name: "Models auth",
      ok: true,
      message: account ? `Token configured for ${account} ✓` : "Token found in environment ✓",
    };
  }

  const args = modelsUser ? ["auth", "token", "-u", modelsUser] : ["auth", "token"];
  const result = await probe("gh", args);
  if (result.ok && result.stdout.length > 0) {
    return {
      name: "Models auth",
      ok: true,
      message: modelsUser
        ? `Token available for ${modelsUser} ✓`
        : activeAccount
          ? `Token available for ${activeAccount} ✓`
          : "Token available for active account ✓",
    };
  }

  return {
    name: "Models auth",
    ok: false,
    message: "No GitHub Models token/account configured",
    fixLabel: "Set up Models auth",
    fixCommand: "gh auth login -h github.com",
  };
}

function probeHttps(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status?: number }> {
  return new Promise((resolve) => {
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        resolve({ ok: status >= 200 && status < 500, status });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false });
      });
      req.on("error", () => resolve({ ok: false }));
    } catch {
      resolve({ ok: false });
    }
  });
}

async function checkLearnAccess(): Promise<CheckResult> {
  const url = learnServiceUrl();
  if (!url) {
    if (usePublicLearnFallback()) {
      return {
        name: "Learn access",
        ok: true,
        message: "Internal Learn URL not configured; using public Learn fallback ✓",
      };
    }
    return {
      name: "Learn access",
      ok: false,
      message: "Internal Learn service URL is not configured",
      fixLabel: "Configure Learn service",
      fixCommand: "Set docs-capacitor.learnKnowledgeServiceUrl in Setup & Configuration",
    };
  }
  const probe = await probeHttps(url);
  if (probe.ok) {
    return { name: "Learn access", ok: true, message: "Internal Learn service is reachable ✓" };
  }
  return {
    name: "Learn access",
    ok: false,
    message: "Cannot reach internal Learn service URL",
    fixLabel: "Check network/proxy",
    fixCommand: "# Verify network/proxy allows the internal Learn service URL",
  };
}

async function checkLearnServiceAuth(): Promise<CheckResult> {
  const scope = learnServiceScope();
  const explicitToken = (process.env.LEARN_KNOWLEDGE_SERVICE_TOKEN ?? "").trim();
  if (!scope) {
    if (usePublicLearnFallback()) {
      return {
        name: "Learn service auth",
        ok: true,
        message: explicitToken
          ? "Internal Learn token set; scope optional for current setup ✓"
          : "Internal Learn scope not configured; using public Learn fallback ✓",
      };
    }
    return {
      name: "Learn service auth",
      ok: false,
      message: "Learn service scope is not configured",
      fixLabel: "Configure Learn scope",
      fixCommand: "Set docs-capacitor.learnKnowledgeServiceScope (for example: api://<app-id>/.default)",
    };
  }
  if (explicitToken) {
    return { name: "Learn service auth", ok: true, message: "Using LEARN_KNOWLEDGE_SERVICE_TOKEN ✓" };
  }

  const configured = pythonPath();
  const py = await discoverPythonCommand(configured) ?? configured;
  const script =
    "from azure.identity import DefaultAzureCredential; " +
    "import sys; " +
    "scope=sys.argv[1]; " +
    "t=DefaultAzureCredential(exclude_interactive_browser_credential=False).get_token(scope); " +
    "print('ok' if t and t.token else '')";
  const result = await probe(py, ["-c", script, scope], 15000);
  if (result.ok && result.stdout.includes("ok")) {
    return { name: "Learn service auth", ok: true, message: "DefaultAzureCredential acquired token ✓" };
  }

  return {
    name: "Learn service auth",
    ok: false,
    message: "DefaultAzureCredential token acquisition failed",
    fixLabel: "Sign in to Azure",
    fixCommand: "az login",
  };
}

// ── Public API ─────────────────────────────────────────────────────────

/** Run all prerequisite checks and return results. */
export async function runAllChecks(): Promise<CheckResult[]> {
  // Run Python check first (others depend on it)
  const pyResult = await checkPython();
  const results: CheckResult[] = [pyResult];

  if (pyResult.ok) {
    results.push(await checkCapacitorPackage());
  } else {
    results.push({ name: "Capacitor package", ok: false, message: "Skipped (Python not found)" });
  }

  results.push(await checkGhCli());
  results.push(await checkGhAuth());
  results.push(await checkModelsAuth());
  results.push(await checkLearnAccess());
  results.push(await checkLearnServiceAuth());

  return results;
}

/** Show a notification for a failed check with a fix button. */
export function showFixNotification(check: CheckResult): void {
  if (check.ok || !check.fixLabel) { return; }

  const actions: string[] = [check.fixLabel];
  if (check.fixCommand) { actions.push("Copy Command"); }

  vscode.window.showWarningMessage(
    `Docs Capacitor: ${check.message}`,
    ...actions,
  ).then((action) => {
    if (!action) { return; }
    if (action === "Copy Command" && check.fixCommand) {
      vscode.env.clipboard.writeText(check.fixCommand);
      vscode.window.showInformationMessage("Command copied to clipboard.");
      return;
    }
    // Open terminal with the fix command
    if (check.fixCommand) {
      const terminal = vscode.window.createTerminal("Docs Capacitor Setup");
      terminal.show();
      terminal.sendText(check.fixCommand);
    }
  });
}

/** Run checks and show a full report in an output channel + notifications for failures. */
export async function showSetupReport(outputChannel: vscode.OutputChannel): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine("═".repeat(50));
  outputChannel.appendLine("  Docs Capacitor — Environment Setup Check");
  outputChannel.appendLine("═".repeat(50));
  outputChannel.appendLine("");

  const results = await runAllChecks();
  const failures: CheckResult[] = [];

  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    outputChannel.appendLine(`  ${icon}  ${r.name}: ${r.message}`);
    if (!r.ok && r.fixCommand) {
      outputChannel.appendLine(`     Fix: ${r.fixCommand}`);
    }
    if (!r.ok) { failures.push(r); }
  }

  outputChannel.appendLine("");
  if (failures.length === 0) {
    outputChannel.appendLine("  All checks passed! You're ready to run freshness checks.");
    vscode.window.showInformationMessage("✅ Docs Capacitor: All prerequisites met!");
  } else {
    outputChannel.appendLine(`  ${failures.length} issue${failures.length > 1 ? "s" : ""} found. Fix them above to get started.`);
    // Show notification for the most important failure
    showFixNotification(failures[0]);
  }
  outputChannel.appendLine("═".repeat(50));
}

/** Lightweight activation check — only notifies on real problems, non-intrusively. */
export async function activationCheck(): Promise<void> {
  const results = await runAllChecks();
  const failures = results.filter((r) => !r.ok);

  if (failures.length === 0) { return; }

  // Only show one notification to avoid spamming
  const firstFailure = failures[0];
  const moreText = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";

  const action = await vscode.window.showWarningMessage(
    `Docs Capacitor: ${firstFailure.message}${moreText}`,
    "Run Setup Check",
    firstFailure.fixLabel ?? "Dismiss",
  );

  if (action === "Run Setup Check") {
    vscode.commands.executeCommand("docs-capacitor.setupEnvironment");
  } else if (action === firstFailure.fixLabel && firstFailure.fixCommand) {
    const terminal = vscode.window.createTerminal("Docs Capacitor Setup");
    terminal.show();
    terminal.sendText(firstFailure.fixCommand);
  }
}
