import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/** Form data collected across all wizard steps. */
interface ScenarioFormData {
  productName: string;
  toolName: string;
  scenarioName: string;
  description: string;
  learnQueries: string[];
  githubOrgs: string[];
  excludedRepos: string[];
  keyFacts: string[];
  enableLlm: boolean;
  productPatterns: string[];
  toolPatterns: string[];
  releaseNotesUrl: string;
  sectionPattern: string;
}

/**
 * Singleton webview panel that walks the user through creating a scenario.
 */
export class ScenarioWizardPanel {
  public static readonly viewType = "docsCapacitor.scenarioWizard";

  private static instance: ScenarioWizardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  /** Show the wizard (reuses existing panel when possible). */
  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ScenarioWizardPanel.instance) {
      ScenarioWizardPanel.instance.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ScenarioWizardPanel.viewType,
      "New Scenario Wizard",
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    ScenarioWizardPanel.instance = new ScenarioWizardPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg: { command: string; data?: ScenarioFormData }) => {
        switch (msg.command) {
          case "save":
            if (msg.data) {
              await this.handleSave(msg.data);
            }
            break;
          case "cancel":
            this.panel.dispose();
            break;
        }
      },
      null,
      this.disposables,
    );
  }

  private dispose(): void {
    ScenarioWizardPanel.instance = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
  }

  // ── save handler ──────────────────────────────────────────────────────

  private async handleSave(data: ScenarioFormData): Promise<void> {
    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Choose folder for scenario",
      title: "Save scenario to…",
    });

    if (!folder || folder.length === 0) {
      return;
    }

    const dirName = data.scenarioName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const scenarioDir = path.join(folder[0].fsPath, dirName);

    try {
      if (!fs.existsSync(scenarioDir)) {
        fs.mkdirSync(scenarioDir, { recursive: true });
      }

      const scenarioYaml = generateScenarioYaml(data);
      const rulesYaml = generateRulesYaml(data);
      const strategyYaml = generateStrategyYaml(data);

      const scenarioFile = path.join(scenarioDir, "scenario.yaml");
      fs.writeFileSync(scenarioFile, scenarioYaml, "utf-8");
      fs.writeFileSync(path.join(scenarioDir, "rules.yaml"), rulesYaml, "utf-8");
      fs.writeFileSync(path.join(scenarioDir, "strategy.yaml"), strategyYaml, "utf-8");

      vscode.window.showInformationMessage(`Scenario saved to ${scenarioDir}`);

      const doc = await vscode.workspace.openTextDocument(scenarioFile);
      await vscode.window.showTextDocument(doc);

      const runValidation = await vscode.window.showInformationMessage(
        "Run validation on the new scenario?",
        "Validate",
        "Skip",
      );
      if (runValidation === "Validate") {
        await vscode.commands.executeCommand("docs-capacitor.validate");
      }

      this.panel.dispose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to save scenario: ${message}`);
    }
  }

  // ── HTML ──────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Scenario Wizard</title>
  <style nonce="${nonce}">
    :root { font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    body { padding: 0 20px 20px; margin: 0; }
    h2 { margin-top: 0; }

    /* step indicator */
    .step-bar { display: flex; gap: 6px; margin-bottom: 16px; align-items: center; }
    .step-dot {
      width: 28px; height: 28px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; font-size: 13px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      opacity: 0.4;
    }
    .step-dot.active { opacity: 1; outline: 2px solid var(--vscode-focusBorder); }
    .step-dot.done { opacity: 0.7; }
    .step-line { flex: 1; height: 2px; background: var(--vscode-widget-border, #555); }

    /* form elements */
    label { display: block; margin-top: 12px; font-weight: 600; }
    .hint { font-size: 12px; opacity: 0.7; margin-top: 2px; }
    input[type="text"], textarea {
      width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
      font-family: var(--vscode-font-family); font-size: 13px;
    }
    textarea { resize: vertical; min-height: 80px; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .checkbox-row input[type="checkbox"] { margin: 0; }

    .error { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 2px; display: none; }

    /* buttons */
    .btn-row { display: flex; gap: 8px; margin-top: 20px; }
    button {
      padding: 6px 16px; border: none; border-radius: 3px; cursor: pointer;
      font-size: 13px; font-family: var(--vscode-font-family);
    }
    .btn-primary {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* preview */
    pre.yaml-preview {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px; border-radius: 4px; overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      white-space: pre; tab-size: 2; line-height: 1.5;
    }
    .yaml-key { color: var(--vscode-symbolIcon-fieldForeground, #9cdcfe); }
    .yaml-str { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .yaml-comment { color: var(--vscode-descriptionForeground, #6a9955); }
    .yaml-bool { color: var(--vscode-symbolIcon-booleanForeground, #569cd6); }

    .step { display: none; }
    .step.active { display: block; }
  </style>
</head>
<body>

<!-- Step indicator -->
<div class="step-bar" id="stepBar"></div>

<!-- Step 1: Basics -->
<div class="step" data-step="1">
  <h2>Step 1 — Basics</h2>
  <label for="productName">Product name <span style="color:var(--vscode-errorForeground)">*</span></label>
  <input type="text" id="productName" placeholder="e.g. Azure Kubernetes Service" />
  <div class="error" id="productNameError">Product name is required.</div>

  <label for="toolName">Tool / CLI name <span class="hint">(optional)</span></label>
  <input type="text" id="toolName" placeholder="e.g. kubectl" />

  <label for="scenarioName">Scenario name <span style="color:var(--vscode-errorForeground)">*</span></label>
  <input type="text" id="scenarioName" placeholder="e.g. aks-api-version" />
  <div class="error" id="scenarioNameError">Scenario name is required.</div>

  <label for="description">Description</label>
  <textarea id="description" rows="3" placeholder="What does this scenario check?"></textarea>
</div>

<!-- Step 2: Search -->
<div class="step" data-step="2">
  <h2>Step 2 — Search Sources</h2>
  <label for="learnQueries">Microsoft Learn API queries <span style="color:var(--vscode-errorForeground)">*</span></label>
  <div class="hint">One query path per line, e.g. /azure/aks</div>
  <textarea id="learnQueries" rows="4" placeholder="/azure/aks&#10;/azure/aks/concepts"></textarea>
  <div class="error" id="learnQueriesError">At least one search query is required.</div>

  <label for="githubOrgs">GitHub organizations</label>
  <div class="hint">One org per line</div>
  <textarea id="githubOrgs" rows="3" placeholder="Azure&#10;microsoft"></textarea>

  <label for="excludedRepos">Excluded repositories</label>
  <div class="hint">One repo per line (org/repo)</div>
  <textarea id="excludedRepos" rows="3" placeholder="Azure/azure-docs-archive"></textarea>
</div>

<!-- Step 3: Detection -->
<div class="step" data-step="3">
  <h2>Step 3 — Detection</h2>
  <label for="keyFacts">Key facts to detect</label>
  <div class="hint">One fact per line — API versions, SDK versions, etc.</div>
  <textarea id="keyFacts" rows="5" placeholder="2024-01-01&#10;v5.0.0"></textarea>

  <div class="checkbox-row">
    <input type="checkbox" id="enableLlm" />
    <label for="enableLlm" style="margin:0;font-weight:normal">Enable LLM-assisted detection</label>
  </div>
</div>

<!-- Step 4: Classification -->
<div class="step" data-step="4">
  <h2>Step 4 — Classification Patterns</h2>
  <label for="productPatterns">Product version patterns</label>
  <div class="hint">Regex patterns, one per line — e.g. v\\d+\\.\\d+\\.\\d+</div>
  <textarea id="productPatterns" rows="4" placeholder="\\d{4}-\\d{2}-\\d{2}&#10;v\\d+\\.\\d+"></textarea>

  <label for="toolPatterns">Tool / CLI version patterns</label>
  <div class="hint">Regex patterns, one per line</div>
  <textarea id="toolPatterns" rows="4" placeholder="\\d+\\.\\d+\\.\\d+"></textarea>
</div>

<!-- Step 5: Release Notes -->
<div class="step" data-step="5">
  <h2>Step 5 — Release Notes</h2>
  <label for="releaseNotesUrl">Release notes URL</label>
  <input type="text" id="releaseNotesUrl" placeholder="https://learn.microsoft.com/azure/aks/release-notes" />

  <label for="sectionPattern">Section heading pattern</label>
  <div class="hint">Regex to match release-note section headings</div>
  <input type="text" id="sectionPattern" placeholder="## \\d{4}-\\d{2}-\\d{2}" />
</div>

<!-- Step 6: Preview & Save -->
<div class="step" data-step="6">
  <h2>Step 6 — Preview &amp; Save</h2>
  <p>Review the generated files below. Click <strong>Save Scenario</strong> to write them to disk.</p>

  <h3>scenario.yaml</h3>
  <pre class="yaml-preview" id="previewScenario"></pre>

  <h3>rules.yaml</h3>
  <pre class="yaml-preview" id="previewRules"></pre>

  <h3>strategy.yaml</h3>
  <pre class="yaml-preview" id="previewStrategy"></pre>
</div>

<!-- Navigation -->
<div class="btn-row">
  <button class="btn-secondary" id="btnBack" style="display:none">← Back</button>
  <button class="btn-primary" id="btnNext">Next →</button>
  <button class="btn-primary" id="btnSave" style="display:none">Save Scenario</button>
  <button class="btn-secondary" id="btnCancel">Cancel</button>
</div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const TOTAL_STEPS = 6;
  let current = 1;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  // ── step navigation ────────────────────────────────────────────────
  function renderStepBar() {
    const bar = $('#stepBar');
    bar.innerHTML = '';
    for (let i = 1; i <= TOTAL_STEPS; i++) {
      if (i > 1) {
        const line = document.createElement('div');
        line.className = 'step-line';
        bar.appendChild(line);
      }
      const dot = document.createElement('div');
      dot.className = 'step-dot' + (i === current ? ' active' : '') + (i < current ? ' done' : '');
      dot.textContent = String(i);
      bar.appendChild(dot);
    }
  }

  function showStep(n) {
    current = n;
    $$('.step').forEach(s => s.classList.toggle('active', Number(s.dataset.step) === n));
    $('#btnBack').style.display = n > 1 ? '' : 'none';
    $('#btnNext').style.display = n < TOTAL_STEPS ? '' : 'none';
    $('#btnSave').style.display = n === TOTAL_STEPS ? '' : 'none';
    renderStepBar();
    if (n === TOTAL_STEPS) { renderPreview(); }
  }

  // ── validation ─────────────────────────────────────────────────────
  function validate(step) {
    hideErrors();
    if (step === 1) {
      let ok = true;
      if (!$('#productName').value.trim()) { showError('productNameError'); ok = false; }
      if (!$('#scenarioName').value.trim()) { showError('scenarioNameError'); ok = false; }
      return ok;
    }
    if (step === 2) {
      if (!$('#learnQueries').value.trim()) { showError('learnQueriesError'); return false; }
      return true;
    }
    return true;
  }
  function showError(id) { const el = $('#' + id); if (el) el.style.display = 'block'; }
  function hideErrors() { $$('.error').forEach(e => e.style.display = 'none'); }

  // ── collect data ───────────────────────────────────────────────────
  function lines(id) { return ($('#' + id).value || '').split('\\n').map(l => l.trim()).filter(Boolean); }

  function collectData() {
    return {
      productName: $('#productName').value.trim(),
      toolName: $('#toolName').value.trim(),
      scenarioName: $('#scenarioName').value.trim(),
      description: $('#description').value.trim(),
      learnQueries: lines('learnQueries'),
      githubOrgs: lines('githubOrgs'),
      excludedRepos: lines('excludedRepos'),
      keyFacts: lines('keyFacts'),
      enableLlm: $('#enableLlm').checked,
      productPatterns: lines('productPatterns'),
      toolPatterns: lines('toolPatterns'),
      releaseNotesUrl: $('#releaseNotesUrl').value.trim(),
      sectionPattern: $('#sectionPattern').value.trim(),
    };
  }

  // ── YAML helpers (client-side preview) ─────────────────────────────
  function yamlList(items, indent) {
    if (!items.length) return indent + '[]\\n';
    return items.map(i => indent + '- ' + quoteYaml(i)).join('\\n') + '\\n';
  }
  function quoteYaml(s) {
    if (/[:#{}\\[\\],&*?|>!'"%@]/.test(s) || /^\\s|\\s$/.test(s)) return '"' + s.replace(/"/g, '\\\\"') + '"';
    return s;
  }

  function buildScenarioYaml(d) {
    let y = '';
    y += 'name: ' + quoteYaml(d.scenarioName) + '\\n';
    if (d.description) y += 'description: ' + quoteYaml(d.description) + '\\n';
    y += 'product: ' + quoteYaml(d.productName) + '\\n';
    if (d.toolName) y += 'tool: ' + quoteYaml(d.toolName) + '\\n';
    y += '\\n# Search sources\\n';
    y += 'sources:\\n';
    if (d.learnQueries.length) {
      y += '  - type: learn\\n';
      y += '    queries:\\n';
      y += yamlList(d.learnQueries, '      ');
    }
    if (d.githubOrgs.length) {
      y += '  - type: github\\n';
      y += '    orgs:\\n';
      y += yamlList(d.githubOrgs, '      ');
      if (d.excludedRepos.length) {
        y += '    excluded_repos:\\n';
        y += yamlList(d.excludedRepos, '      ');
      }
    }
    if (d.releaseNotesUrl) {
      y += '  - type: release_notes\\n';
      y += '    url: ' + quoteYaml(d.releaseNotesUrl) + '\\n';
      if (d.sectionPattern) y += '    section_pattern: ' + quoteYaml(d.sectionPattern) + '\\n';
    }
    y += '\\n# Detection\\n';
    if (d.keyFacts.length) {
      y += 'key_facts:\\n';
      y += yamlList(d.keyFacts, '  ');
    }
    y += 'enable_llm: ' + d.enableLlm + '\\n';
    y += '\\n# Classification & rules\\n';
    y += 'strategies:\\n  - name: default\\n';
    y += 'rules:\\n  - name: default\\n';
    return y;
  }

  function buildRulesYaml(d) {
    let y = '# Rules for ' + d.scenarioName + '\\n';
    y += 'rules:\\n';
    y += '  - name: default\\n';
    y += '    description: Default classification rule\\n';
    if (d.productPatterns.length) {
      y += '    product_patterns:\\n';
      y += yamlList(d.productPatterns, '      ');
    }
    if (d.toolPatterns.length) {
      y += '    tool_patterns:\\n';
      y += yamlList(d.toolPatterns, '      ');
    }
    return y;
  }

  function buildStrategyYaml(d) {
    let y = '# Strategy for ' + d.scenarioName + '\\n';
    y += 'strategies:\\n';
    y += '  - name: default\\n';
    y += '    description: Default detection strategy\\n';
    if (d.keyFacts.length) {
      y += '    key_facts:\\n';
      y += yamlList(d.keyFacts, '      ');
    }
    y += '    enable_llm: ' + d.enableLlm + '\\n';
    return y;
  }

  // ── syntax highlight (very light) ─────────────────────────────────
  function highlight(yaml) {
    return yaml
      .replace(/^(\\s*#.*)$/gm,  '<span class="yaml-comment">$1</span>')
      .replace(/^(\\s*[\\w_-]+):/gm, '<span class="yaml-key">$1</span>:')
      .replace(/:\\s+(true|false)$/gm, ': <span class="yaml-bool">$1</span>')
      .replace(/:\\s+(".*?")$/gm, ': <span class="yaml-str">$1</span>');
  }

  function renderPreview() {
    const d = collectData();
    $('#previewScenario').innerHTML = highlight(buildScenarioYaml(d));
    $('#previewRules').innerHTML = highlight(buildRulesYaml(d));
    $('#previewStrategy').innerHTML = highlight(buildStrategyYaml(d));
  }

  // ── button handlers ────────────────────────────────────────────────
  $('#btnNext').addEventListener('click', () => {
    if (!validate(current)) return;
    showStep(current + 1);
  });
  $('#btnBack').addEventListener('click', () => showStep(current - 1));
  $('#btnSave').addEventListener('click', () => vscode.postMessage({ command: 'save', data: collectData() }));
  $('#btnCancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));

  // init
  showStep(1);
})();
</script>
</body>
</html>`;
  }
}

