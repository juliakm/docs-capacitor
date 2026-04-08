import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";

export interface RunOptions {
  /** Timeout in milliseconds. Defaults to 300 000 (5 min). */
  timeoutMs?: number;
  /** VS Code cancellation token forwarded from withProgress. */
  token?: vscode.CancellationToken;
}

export interface RunResult {
  success: boolean;
  output: string;
  exitCode: number;
}

// Patterns used to update the progress message while the pipeline runs.
const PROGRESS_PATTERNS: Array<{ re: RegExp; message: (m: RegExpMatchArray) => string }> = [
  { re: /Fetching release notes/i, message: () => "Fetching release notes…" },
  { re: /Collecting from:\s*(.+)/i, message: (m) => `Collecting from ${m[1]}…` },
  { re: /Learn search:\s*(\d+) total/i, message: (m) => `Learn search: ${m[1]} results found` },
  { re: /\[(\d+)\/(\d+)\]\s*gh search/i, message: (m) => `GitHub search (${m[1]}/${m[2]})…` },
  { re: /\[(\d+)\/(\d+)\]\s+(?:https?:\/\/|\(cached\))/i, message: (m) => `LLM: checking page ${m[1]}/${m[2]}…` },
  { re: /\[(\d+)\/(\d+)\]/i, message: (m) => `Searching… (${m[1]}/${m[2]})` },
  { re: /Collected (\d+) pages from (\w+)/i, message: (m) => `${m[2]}: ${m[1]} pages collected` },
  { re: /Total pages collected:\s*(\d+)/i, message: (m) => `${m[1]} pages collected — detecting…` },
  { re: /Running detector:\s*(.+)/i, message: (m) => `Running detector: ${m[1]}` },
  { re: /found (\d+) findings/i, message: (m) => `Found ${m[1]} findings` },
  { re: /LLM conflict check:\s*(.+)/i, message: (m) => `LLM analysis: ${m[1]}` },
  { re: /Classifying findings/i, message: () => "Classifying findings…" },
  { re: /Total findings:\s*(\d+)/i, message: (m) => `${m[1]} total findings — classifying…` },
  { re: /Report written:\s*(.+)/i, message: (m) => `Report saved: ${m[1]}` },
  { re: /Writing results/i, message: () => "Writing results…" },
];

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const EXTENSION_REPORT_FORMATS = ["json", "csv", "markdown"] as const;

export class PipelineRunner {
  private outputChannel: vscode.OutputChannel;

  constructor(
    private readonly pythonPath: string,
    private readonly workspaceRoot: string,
    channel?: vscode.OutputChannel,
    private readonly extraEnv?: Record<string, string>,
  ) {
    this.outputChannel = channel ?? vscode.window.createOutputChannel("Docs Capacitor");
  }

  /** Create a runner that reuses an existing output channel. */
  static withOutputChannel(
    pythonPath: string,
    workspaceRoot: string,
    channel: vscode.OutputChannel,
    extraEnv?: Record<string, string>,
  ): PipelineRunner {
    return new PipelineRunner(pythonPath, workspaceRoot, channel, extraEnv);
  }

  // ── public API ────────────────────────────────────────────────────

  runCheck(scenarioPath: string, outputDir: string, options?: RunOptions): Promise<RunResult> {
    const args = ["-m", "capacitor", "check", "-s", scenarioPath, "-o", outputDir];
    for (const format of EXTENSION_REPORT_FORMATS) {
      args.push("--format", format);
    }
    return this.execute(args, "Freshness Check", options);
  }

  runDeepScan(scenarioPath: string, outputDir: string, localPath: string, options?: RunOptions): Promise<RunResult> {
    const args = ["-m", "capacitor", "check", "-s", scenarioPath, "-o", outputDir, "--local-path", localPath];
    for (const format of EXTENSION_REPORT_FORMATS) {
      args.push("--format", format);
    }
    return this.execute(args, "Local Scan", options);
  }

  runValidate(scenarioPath: string, options?: RunOptions): Promise<RunResult> {
    const args = ["-m", "capacitor", "validate", "-s", scenarioPath];
    return this.execute(args, "Validate Scenario", options);
  }

