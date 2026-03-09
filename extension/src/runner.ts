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
  { re: /Collecting from:\s*(.+)/i, message: (m) => `Collecting from: ${m[1]}` },
  { re: /Running detector:\s*(.+)/i, message: (m) => `Running detector: ${m[1]}` },
  { re: /Running strategy:\s*(.+)/i, message: (m) => `Running strategy: ${m[1]}` },
  { re: /Applying rule:\s*(.+)/i, message: (m) => `Applying rule: ${m[1]}` },
  { re: /Writing results/i, message: () => "Writing results…" },
];

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class PipelineRunner {
  private outputChannel: vscode.OutputChannel;

  constructor(
    private readonly pythonPath: string,
    private readonly workspaceRoot: string,
    channel?: vscode.OutputChannel,
  ) {
    this.outputChannel = channel ?? vscode.window.createOutputChannel("Docs Capacitor");
  }

  /** Create a runner that reuses an existing output channel. */
  static withOutputChannel(
    pythonPath: string,
    workspaceRoot: string,
    channel: vscode.OutputChannel,
  ): PipelineRunner {
    return new PipelineRunner(pythonPath, workspaceRoot, channel);
  }

  // ── public API ────────────────────────────────────────────────────

  runCheck(scenarioPath: string, outputDir: string, options?: RunOptions): Promise<RunResult> {
    const args = ["-m", "capacitor", "check", "-s", scenarioPath, "-o", outputDir];
    return this.execute(args, "Freshness Check", options);
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
            child.kill();
            const msg = `Pipeline timed out after ${timeoutMs / 1000}s`;
            this.outputChannel.appendLine(`\n${msg}`);
            resolve({ success: false, output: output + `\n${msg}`, exitCode: 1 });
          }, timeoutMs);

          // Cancellation handling
          const cancelListener = combined.onCancellationRequested(() => {
            child.kill();
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