// ── YAML generators (server-side, used when saving) ─────────────────────────

function yamlList(items: string[], indent: string): string {
  if (!items.length) {
    return `${indent}[]\n`;
  }
  return items.map((i) => `${indent}- ${quoteYaml(i)}`).join("\n") + "\n";
}

function quoteYaml(s: string): string {
  if (/[:#{}[\],&*?|>!'"%@]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

export function generateScenarioYaml(d: ScenarioFormData): string {
  let y = "";
  y += `name: ${quoteYaml(d.scenarioName)}\n`;
  if (d.description) {
    y += `description: ${quoteYaml(d.description)}\n`;
  }
  y += `product: ${quoteYaml(d.productName)}\n`;
  if (d.toolName) {
    y += `tool: ${quoteYaml(d.toolName)}\n`;
  }

  y += "\n# Search sources\n";
  y += "sources:\n";
  if (d.learnQueries.length) {
    y += "  - type: learn\n";
    y += "    queries:\n";
    y += yamlList(d.learnQueries, "      ");
  }
  if (d.githubOrgs.length) {
    y += "  - type: github\n";
    y += "    orgs:\n";
    y += yamlList(d.githubOrgs, "      ");
    if (d.excludedRepos.length) {
      y += "    excluded_repos:\n";
      y += yamlList(d.excludedRepos, "      ");
    }
  }
  if (d.releaseNotesUrl) {
    y += "  - type: release_notes\n";
    y += `    url: ${quoteYaml(d.releaseNotesUrl)}\n`;
    if (d.sectionPattern) {
      y += `    section_pattern: ${quoteYaml(d.sectionPattern)}\n`;
    }
  }

  y += "\n# Detection\n";
  if (d.keyFacts.length) {
    y += "key_facts:\n";
    y += yamlList(d.keyFacts, "  ");
  }
  y += `enable_llm: ${d.enableLlm}\n`;

  y += "\n# Classification & rules\n";
  y += "strategies:\n  - name: default\n";
  y += "rules:\n  - name: default\n";
  return y;
}

export function generateRulesYaml(d: ScenarioFormData): string {
  let y = `# Rules for ${d.scenarioName}\n`;
  y += "rules:\n";
  y += "  - name: default\n";
  y += "    description: Default classification rule\n";
  if (d.productPatterns.length) {
    y += "    product_patterns:\n";
    y += yamlList(d.productPatterns, "      ");
  }
  if (d.toolPatterns.length) {
    y += "    tool_patterns:\n";
    y += yamlList(d.toolPatterns, "      ");
  }
  return y;
}

export function generateStrategyYaml(d: ScenarioFormData): string {
  let y = `# Strategy for ${d.scenarioName}\n`;
  y += "strategies:\n";
  y += "  - name: default\n";
  y += "    description: Default detection strategy\n";
  if (d.keyFacts.length) {
    y += "    key_facts:\n";
    y += yamlList(d.keyFacts, "      ");
  }
  y += `    enable_llm: ${d.enableLlm}\n`;
  return y;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
