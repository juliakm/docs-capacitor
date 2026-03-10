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
  learnPathScopes: string[];
  learnExcludeUrlPatterns: string[];
  githubOrgs: string[];
  githubQueries: string[];
  excludedRepos: string[];
  relevantUrls: string[];
  skipUrls: string[];
  keyFacts: string[];
  enableLlm: boolean;
  productPatterns: string[];
  toolPatterns: string[];
  releaseNotesUrl: string;
  sectionPattern: string;
  reportTitle: string;
  reportFormats: string[];
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
    // Default to scenarios/ in the workspace root, creating it if needed
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let defaultDir: string | undefined;
    if (wsRoot) {
      defaultDir = path.join(wsRoot, "scenarios");
      if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
    }

    // Offer quick save to workspace scenarios/ or custom location
    const saveChoice = await vscode.window.showQuickPick(
      [
        { label: "$(folder) Save to workspace scenarios/", description: defaultDir ?? "", value: "workspace" },
        { label: "$(folder-opened) Choose another location…", description: "", value: "browse" },
      ],
      { placeHolder: "Where should the scenario be saved?" },
    );

    if (!saveChoice) { return; }

    let targetDir: string | undefined;
    if (saveChoice.value === "workspace" && defaultDir) {
      targetDir = defaultDir;
    } else {
      const folder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Choose folder for scenario",
        title: "Save scenario to…",
        defaultUri: defaultDir ? vscode.Uri.file(defaultDir) : undefined,
      });
      if (!folder || folder.length === 0) { return; }
      targetDir = folder[0].fsPath;
    }

    const dirName = data.scenarioName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const scenarioDir = path.join(targetDir, dirName);

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

      // Create prompt template directory and default template if LLM is enabled
      if (data.enableLlm) {
        const promptsDir = path.join(scenarioDir, "prompts");
        if (!fs.existsSync(promptsDir)) {
          fs.mkdirSync(promptsDir, { recursive: true });
        }
        const templatePath = path.join(promptsDir, "detect.md.j2");
        if (!fs.existsSync(templatePath)) {
          fs.writeFileSync(templatePath, generatePromptTemplate(), "utf-8");
        }
      }

      vscode.window.showInformationMessage(`Scenario saved to ${scenarioDir}`);

      const doc = await vscode.workspace.openTextDocument(scenarioFile);
      await vscode.window.showTextDocument(doc);

      const runValidation = await vscode.window.showInformationMessage(
        "Run validation on the new scenario?",
        "Validate",
        "Skip",
      );
      if (runValidation === "Validate") {
        await vscode.commands.executeCommand("docs-capacitor.validate", scenarioFile);
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

    /* collapsible sections */
    details { margin-top: 12px; }
    details summary { cursor: pointer; font-weight: 600; font-size: 13px; }

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
  <p class="hint">Define the product whose documentation you want to check for freshness.</p>

  <label for="productName">Product name <span style="color:var(--vscode-errorForeground)">*</span></label>
  <div class="hint">The product or service whose docs may be outdated.</div>
  <input type="text" id="productName" placeholder="e.g. Azure Kubernetes Service, GitHub Copilot" />
  <div class="error" id="productNameError">Product name is required.</div>

  <label for="toolName">Tool / IDE name <span class="hint">(optional)</span></label>
  <div class="hint">If the product is used within a specific tool or IDE, specify it here.</div>
  <input type="text" id="toolName" placeholder="e.g. Visual Studio, VS Code, kubectl" />

  <label for="scenarioName">Scenario name <span style="color:var(--vscode-errorForeground)">*</span></label>
  <div class="hint">A short slug for this check scenario (used as folder name).</div>
  <input type="text" id="scenarioName" placeholder="e.g. aks-api-version, copilot-vs-install" />
  <div class="error" id="scenarioNameError">Scenario name is required.</div>

  <label for="description">Description</label>
  <textarea id="description" rows="3" placeholder="What outdated content are you looking for? e.g. Find articles that still reference the old Marketplace install path for Copilot in Visual Studio."></textarea>
</div>

<!-- Step 2: Search Sources -->
<div class="step" data-step="2">
  <h2>Step 2 — Search Sources</h2>
  <p class="hint">Configure where to search for documentation pages to check.</p>

  <label for="learnQueries">Microsoft Learn search queries <span style="color:var(--vscode-errorForeground)">*</span></label>
  <div class="hint">Search terms to find relevant articles on learn.microsoft.com. One per line.</div>
  <textarea id="learnQueries" rows="3" placeholder="GitHub Copilot Visual Studio&#10;Copilot install getting started&#10;az aks create"></textarea>
  <div class="error" id="learnQueriesError">At least one search query is required.</div>

  <details>
    <summary>Learn path scopes (optional)</summary>
    <div class="hint" style="margin-top:4px">Restrict Learn results to specific doc areas. One URL path prefix per line. Leave empty to search all of Learn.</div>
    <textarea id="learnPathScopes" rows="3" placeholder="/en-us/azure/aks/&#10;/en-us/cli/azure/"></textarea>
  </details>

  <details>
    <summary>Exclude URL patterns (optional)</summary>
    <div class="hint" style="margin-top:4px">Skip Learn results whose URL contains any of these substrings. One per line.</div>
    <textarea id="learnExcludeUrlPatterns" rows="2" placeholder="visual-studio-code&#10;release-notes"></textarea>
  </details>

  <label for="githubOrgs">GitHub organizations</label>
  <div class="hint">Search code in these GitHub orgs. One per line.</div>
  <textarea id="githubOrgs" rows="2" placeholder="MicrosoftDocs&#10;Azure"></textarea>

  <label for="githubQueries">GitHub search queries</label>
  <div class="hint">Code search queries to find docs in GitHub. One per line.</div>
  <textarea id="githubQueries" rows="3" placeholder='"Manage Extensions" copilot "Visual Studio"&#10;marketplace.visualstudio.com copilot'></textarea>

  <details>
    <summary>Excluded repositories (optional)</summary>
    <div class="hint" style="margin-top:4px">Skip results from these repos (org/repo format). One per line.</div>
    <textarea id="excludedRepos" rows="2" placeholder="MicrosoftDocs/visualstudio-docs-archive-pr"></textarea>
  </details>

  <details>
    <summary>URL filters (optional)</summary>
    <div class="hint" style="margin-top:4px"><strong>Relevant URLs</strong> — Only keep pages whose URL contains one of these substrings. Leave empty to accept all.</div>
    <textarea id="relevantUrls" rows="2" placeholder="/azure/aks/&#10;/training/modules/"></textarea>
    <div class="hint" style="margin-top:8px"><strong>Skip URLs</strong> — Discard pages whose URL contains any of these substrings.</div>
    <textarea id="skipUrls" rows="2" placeholder="/release-notes/&#10;/microsoft-365-copilot/"></textarea>
  </details>
</div>

<!-- Step 3: Detection -->
<div class="step" data-step="3">
  <h2>Step 3 — Detection</h2>
  <p class="hint">Configure how the pipeline identifies outdated content.</p>

  <label for="keyFacts">Key facts about current product state</label>
  <div class="hint">Write clear, factual statements about how your product works <strong>today</strong>. These are injected into the AI prompt as ground truth. One fact per line.</div>
  <textarea id="keyFacts" rows="6" placeholder="Copilot is built into Visual Studio 2022 17.10+ — no extension install needed.&#10;The Manage Extensions dialog is NOT the correct install path for Copilot in VS 2022 17.10+.&#10;For VS 2022 before 17.10, users DO still need to install via Manage Extensions."></textarea>

  <div class="checkbox-row">
    <input type="checkbox" id="enableLlm" checked />
    <label for="enableLlm" style="margin:0;font-weight:normal">Enable AI-assisted detection (recommended)</label>
  </div>
  <div class="hint" style="margin-left:26px">Uses an AI model to analyze each page against your key facts. Catches issues that regex rules alone can't find. Adds ~2-5 minutes to a run depending on how many pages are found.</div>
</div>

<!-- Step 4: Classification -->
<div class="step" data-step="4">
  <h2>Step 4 — Classification</h2>
  <p class="hint">Define patterns that identify your product in article text, used to determine if a page is in scope.</p>

  <label for="productPatterns">Product name patterns <span style="color:var(--vscode-errorForeground)">*</span></label>
  <div class="hint">Regex patterns that match your product name in article text. One per line. These are case-insensitive.</div>
  <textarea id="productPatterns" rows="3" placeholder="azure\\s+kubernetes\\s+service&#10;\\baks\\b"></textarea>
  <div class="error" id="productPatternsError">At least one product pattern is required.</div>

  <label for="toolPatterns">Tool name patterns <span class="hint">(optional)</span></label>
  <div class="hint">Regex patterns matching the tool or IDE name. Used to narrow scope when your product appears in multiple contexts.</div>
  <textarea id="toolPatterns" rows="2" placeholder="visual\\s+studio\\b(?!\\s*code)"></textarea>
</div>

<!-- Step 5: Release Notes & Reporting -->
<div class="step" data-step="5">
  <h2>Step 5 — Release Notes &amp; Reporting</h2>

  <label for="releaseNotesUrl">Release notes URL <span class="hint">(optional)</span></label>
  <div class="hint">URL to your product's release notes page on learn.microsoft.com. Used to correlate findings with recent changes.</div>
  <input type="text" id="releaseNotesUrl" placeholder="https://learn.microsoft.com/azure/aks/release-notes" />

  <label for="sectionPattern">Section heading pattern</label>
  <div class="hint">Regex to identify relevant sections in the release notes page, e.g. a date heading or version heading.</div>
  <input type="text" id="sectionPattern" placeholder="## \\d{4}-\\d{2}-\\d{2}" />

  <hr style="margin-top:20px; border-color: var(--vscode-widget-border, #555);" />

  <label for="reportTitle">Report title</label>
  <input type="text" id="reportTitle" placeholder="" />
  <div class="hint">Leave blank to auto-generate from scenario name.</div>

  <label>Report formats</label>
  <div class="hint" style="margin-bottom:4px">Choose which output formats to generate.</div>
  <div class="checkbox-row">
    <input type="checkbox" id="fmtMarkdown" checked />
    <label for="fmtMarkdown" style="margin:0;font-weight:normal">Markdown</label>
  </div>
  <div class="checkbox-row">
    <input type="checkbox" id="fmtCsv" checked />
    <label for="fmtCsv" style="margin:0;font-weight:normal">CSV</label>
  </div>
  <div class="checkbox-row">
    <input type="checkbox" id="fmtJson" />
    <label for="fmtJson" style="margin:0;font-weight:normal">JSON</label>
  </div>
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
    // Auto-fill report title if blank
    if (n === 5 && !$('#reportTitle').value.trim()) {
      const name = $('#scenarioName').value.trim();
      if (name) { $('#reportTitle').value = name + ' — Freshness Report'; }
    }
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
      if (!$('#learnQueries').value.trim() && !$('#githubQueries').value.trim()) {
        showError('learnQueriesError');
        return false;
      }
      return true;
    }
    if (step === 4) {
      if (!$('#productPatterns').value.trim()) { showError('productPatternsError'); return false; }
      return true;
    }
    return true;
  }
  function showError(id) { const el = $('#' + id); if (el) el.style.display = 'block'; }
  function hideErrors() { $$('.error').forEach(e => e.style.display = 'none'); }

  // ── collect data ───────────────────────────────────────────────────
  function lines(id) { return ($('#' + id).value || '').split('\\n').map(l => l.trim()).filter(Boolean); }

  function collectData() {
    const formats = [];
    if ($('#fmtMarkdown').checked) formats.push('markdown');
    if ($('#fmtCsv').checked) formats.push('csv');
    if ($('#fmtJson').checked) formats.push('json');

    return {
      productName: $('#productName').value.trim(),
      toolName: $('#toolName').value.trim(),
      scenarioName: $('#scenarioName').value.trim(),
      description: $('#description').value.trim(),
      learnQueries: lines('learnQueries'),
      learnPathScopes: lines('learnPathScopes'),
      learnExcludeUrlPatterns: lines('learnExcludeUrlPatterns'),
      githubOrgs: lines('githubOrgs'),
      githubQueries: lines('githubQueries'),
      excludedRepos: lines('excludedRepos'),
      relevantUrls: lines('relevantUrls'),
      skipUrls: lines('skipUrls'),
      keyFacts: lines('keyFacts'),
      enableLlm: $('#enableLlm').checked,
      productPatterns: lines('productPatterns'),
      toolPatterns: lines('toolPatterns'),
      releaseNotesUrl: $('#releaseNotesUrl').value.trim(),
      sectionPattern: $('#sectionPattern').value.trim(),
      reportTitle: $('#reportTitle').value.trim(),
      reportFormats: formats,
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
    if (d.description) y += 'description: >\\n  ' + d.description.replace(/\\n/g, '\\n  ') + '\\n';
    y += '\\nproduct:\\n';
    y += '  name: ' + quoteYaml(d.productName) + '\\n';
    if (d.toolName) y += '  tool: ' + quoteYaml(d.toolName) + '\\n';

    y += '\\nsearch:\\n';
    if (d.learnQueries.length) {
      y += '  learn:\\n';
      y += '    queries:\\n';
      y += yamlList(d.learnQueries, '      ');
      if (d.learnPathScopes.length) {
        y += '    path_scopes:\\n';
        y += yamlList(d.learnPathScopes, '      ');
      }
      if (d.learnExcludeUrlPatterns.length) {
        y += '    exclude_url_patterns:\\n';
        y += yamlList(d.learnExcludeUrlPatterns, '      ');
      }
    }
    if (d.githubOrgs.length || d.githubQueries.length) {
      y += '  github:\\n';
      if (d.githubOrgs.length) {
        y += '    orgs:\\n';
        y += yamlList(d.githubOrgs, '      ');
      }
      if (d.githubQueries.length) {
        y += '    queries:\\n';
        y += yamlList(d.githubQueries, '      ');
      }
      if (d.excludedRepos.length) {
        y += '    excluded_repos:\\n';
        y += yamlList(d.excludedRepos, '      ');
      }
    }

    if (d.relevantUrls.length || d.skipUrls.length) {
      y += '\\nurl_filters:\\n';
      if (d.relevantUrls.length) {
        y += '  relevant:\\n';
        y += yamlList(d.relevantUrls, '    ');
      } else {
        y += '  relevant: []\\n';
      }
      if (d.skipUrls.length) {
        y += '  skip:\\n';
        y += yamlList(d.skipUrls, '    ');
      } else {
        y += '  skip: []\\n';
      }
    }

    y += '\\ndetection:\\n';
    y += '  regex_rules: rules.yaml\\n';
    if (d.enableLlm) {
      y += '  llm:\\n';
      y += '    prompt_template: prompts/detect.md.j2\\n';
      if (d.keyFacts.length) {
        y += '    key_facts:\\n';
        y += yamlList(d.keyFacts, '      ');
      }
      y += '    max_article_chars: 8000\\n';
      y += '    rate_limit_rpm: 10\\n';
    }

    y += '\\nclassification:\\n';
    y += '  strategy: strategy.yaml\\n';
    y += '  scope:\\n';
    y += '    product_patterns:\\n';
    y += yamlList(d.productPatterns, '      ');
    if (d.toolPatterns.length) {
      y += '    tool_patterns:\\n';
      y += yamlList(d.toolPatterns, '      ');
    }

    if (d.releaseNotesUrl) {
      y += '\\nrelease_notes:\\n';
      y += '  url: ' + quoteYaml(d.releaseNotesUrl) + '\\n';
      if (d.sectionPattern) y += '  section_pattern: ' + quoteYaml(d.sectionPattern) + '\\n';
      y += '  section_key: product_sections\\n';
    }

    y += '\\nreporting:\\n';
    const title = d.reportTitle || d.scenarioName + ' — Freshness Report';
    y += '  title: ' + quoteYaml(title) + '\\n';
    y += '  formats:\\n';
    y += yamlList(d.reportFormats.length ? d.reportFormats : ['markdown'], '    ');

    return y;
  }

  function buildRulesYaml(d) {
    let y = '# Regex detection rules for ' + d.scenarioName + '\\n';
    y += '# Add patterns that match outdated content in article text.\\n\\n';
    y += 'filters:\\n';
    y += '  include:\\n';
    y += '    url_regex:\\n';
    y += '      - "learn\\\\.microsoft\\\\.com"\\n';
    y += '  exclude:\\n';
    y += '    url_regex:\\n';
    y += '      - release-notes\\n\\n';
    y += 'rules:\\n';
    y += '  - id: EXAMPLE_OUTDATED\\n';
    y += '    title: "References outdated pattern"\\n';
    y += '    severity: P0\\n';
    y += '    match:\\n';
    y += '      any_regex:\\n';
    y += '        - "(?i)REPLACE_WITH_OUTDATED_PATTERN"\\n';
    y += '    unless:\\n';
    y += '      any_regex: []\\n';
    return y;
  }

  function buildStrategyYaml(d) {
    let y = '# Classification strategy for ' + d.scenarioName + '\\n\\n';
    y += 'meta:\\n';
    y += '  name: ' + quoteYaml(d.scenarioName) + '\\n';
    y += '  version: "1.0"\\n\\n';
    y += 'scope:\\n';
    y += '  product_patterns:\\n';
    y += yamlList(d.productPatterns, '    ');
    if (d.toolPatterns.length) {
      y += '  tool_patterns:\\n';
      y += yamlList(d.toolPatterns, '    ');
    }
    y += '\\nhard_exclusions:\\n';
    y += '  url_regex: []\\n';
    y += '  repo_regex: []\\n';
    y += '\\nclassification:\\n';
    y += '  default_confidence:\\n';
    y += '    p0_outdated: high\\n';
    y += '    needs_clarification: medium\\n';
    y += '    up_to_date: medium\\n';
    y += '    excluded: high\\n';
    y += '\\ntopic_rules: []\\n';
    y += '# Add topic rules to classify findings into specific areas.\\n';
    y += '# See scenarios/copilot-vs/strategy.yaml for examples.\\n';
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
    y += `description: >\n  ${d.description.replace(/\n/g, "\n  ")}\n`;
  }

  y += "\nproduct:\n";
  y += `  name: ${quoteYaml(d.productName)}\n`;
  if (d.toolName) {
    y += `  tool: ${quoteYaml(d.toolName)}\n`;
  }

  y += "\nsearch:\n";
  if (d.learnQueries.length) {
    y += "  learn:\n";
    y += "    queries:\n";
    y += yamlList(d.learnQueries, "      ");
    if (d.learnPathScopes.length) {
      y += "    path_scopes:\n";
      y += yamlList(d.learnPathScopes, "      ");
    }
    if (d.learnExcludeUrlPatterns.length) {
      y += "    exclude_url_patterns:\n";
      y += yamlList(d.learnExcludeUrlPatterns, "      ");
    }
  }
  if (d.githubOrgs.length || d.githubQueries.length) {
    y += "  github:\n";
    if (d.githubOrgs.length) {
      y += "    orgs:\n";
      y += yamlList(d.githubOrgs, "      ");
    }
    if (d.githubQueries.length) {
      y += "    queries:\n";
      y += yamlList(d.githubQueries, "      ");
    }
    if (d.excludedRepos.length) {
      y += "    excluded_repos:\n";
      y += yamlList(d.excludedRepos, "      ");
    }
  }

  if (d.relevantUrls.length || d.skipUrls.length) {
    y += "\nurl_filters:\n";
    if (d.relevantUrls.length) {
      y += "  relevant:\n";
      y += yamlList(d.relevantUrls, "    ");
    } else {
      y += "  relevant: []\n";
    }
    if (d.skipUrls.length) {
      y += "  skip:\n";
      y += yamlList(d.skipUrls, "    ");
    } else {
      y += "  skip: []\n";
    }
  }

  y += "\ndetection:\n";
  y += "  regex_rules: rules.yaml\n";
  if (d.enableLlm) {
    y += "  llm:\n";
    y += "    prompt_template: prompts/detect.md.j2\n";
    if (d.keyFacts.length) {
      y += "    key_facts:\n";
      y += yamlList(d.keyFacts, "      ");
    }
    y += "    max_article_chars: 8000\n";
    y += "    rate_limit_rpm: 10\n";
  }

  y += "\nclassification:\n";
  y += "  strategy: strategy.yaml\n";
  y += "  scope:\n";
  y += "    product_patterns:\n";
  y += yamlList(d.productPatterns, "      ");
  if (d.toolPatterns.length) {
    y += "    tool_patterns:\n";
    y += yamlList(d.toolPatterns, "      ");
  }

  if (d.releaseNotesUrl) {
    y += "\nrelease_notes:\n";
    y += `  url: ${quoteYaml(d.releaseNotesUrl)}\n`;
    if (d.sectionPattern) {
      y += `  section_pattern: ${quoteYaml(d.sectionPattern)}\n`;
    }
    y += "  section_key: product_sections\n";
  }

  y += "\nreporting:\n";
  const title = d.reportTitle || `${d.scenarioName} — Freshness Report`;
  y += `  title: ${quoteYaml(title)}\n`;
  y += "  formats:\n";
  y += yamlList(d.reportFormats.length ? d.reportFormats : ["markdown"], "    ");

  return y;
}