  runRefreshNotes(scenarioPath: string, outputDir: string, options?: RunOptions): Promise<RunResult> {
    const args = ["-m", "capacitor", "refresh-notes", "-s", scenarioPath, "-o", outputDir];
    return this.execute(args, "Refresh Notes", options);
  }

  // ── internals ─────────────────────────────────────────────────────

  private stopProcessTree(child: ChildProcess): void {
    if (process.platform === "win32" && child.pid) {
      // Ensure child process tree is terminated on Windows.
      void spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    child.kill();
  }

  private async execute(
    args: string[],
    title: string,
    options?: RunOptions,
  ): Promise<RunResult> {
    // Pre-flight: verify python is reachable
    if (!(await this.verifyPython())) {
      return { success: false, output: "Python interpreter not found.", exitCode: 1 };
    }

    // Pre-flight: if -s flag present, verify the scenario file exists
    const scenarioIdx = args.indexOf("-s");
    if (scenarioIdx !== -1) {
      const scenarioPath = args[scenarioIdx + 1];
      if (!fs.existsSync(scenarioPath)) {
        const create = await vscode.window.showErrorMessage(
          `Scenario file not found: ${scenarioPath}`,
          "Create from template",
        );
        if (create) {
          await vscode.commands.executeCommand("docs-capacitor.createScenario");
        }
        return { success: false, output: "Scenario file not found.", exitCode: 1 };
      }
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Docs Capacitor: ${title}`,
        cancellable: true,
      },
      (progress, progressToken) => {
        return new Promise<RunResult>((resolve) => {
          const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          const combined = mergeCancellationTokens(progressToken, options?.token);

          this.outputChannel.show(true);
          this.outputChannel.appendLine(`> ${this.pythonPath} ${args.join(" ")}`);

          const child: ChildProcess = spawn(this.pythonPath, args, {
            cwd: this.workspaceRoot,
            env: { ...process.env, ...(this.extraEnv ?? {}) },
          });

          let output = "";

          const onData = (chunk: Buffer): void => {
            const text = chunk.toString();
            output += text;
            this.outputChannel.append(text);

            for (const { re, message } of PROGRESS_PATTERNS) {
              const match = re.exec(text);
              if (match) {
                progress.report({ message: message(match) });
                break;
              }
            }
          };

          child.stdout?.on("data", onData);
          child.stderr?.on("data", onData);

          // Timeout handling
          const timer = setTimeout(() => {
            this.stopProcessTree(child);
            const msg = `Pipeline timed out after ${timeoutMs / 1000}s`;
            this.outputChannel.appendLine(`\n${msg}`);
            resolve({ success: false, output: output + `\n${msg}`, exitCode: 1 });
          }, timeoutMs);

          // Cancellation handling
          const cancelListener = combined.onCancellationRequested(() => {
            this.stopProcessTree(child);
            this.outputChannel.appendLine("\nPipeline cancelled by user.");
            resolve({ success: false, output: output + "\nCancelled.", exitCode: 1 });
          });

          child.on("close", (code) => {
            clearTimeout(timer);
            cancelListener.dispose();
            const exitCode = code ?? 1;
            resolve({ success: exitCode === 0, output, exitCode });
          });

          child.on("error", (err) => {
            clearTimeout(timer);
            cancelListener.dispose();
            this.outputChannel.appendLine(`Process error: ${err.message}`);
            resolve({ success: false, output: err.message, exitCode: 1 });
          });
        });
      },
    );
  }

  /** Returns true if the configured python interpreter is callable. */
  private verifyPython(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.pythonPath, ["--version"]);
      child.on("close", (code) => resolve(code === 0));
      child.on("error", async () => {
        const action = await vscode.window.showErrorMessage(
          `Python interpreter not found at "${this.pythonPath}".`,
          "Configure Python Path",
        );
        if (action) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "docs-capacitor.pythonPath",
          );
        }
        resolve(false);
      });
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────

/** Merge two optional cancellation tokens into one. */
function mergeCancellationTokens(
  a: vscode.CancellationToken,
  b?: vscode.CancellationToken,
): vscode.CancellationToken {
  if (!b) {
    return a;
  }
  const source = new vscode.CancellationTokenSource();
  a.onCancellationRequested(() => source.cancel());
  b.onCancellationRequested(() => source.cancel());
  return source.token;
}
