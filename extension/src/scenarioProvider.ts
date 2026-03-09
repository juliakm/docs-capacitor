import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ── YAML shape (partial, matches scenario.yaml fields we inspect) ────

interface ScenarioYaml {
  name?: string;
  product?: { name?: string; tool?: string };
  search?: {
    learn?: { queries?: string[] };
    github?: { orgs?: string[]; queries?: string[] };
  };
  detection?: {
    regex_rules?: string;
    llm?: { key_facts?: string[] };
  };
  classification?: { strategy?: string };
  reporting?: { formats?: string[] };
}

// ── Tree items ───────────────────────────────────────────────────────

type ScenarioTreeItem = ScenarioItem | ComponentItem;

export class ScenarioItem extends vscode.TreeItem {
  constructor(
    public readonly scenarioName: string,
    public readonly productName: string,
    public readonly scenarioPath: string,
    public readonly scenarioDir: string,
    public readonly lastModified: Date,
  ) {
    super(scenarioName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = productName;
    this.tooltip = `${scenarioPath}\nModified: ${lastModified.toLocaleString()}`;
    this.contextValue = "scenario";
    this.iconPath = new vscode.ThemeIcon("file-code");
  }
}

export class ComponentItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly status: "configured" | "missing" | "partial",
    public readonly scenarioPath: string,
    public readonly componentKey: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    const icons: Record<string, string> = {
      configured: "check",
      missing: "warning",
      partial: "info",
    };
    const badges: Record<string, string> = {
      configured: "✓ configured",
      missing: "⚠ missing",
      partial: "~ partial",
    };
    this.description = badges[status];
    this.iconPath = new vscode.ThemeIcon(icons[status]);
    this.tooltip = `${label}: ${badges[status]}`;
    this.contextValue = "scenarioComponent";
  }
}

// ── Provider ─────────────────────────────────────────────────────────

