/**
 * Setup checker — verifies prerequisites and guides writers through fixes.
 *
 * Checks: Python interpreter, capacitor package, gh CLI, gh auth status.
 * Each check returns a result with status and a fix action that can open
 * an integrated terminal with the right command.
 */

import * as vscode from "vscode";

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
  return vscode.workspace.getConfiguration("docs-capacitor").get<string>("pythonPath", "python3");
}

// ── Individual checks ──────────────────────────────────────────────────

async function checkPython(): Promise<CheckResult> {
  const py = pythonPath();
  const result = await probe(py, ["--version"]);
  if (result.ok) {
    return { name: "Python", ok: true, message: `${result.stdout} ✓` };
  }
  return {
    name: "Python",
    ok: false,
    message: `Python not found at "${py}"`,
    fixLabel: "Install Python",
    fixCommand: process.platform === "darwin"
      ? "brew install python3"
      : "# Install Python 3.9+ from https://python.org",
  };
}

async function checkCapacitorPackage(): Promise<CheckResult> {
  const py = pythonPath();
  const result = await probe(py, ["-m", "capacitor", "--help"]);
  if (result.ok) {
    return { name: "Capacitor package", ok: true, message: "capacitor Python package installed ✓" };
  }
  return {
    name: "Capacitor package",
    ok: false,
    message: "capacitor Python package not installed",
    fixLabel: "Install capacitor",
    fixCommand: `${py} -m pip install 'docs-capacitor[llm]'`,
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
    fixCommand: process.platform === "darwin"
      ? "brew install gh"
      : "# Install from https://cli.github.com",
  };
}

async function checkGhAuth(): Promise<CheckResult> {
  const result = await probe("gh", ["auth", "status"]);
  if (result.ok) {
    return { name: "GitHub auth", ok: true, message: "Authenticated with GitHub ✓" };
  }
  // gh CLI might not be installed at all
  const ghInstalled = await probe("gh", ["--version"]);
  if (!ghInstalled.ok) {
    return { name: "GitHub auth", ok: false, message: "GitHub CLI not installed (install first)", fixLabel: "Install GitHub CLI", fixCommand: "brew install gh" };
  }
  return {
    name: "GitHub auth",
    ok: false,
    message: "Not authenticated — needed for search and AI detection",
    fixLabel: "Sign in to GitHub",
    fixCommand: "gh auth login",
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