export function generateRulesYaml(d: ScenarioFormData): string {
  let y = `# Regex detection rules for ${d.scenarioName}\n`;
  y += "# Add patterns that match outdated content in article text.\n\n";
  y += "filters:\n";
  y += "  include:\n";
  y += "    url_regex:\n";
  y += '      - "learn\\\\.microsoft\\\\.com"\n';
  y += "  exclude:\n";
  y += "    url_regex:\n";
  y += "      - release-notes\n\n";
  y += "rules:\n";
  y += "  - id: EXAMPLE_OUTDATED\n";
  y += '    title: "References outdated pattern"\n';
  y += "    severity: P0\n";
  y += "    match:\n";
  y += "      any_regex:\n";
  y += '        - "(?i)REPLACE_WITH_OUTDATED_PATTERN"\n';
  y += "    unless:\n";
  y += "      any_regex: []\n";
  return y;
}

export function generateStrategyYaml(d: ScenarioFormData): string {
  let y = `# Classification strategy for ${d.scenarioName}\n\n`;
  y += "meta:\n";
  y += `  name: ${quoteYaml(d.scenarioName)}\n`;
  y += '  version: "1.0"\n\n';
  y += "scope:\n";
  y += "  product_patterns:\n";
  y += yamlList(d.productPatterns, "    ");
  if (d.toolPatterns.length) {
    y += "  tool_patterns:\n";
    y += yamlList(d.toolPatterns, "    ");
  }
  y += "\nhard_exclusions:\n";
  y += "  url_regex: []\n";
  y += "  repo_regex: []\n";
  y += "\nclassification:\n";
  y += "  default_confidence:\n";
  y += "    p0_outdated: high\n";
  y += "    needs_clarification: medium\n";
  y += "    up_to_date: medium\n";
  y += "    excluded: high\n";
  y += "\ntopic_rules: []\n";
  y += "# Add topic rules to classify findings into specific areas.\n";
  y += "# See scenarios/copilot-vs/strategy.yaml for examples.\n";
  return y;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Generate a default Jinja2 prompt template for LLM detection. */
function generatePromptTemplate(): string {
  return `You are a documentation freshness reviewer for Microsoft Learn.
You are reviewing articles about {{ product_name }}{% if tool_name %} used with {{ tool_name }}{% endif %}.

IMPORTANT RULES:
- Only flag ACTUAL CONFLICTS where the article explicitly states something wrong.
- Do NOT flag an article for "not mentioning" something. Absence is not a conflict.
- Be conservative: if you're unsure, do NOT flag it.

KNOWN FACTS (from latest release notes and product documentation):

{% for fact in key_facts %}- {{ fact }}
{% endfor %}

ARTICLE UNDER REVIEW:
URL: {{ article_url }}

---
{{ article_text }}
---

TASK:
Find statements in the article that EXPLICITLY CONTRADICT the known facts above.
Only report issues where the article ACTIVELY SAYS something incorrect.

For each real conflict, return a JSON object with these fields:
- "severity": "P0" for broken instructions (user will fail if they follow these), "P1" for stale versions/features (misleading but not broken), "INFO" for minor staleness (cosmetic or low-impact)
- "rule_id": "LLM.conflict"
- "title": A short title describing the conflict (max 80 chars)
- "conflict": A 1-2 sentence description of what's wrong
- "article_quote": The EXACT conflicting text from the article (max 200 chars, must be a real quote from the article above)
- "fact": The correct fact from the KNOWN FACTS list

If there are NO real conflicts, return an empty JSON array: []

Respond ONLY with a valid JSON array. No explanation, no markdown fencing.
`;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