export class ScenarioProvider implements vscode.TreeDataProvider<ScenarioTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ScenarioTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private scenarios: ScenarioItem[] = [];

  constructor() {
    this.discoverScenarios();
  }

  refresh(): void {
    this.discoverScenarios();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ScenarioTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ScenarioTreeItem): ScenarioTreeItem[] {
    if (!element) {
      return this.scenarios;
    }
    if (element instanceof ScenarioItem) {
      return this.getComponents(element);
    }
    return [];
  }

  // ── scenario discovery ─────────────────────────────────────────────

  private discoverScenarios(): void {
    this.scenarios = [];
    const roots = vscode.workspace.workspaceFolders ?? [];
    const seen = new Set<string>();

    for (const folder of roots) {
      const wsRoot = folder.uri.fsPath;

      // 1. Check <root>/scenarios/*/scenario.yaml
      const scenariosDir = path.join(wsRoot, "scenarios");
      if (fs.existsSync(scenariosDir)) {
        for (const entry of fs.readdirSync(scenariosDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const yamlPath = path.join(scenariosDir, entry.name, "scenario.yaml");
            if (fs.existsSync(yamlPath) && !seen.has(yamlPath)) {
              seen.add(yamlPath);
              this.addScenario(yamlPath);
            }
          }
        }
      }

      // 2. Shallow walk for **/scenario.yaml (max depth 3 to stay fast)
      this.walkForScenarios(wsRoot, 0, 3, seen);
    }
  }

  private walkForScenarios(dir: string, depth: number, maxDepth: number, seen: Set<string>): void {
    if (depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "out") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "scenario.yaml" && !seen.has(full)) {
        seen.add(full);
        this.addScenario(full);
      } else if (entry.isDirectory()) {
        this.walkForScenarios(full, depth + 1, maxDepth, seen);
      }
    }
  }

  private addScenario(yamlPath: string): void {
    try {
      const raw = fs.readFileSync(yamlPath, "utf-8");
      const doc = yaml.load(raw) as ScenarioYaml | undefined;
      const stat = fs.statSync(yamlPath);
      this.scenarios.push(
        new ScenarioItem(
          doc?.name ?? path.basename(path.dirname(yamlPath)),
          doc?.product?.name ?? "Unknown product",
          yamlPath,
          path.dirname(yamlPath),
          stat.mtime,
        ),
      );
    } catch {
      // Unparseable YAML — skip
    }
  }

  // ── component inspection ───────────────────────────────────────────

  private getComponents(item: ScenarioItem): ComponentItem[] {
    let doc: ScenarioYaml | undefined;
    try {
      doc = yaml.load(fs.readFileSync(item.scenarioPath, "utf-8")) as ScenarioYaml | undefined;
    } catch {
      return [];
    }

    const components: ComponentItem[] = [];

    // Search Config
    const hasQueries =
      (doc?.search?.learn?.queries?.length ?? 0) > 0 ||
      (doc?.search?.github?.queries?.length ?? 0) > 0;
    components.push(
      new ComponentItem(
        "Search Config",
        hasQueries ? "configured" : "missing",
        item.scenarioPath,
        "search",
      ),
    );

    // Detection Rules
    const rulesFile = doc?.detection?.regex_rules;
    const rulesExist = rulesFile
      ? fs.existsSync(path.join(item.scenarioDir, rulesFile))
      : false;
    const hasKeyFacts = (doc?.detection?.llm?.key_facts?.length ?? 0) > 0;
    const detectionStatus = rulesExist && hasKeyFacts ? "configured" : rulesExist || hasKeyFacts ? "partial" : "missing";
    components.push(
      new ComponentItem("Detection Rules", detectionStatus, item.scenarioPath, "detection"),
    );

    // Classification Strategy
    const strategyFile = doc?.classification?.strategy;
    const strategyExists = strategyFile
      ? fs.existsSync(path.join(item.scenarioDir, strategyFile))
      : false;
    components.push(
      new ComponentItem(
        "Classification Strategy",
        strategyExists ? "configured" : "missing",
        item.scenarioPath,
        "classification",
      ),
    );

    // Reports
    const hasFormats = (doc?.reporting?.formats?.length ?? 0) > 0;
    components.push(
      new ComponentItem("Reports", hasFormats ? "configured" : "missing", item.scenarioPath, "reporting"),
    );

    return components;
  }

  // ── commands ───────────────────────────────────────────────────────

  /** Run freshness check for a specific scenario. */
  async runCheck(item: ScenarioItem): Promise<void> {
    await vscode.commands.executeCommand("docs-capacitor.check", item.scenarioPath);
  }

  /** Run validation for a specific scenario. */
  async validate(item: ScenarioItem): Promise<void> {
    await vscode.commands.executeCommand("docs-capacitor.validate", item.scenarioPath);
  }

  /** Open the scenario YAML in an editor. */
  async editScenario(item: ScenarioItem): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(item.scenarioPath);
    await vscode.window.showTextDocument(doc);
  }

  /** Duplicate scenario directory with a new name. */
  async duplicateScenario(item: ScenarioItem): Promise<void> {
    const newName = await vscode.window.showInputBox({
      prompt: "New scenario name",
      placeHolder: "my-new-scenario",
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });
    if (!newName) {
      return;
    }

    const parent = path.dirname(item.scenarioDir);
    const dest = path.join(parent, newName);
    if (fs.existsSync(dest)) {
      vscode.window.showErrorMessage(`Directory already exists: ${dest}`);
      return;
    }
    await fs.promises.cp(item.scenarioDir, dest, { recursive: true });

    // Update name in the copied scenario.yaml
    const newYaml = path.join(dest, "scenario.yaml");
    if (fs.existsSync(newYaml)) {
      let content = await fs.promises.readFile(newYaml, "utf-8");
      const doc = yaml.load(content) as ScenarioYaml | undefined;
      if (doc?.name) {
        content = content.replace(doc.name, `${doc.name} (copy)`);
        await fs.promises.writeFile(newYaml, content, "utf-8");
      }
    }

    this.refresh();
    vscode.window.showInformationMessage(`Scenario duplicated to ${dest}`);
  }

  /** Export (copy) scenario directory to user-chosen location. */
  async exportScenario(item: ScenarioItem): Promise<void> {
    const target = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Choose export destination",
    });
    if (!target || target.length === 0) {
      return;
    }
    const dest = path.join(target[0].fsPath, path.basename(item.scenarioDir));
    await fs.promises.cp(item.scenarioDir, dest, { recursive: true });
    vscode.window.showInformationMessage(`Scenario exported to ${dest}`);
  }

  /** Delete scenario directory after confirmation. */
  async deleteScenario(item: ScenarioItem): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Delete scenario "${item.scenarioName}" and its entire directory?\n${item.scenarioDir}`,
      { modal: true },
      "Delete",
    );
    if (answer !== "Delete") {
      return;
    }
    await fs.promises.rm(item.scenarioDir, { recursive: true, force: true });
    this.refresh();
    vscode.window.showInformationMessage(`Scenario "${item.scenarioName}" deleted.`);
  }

  // ── inline editing helpers ─────────────────────────────────────────

  /** Append a search query to the learn.queries list. */
  async addSearchQuery(item: ScenarioItem): Promise<void> {
    const query = await vscode.window.showInputBox({
      prompt: "Enter a new search query",
      placeHolder: "az webapp create",
    });
    if (!query) {
      return;
    }
    this.appendToYamlList(item.scenarioPath, ["search", "learn", "queries"], query);
  }

  /** Append a key fact to the detection.llm.key_facts list. */
  async addKeyFact(item: ScenarioItem): Promise<void> {
    const fact = await vscode.window.showInputBox({
      prompt: "Enter a key fact about the product",
      placeHolder: "The latest version is 3.0",
    });
    if (!fact) {
      return;
    }
    this.appendToYamlList(item.scenarioPath, ["detection", "llm", "key_facts"], fact);
  }

  /** Generic helper: append a string value to a nested YAML list. */
  private appendToYamlList(filePath: string, keyPath: string[], value: string): void {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const doc = yaml.load(raw) as Record<string, unknown> | undefined;
      if (!doc) {
        return;
      }

      // Walk to the parent and set the list
      let current: Record<string, unknown> = doc;
      for (let i = 0; i < keyPath.length - 1; i++) {
        if (current[keyPath[i]] === undefined || current[keyPath[i]] === null) {
          current[keyPath[i]] = {};
        }
        current = current[keyPath[i]] as Record<string, unknown>;
      }

      const listKey = keyPath[keyPath.length - 1];
      if (!Array.isArray(current[listKey])) {
        current[listKey] = [];
      }
      (current[listKey] as string[]).push(value);

      fs.writeFileSync(filePath, yaml.dump(doc, { lineWidth: 120 }), "utf-8");
      this.refresh();
      vscode.window.showInformationMessage(`Added "${value}" to ${keyPath.join(".")}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to update YAML: ${err}`);
    }
  }
}
