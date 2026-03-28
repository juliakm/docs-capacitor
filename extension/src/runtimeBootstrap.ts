import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { spawn } from "child_process";

const INSTALL_MARKER = ".runtime-version";

function runtimePythonPath(venvDir: string): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
): Promise<void> {
  return new Promise((resolve, reject) => {
    output.appendLine(`> ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd, env: process.env });
    child.stdout?.on("data", (d: Buffer) => output.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => output.append(d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`Command failed (${code}): ${cmd} ${args.join(" ")}`)); }
    });
  });
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", () => resolve({ code: null, stdout, stderr }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function sourceStamp(rootDir: string): string {
  let files = 0;
  let newestMs = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "__pycache__" || entry.name === ".pytest_cache") { continue; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      files += 1;
      try {
        const ms = fs.statSync(full).mtimeMs;
        if (ms > newestMs) {
          newestMs = ms;
        }
      } catch {
        // Skip unreadable files.
      }
    }
  }
  return `${files}:${Math.floor(newestMs)}`;
}

async function resolvePythonCommand(
  configuredPython: string,
  cwd: string,
  output: vscode.OutputChannel,
): Promise<string> {
  const configured = configuredPython.trim();
  const candidates = process.platform === "win32"
    ? [configured, "python", "py", "python3"]
    : [configured, "python3", "python"];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) { continue; }
    seen.add(candidate);
    try {
      await run(candidate, ["--version"], cwd, output);
      if (candidate !== configured) {
        output.appendLine(`Using Python interpreter fallback: ${candidate}`);
      }
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Python interpreter not found. Checked: ${candidates.filter(Boolean).join(", ")}`);
}

export async function ensureBundledRuntime(
  context: vscode.ExtensionContext,
  configuredPython: string,
  output: vscode.OutputChannel,
): Promise<string> {
  const bootstrapPython = await resolvePythonCommand(configuredPython, context.extensionPath, output);
  const runtimeRoot = path.join(context.globalStorageUri.fsPath, "python-runtime");
  const venvDir = path.join(runtimeRoot, "venv");
  const py = runtimePythonPath(venvDir);
  const markerPath = path.join(runtimeRoot, INSTALL_MARKER);
  const bundledSrc = path.join(context.extensionPath, "python-src");

  if (!fs.existsSync(bundledSrc) || !fs.existsSync(path.join(bundledSrc, "pyproject.toml"))) {
    output.appendLine("Bundled python sources not found (python-src); using configured Python runtime.");
    return bootstrapPython;
  }

  fs.mkdirSync(runtimeRoot, { recursive: true });
  if (!fs.existsSync(venvDir)) {
    await run(bootstrapPython, ["-m", "venv", venvDir], context.extensionPath, output);
  }

  const expectedVersion = context.extension.packageJSON?.version ?? "dev";
  const expectedMarker = `${expectedVersion}|${sourceStamp(bundledSrc)}`;
  const currentVersion = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf-8").trim() : "";

  let needsInstall = currentVersion !== expectedMarker;
  if (!needsInstall) {
    try {
      await run(py, ["-m", "capacitor", "--help"], context.extensionPath, output);
    } catch {
      needsInstall = true;
    }
  }

  if (needsInstall) {
    await run(py, ["-m", "pip", "install", "--upgrade", "pip"], context.extensionPath, output);
    await run(py, ["-m", "pip", "install", "--upgrade", `${bundledSrc}[llm,learn-auth]`], context.extensionPath, output);
    fs.writeFileSync(markerPath, expectedMarker, "utf-8");
  }

  const runtimeVersion = await runCapture(
    py,
    ["-c", "import capacitor; print(getattr(capacitor, '__version__', 'unknown'))"],
    context.extensionPath,
  );
  if (runtimeVersion.code === 0) {
    output.appendLine(`[runtime] Installed docs-capacitor package version: ${runtimeVersion.stdout.trim()}`);
  } else {
    output.appendLine("[runtime] Could not determine installed docs-capacitor package version.");
  }

  return py;
}
