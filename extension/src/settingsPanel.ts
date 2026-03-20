import * as vscode from "vscode";

/** Matches CheckResult from setupChecker.ts. */
export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

/**
 * Singleton webview panel for configuring authentication and environment
 * settings (GitHub auth, GitHub Models, Python path, timeouts, etc.).
 */
export class SettingsPanel {
  public static readonly viewType = "docsCapacitor.settingsPanel";

  private static instance: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  /** Optional callback for messages — allows extension.ts to handle them. */
  public static onMessage?: (msg: Record<string, unknown>) => void;

  /** Show the settings panel (reuses existing panel when possible). */
  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (SettingsPanel.instance) {
      SettingsPanel.instance.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      "Docs Capacitor Settings",
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    SettingsPanel.instance = new SettingsPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg: {
        command: string;
        user?: string;
        pythonPath?: string;
        timeoutMs?: number;
        scenarioPaths?: string[];
      }) => {
        // Delegate to external handler if wired
        if (SettingsPanel.onMessage && msg.command !== "ready") {
          SettingsPanel.onMessage(msg as Record<string, unknown>);
          return;
        }
        switch (msg.command) {
          case "ready":
            await this.handleReady();
            break;
          case "checkStatus":
            await this.handleCheckStatus();
            break;
          case "switchGitHubAccount":
            this.openTerminalWithCommand("gh auth login");
            break;
          case "addModelsAccount":
            this.openTerminalWithCommand("gh auth login");
            break;
          case "saveModelsUser":
            if (msg.user !== undefined) {
              await this.handleSaveModelsUser(msg.user);
            }
            break;
          case "testModelsConnection":
            await this.handleTestModelsConnection();
            break;
          case "saveSettings":
            if (msg.pythonPath !== undefined && msg.timeoutMs !== undefined && msg.scenarioPaths !== undefined) {
              await this.handleSaveSettings(msg.pythonPath, msg.timeoutMs, msg.scenarioPaths);
            }
            break;
        }
      },
      null,
      this.disposables,
    );
  }

  private dispose(): void {
    SettingsPanel.instance = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
  }

  // ── message handlers (stubs — real check logic wired in extension.ts) ─

  private async handleReady(): Promise<void> {
    const config = vscode.workspace.getConfiguration("docs-capacitor");
    const pythonPath = config.get<string>("pythonPath", "python3");
    const timeoutMs = config.get<number>("timeoutMs", 300_000);
    const scenarioPaths = config.get<string[]>("scenarioPaths", []);
    const modelsUser = process.env["GITHUB_MODELS_USER"] ?? "";

    this.panel.webview.postMessage({
      command: "setState",
      status: [] as CheckResult[],
      modelsUser,
      pythonPath,
      timeoutMs,
      scenarioPaths,
    });
  }

  private async handleCheckStatus(): Promise<void> {
    this.panel.webview.postMessage({
      command: "updateStatus",
      status: [] as CheckResult[],
    });
  }

  private openTerminalWithCommand(cmd: string): void {
    const terminal = vscode.window.createTerminal("Docs Capacitor Auth");
    terminal.show();
    terminal.sendText(cmd);
  }

  private async handleSaveModelsUser(user: string): Promise<void> {
    // Stub — extension.ts should write to .env file
    vscode.window.showInformationMessage(`GITHUB_MODELS_USER set to "${user}".`);
  }

  private async handleTestModelsConnection(): Promise<void> {
    // Stub — extension.ts should run `gh auth token -u <user>`
    this.panel.webview.postMessage({
      command: "testResult",
      success: false,
      message: "Test not yet wired — connect in extension.ts",
    });
  }

  private async handleSaveSettings(pythonPath: string, timeoutMs: number, scenarioPaths: string[]): Promise<void> {
    const config = vscode.workspace.getConfiguration("docs-capacitor");
    await config.update("pythonPath", pythonPath, vscode.ConfigurationTarget.Global);
    await config.update("timeoutMs", timeoutMs, vscode.ConfigurationTarget.Global);
    await config.update("scenarioPaths", scenarioPaths, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Settings saved.");
  }

  // ── public helpers for extension.ts to push state into the panel ──────

  /** Send full state (called after real checks complete). */
  public static postState(
    status: CheckResult[],
    modelsUser: string,
    pythonPath: string,
    timeoutMs: number,
    scenarioPaths: string[],
  ): void {
    SettingsPanel.instance?.panel.webview.postMessage({ command: "setState", status, modelsUser, pythonPath, timeoutMs, scenarioPaths });
  }

  /** Send updated check results after a re-check. */
  public static postStatusUpdate(status: CheckResult[]): void {
    SettingsPanel.instance?.panel.webview.postMessage({ command: "updateStatus", status });
  }

  /** Send the result of a models-connection test. */
  public static postTestResult(success: boolean, message: string): void {
    SettingsPanel.instance?.panel.webview.postMessage({ command: "testResult", success, message });
  }

  // ── HTML ──────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = getNonce();
    const config = vscode.workspace.getConfiguration("docs-capacitor");
    const initData = JSON.stringify({
      modelsUser: process.env["GITHUB_MODELS_USER"] ?? "",
      pythonPath: config.get<string>("pythonPath", "python3"),
      timeoutMs: config.get<number>("timeoutMs", 1800000),
      scenarioPaths: config.get<string[]>("scenarioPaths", []),
    });

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Docs Capacitor Settings</title>
  <style nonce="${nonce}">
    :root { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); }
    * { box-sizing: border-box; }
    body { padding: 0 20px 20px; margin: 0; background: var(--vscode-editor-background); }
    h1 { font-size: 1.4em; margin: 16px 0 8px; }
    h2 { font-size: 1.1em; margin: 16px 0 8px; border-bottom: 1px solid var(--vscode-widget-border, #444); padding-bottom: 4px; }

    /* ── status cards row ─────────────────────────────────── */
    .status-row {
      display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0;
    }
    .status-card {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px; border-radius: 6px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, #444);
      min-width: 150px;
    }
    .status-card .name { font-weight: 600; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 0.78em; font-weight: 600; color: #fff;
    }
    .badge.pass { background: #4caf50; }
    .badge.fail { background: #f44336; }
    .badge.unknown { background: #888; }

    /* ── section cards ────────────────────────────────────── */
    .card {
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 6px; padding: 16px; margin-bottom: 16px;
    }
    .card p { margin: 4px 0; font-size: 0.92em; line-height: 1.5; }
    .card .detail { color: var(--vscode-descriptionForeground, #aaa); font-size: 0.85em; }

    /* ── form controls ────────────────────────────────────── */
    label { display: block; margin-top: 10px; font-weight: 600; font-size: 0.9em; }
    input[type="text"], input[type="number"] {
      width: 100%; max-width: 420px; padding: 6px 8px; margin-top: 4px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555); border-radius: 4px;
      font-family: var(--vscode-font-family); font-size: 0.9em;
    }
    input:focus { outline: 1px solid var(--vscode-focusBorder); }

    button {
      padding: 6px 14px; margin-top: 8px; margin-right: 6px; border: none; border-radius: 4px;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      cursor: pointer; font-size: 0.88em; font-weight: 500;
    }
    button:hover { opacity: 0.9; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, #3a3a3a);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }

    /* ── scenario paths list ──────────────────────────────── */
    .path-list { list-style: none; padding: 0; margin: 6px 0; }
    .path-list li {
      display: flex; align-items: center; gap: 6px; padding: 4px 0;
      font-size: 0.9em; font-family: var(--vscode-editor-font-family, monospace);
    }
    .path-list li button { margin: 0; padding: 2px 8px; font-size: 0.8em; }

    .add-path-row { display: flex; gap: 6px; margin-top: 6px; }
    .add-path-row input { flex: 1; }
    .add-path-row button { margin-top: 0; }

    /* ── test result banner ───────────────────────────────── */
    .test-banner {
      padding: 8px 12px; border-radius: 4px; margin-top: 10px; font-size: 0.9em; display: none;
    }
    .test-banner.success { background: rgba(76,175,80,0.15); border: 1px solid #4caf50; }
    .test-banner.error   { background: rgba(244,67,54,0.15); border: 1px solid #f44336; }
  </style>
</head>
<body>

<h1>⚙️ Docs Capacitor Settings</h1>

<!-- ── Status Summary ────────────────────────────────────── -->
<div class="status-row" id="statusRow">
  <div class="status-card"><span class="name">Python</span> <span class="badge unknown" id="badge-Python">…</span></div>
  <div class="status-card"><span class="name">GitHub CLI</span> <span class="badge unknown" id="badge-GitHub CLI">…</span></div>
  <div class="status-card"><span class="name">GitHub Auth</span> <span class="badge unknown" id="badge-GitHub auth">…</span></div>
  <div class="status-card"><span class="name">Models Auth</span> <span class="badge unknown" id="badge-Models auth">…</span></div>
</div>

<!-- ── GitHub (Git Operations) ───────────────────────────── -->
<div class="card">
  <h2>GitHub (Git Operations)</h2>
  <p id="ghStatusText" class="detail">Checking…</p>
  <button id="btnCheckStatus" class="secondary">Check Status</button>
  <button id="btnSwitchAccount">Switch Account</button>
</div>

<!-- ── GitHub Models (LLM) ───────────────────────────────── -->
<div class="card">
  <h2>GitHub Models (LLM)</h2>
  <p id="modelsStatusText" class="detail">Checking…</p>
  <label for="modelsUserInput">GITHUB_MODELS_USER</label>
  <input type="text" id="modelsUserInput" placeholder="e.g. my-github-user" />
  <div style="margin-top:8px">
    <button id="btnSaveModelsUser">Save</button>
    <button id="btnAddModelsAccount" class="secondary">Add Account</button>
    <button id="btnTestConnection" class="secondary">Test Connection</button>
  </div>
  <div class="test-banner" id="testBanner"></div>
</div>

<!-- ── Environment ───────────────────────────────────────── -->
<div class="card">
  <h2>Environment</h2>

  <label for="pythonPathInput">Python Path</label>
  <input type="text" id="pythonPathInput" placeholder="python3" />

  <label for="timeoutInput">Timeout (ms)</label>
  <input type="number" id="timeoutInput" placeholder="300000" min="1000" step="1000" />

  <label>Scenario Paths</label>
  <ul class="path-list" id="scenarioPathsList"></ul>
  <div class="add-path-row">
    <input type="text" id="newPathInput" placeholder="/path/to/scenarios" />
    <button id="btnAddPath" class="secondary">Add</button>
  </div>

  <div style="margin-top:12px">
    <button id="btnSaveSettings">Save Settings</button>
  </div>
</div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();

  // ── state ──────────────────────────────────────────────
  let scenarioPaths = [];

  // ── elements ───────────────────────────────────────────
  const ghStatusText       = document.getElementById("ghStatusText");
  const modelsStatusText   = document.getElementById("modelsStatusText");
  const modelsUserInput    = document.getElementById("modelsUserInput");
  const pythonPathInput    = document.getElementById("pythonPathInput");
  const timeoutInput       = document.getElementById("timeoutInput");
  const scenarioPathsList  = document.getElementById("scenarioPathsList");
  const newPathInput       = document.getElementById("newPathInput");
  const testBanner         = document.getElementById("testBanner");

  // ── helpers ────────────────────────────────────────────
  function updateBadge(id, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = "badge " + (ok === true ? "pass" : ok === false ? "fail" : "unknown");
    el.textContent = ok === true ? "✅" : ok === false ? "❌" : "…";
  }

  function applyStatusChecks(checks) {
    // Map check names to badge element IDs
    const mapping = {
      "Python":           "badge-Python",
      "GitHub CLI":       "badge-GitHub CLI",
      "GitHub auth":      "badge-GitHub auth",
      "Models auth":      "badge-Models auth",
    };

    // Reset all to unknown first if checks are empty
    if (!checks || checks.length === 0) {
      for (const id of Object.values(mapping)) {
        updateBadge(id, null);
      }
      return;
    }

    for (const c of checks) {
      const badgeId = mapping[c.name];
      if (badgeId) {
        updateBadge(badgeId, c.ok);
      }
    }

    // Update detail text for GitHub section
    const ghAuth = checks.find(function (c) { return c.name === "GitHub auth"; });
    if (ghAuth) {
      ghStatusText.textContent = ghAuth.message;
    }

    // Update detail text for Models section
    const modelsAuth = checks.find(function (c) { return c.name === "Models auth"; });
    if (modelsAuth) {
      modelsStatusText.textContent = modelsAuth.message;
    }
  }

  function renderScenarioPaths() {
    scenarioPathsList.innerHTML = "";
    scenarioPaths.forEach(function (p, i) {
      const li = document.createElement("li");
      li.textContent = p + " ";
      const btn = document.createElement("button");
      btn.textContent = "Remove";
      btn.className = "secondary";
      btn.addEventListener("click", function () {
        scenarioPaths.splice(i, 1);
        renderScenarioPaths();
      });
      li.appendChild(btn);
      scenarioPathsList.appendChild(li);
    });
  }

  // ── incoming messages from extension ───────────────────
  window.addEventListener("message", function (event) {
    const msg = event.data;
    switch (msg.command) {
      case "setState":
        applyStatusChecks(msg.status);
        modelsUserInput.value = msg.modelsUser || "";
        pythonPathInput.value = msg.pythonPath || "python3";
        timeoutInput.value    = String(msg.timeoutMs || 300000);
        scenarioPaths = msg.scenarioPaths ? msg.scenarioPaths.slice() : [];
        renderScenarioPaths();
        break;

      case "updateStatus":
        applyStatusChecks(msg.status);
        break;

      case "testResult":
        testBanner.style.display = "block";
        testBanner.className = "test-banner " + (msg.success ? "success" : "error");
        testBanner.textContent = msg.message || (msg.success ? "Connection OK" : "Connection failed");
        break;
    }
  });

  // ── buttons → messages to extension ────────────────────
  document.getElementById("btnCheckStatus").addEventListener("click", function () {
    vscode.postMessage({ command: "checkStatus" });
  });

  document.getElementById("btnSwitchAccount").addEventListener("click", function () {
    vscode.postMessage({ command: "switchGitHubAccount" });
  });

  document.getElementById("btnSaveModelsUser").addEventListener("click", function () {
    vscode.postMessage({ command: "saveModelsUser", user: modelsUserInput.value.trim() });
  });

  document.getElementById("btnAddModelsAccount").addEventListener("click", function () {
    vscode.postMessage({ command: "addModelsAccount" });
  });

  document.getElementById("btnTestConnection").addEventListener("click", function () {
    testBanner.style.display = "none";
    vscode.postMessage({ command: "testModelsConnection" });
  });

  document.getElementById("btnAddPath").addEventListener("click", function () {
    var val = newPathInput.value.trim();
    if (val) {
      scenarioPaths.push(val);
      newPathInput.value = "";
      renderScenarioPaths();
    }
  });

  document.getElementById("btnSaveSettings").addEventListener("click", function () {
    vscode.postMessage({
      command: "saveSettings",
      pythonPath: pythonPathInput.value.trim(),
      timeoutMs: parseInt(timeoutInput.value, 10) || 300000,
      scenarioPaths: scenarioPaths.slice(),
    });
  });

  // ── set initial values from embedded data ───────────────
  (function initFromEmbedded() {
    var d = JSON.parse(decodeURIComponent("${encodeURIComponent(initData)}"));
    modelsUserInput.value = d.modelsUser || "";
    pythonPathInput.value = d.pythonPath || "python3";
    timeoutInput.value = String(d.timeoutMs || 1800000);
    scenarioPaths = d.scenarioPaths ? d.scenarioPaths.slice() : [];
    renderScenarioPaths();
  })();
  vscode.postMessage({ command: "ready" });
})();
</script>
</body>
</html>`;
  }
}

// ── utility ────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
