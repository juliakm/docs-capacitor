import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// ── Interfaces ───────────────────────────────────────────────────────

/** A single LLM finding with detailed conflict information. */
export interface LlmFinding {
  title?: string;
  conflict?: string;
  article_quote?: string;
  fact?: string;
  severity?: string;
}

/** A single page result from the freshness pipeline. */
export interface PageResult {
  url: string;
  title?: string;
  classification: string;
  confidence: number | string;
  topic?: string;
  reason?: string;
  suggested_fix?: string;
  evidence?: string;
  regex_evidence?: string;
  regex_signals?: string[];
  regex_signal?: string;
  release_conflict_section?: string;
  agrees_with_regex?: boolean;
  repo?: string;
  llm_findings?: LlmFinding[];
  ms_date?: string;
  date_flag?: string;
}

/** Format confidence for display — handles both string ("high") and numeric (0.85) values. */
function formatConfidence(confidence: number | string | undefined): string {
  if (confidence === undefined || confidence === null) { return ""; }
  if (typeof confidence === "string") {
    return confidence.charAt(0).toUpperCase() + confidence.slice(1);
  }
  if (typeof confidence === "number" && confidence <= 1) {
    return `${(confidence * 100).toFixed(0)}%`;
  }
  return String(confidence);
}

/** Extract a human-readable title from a Learn URL path segment. */
function titleFromUrl(url: string): string {
  if (!url) { return "(unknown)"; }
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.replace(/\/$/, "").split("/").pop() ?? "";
    return last.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || url;
  } catch {
    return url;
  }
}

/** Shorten a URL for display — show just the path after the domain. */
function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const shortened = u.pathname.replace(/^\/en-us\//, "");
    return shortened.length > 60 ? "…" + shortened.slice(-57) : shortened;
  } catch {
    return url;
  }
}

/** Classification display order and metadata. */
const CLASSIFICATION_META: Record<string, { order: number; icon: vscode.ThemeIcon }> = {
  P0_OUTDATED: { order: 0, icon: new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground")) },
  NEEDS_CLARIFICATION: { order: 1, icon: new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground")) },
  UP_TO_DATE: { order: 2, icon: new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed")) },
  EXCLUDED: { order: 3, icon: new vscode.ThemeIcon("circle-slash") },
};

function classificationOrder(c: string): number {
  return CLASSIFICATION_META[c]?.order ?? 99;
}

function classificationIcon(c: string): vscode.ThemeIcon {
  return CLASSIFICATION_META[c]?.icon ?? new vscode.ThemeIcon("question");
}

// ── Tree item types ──────────────────────────────────────────────────

export type ResultItemKind = "bucket" | "page" | "detail";

export class ResultItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: ResultItemKind,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly classification?: string,
    public readonly pageResult?: PageResult,
  ) {
    super(label, collapsibleState);
  }
}

// ── Triage state persistence ─────────────────────────────────────────

export type TriageDecision = "valid" | "false_positive" | "ignore_repo";

export interface TriageState {
  decisions: Record<string, TriageDecision>;  // keyed by URL
  ignored_repos: string[];  // repos to exclude
}

function triageFilePath(scenario?: string): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { return undefined; }
  if (scenario) {
    return path.join(root, "output", scenario, ".capacitor-triage.json");
  }
  return path.join(root, "output", ".capacitor-triage.json");
}

function legacyReviewedFilePath(scenario?: string): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { return undefined; }
  if (scenario) {
    return path.join(root, "output", scenario, ".capacitor-reviewed.json");
  }
  return path.join(root, "output", ".capacitor-reviewed.json");
}

function loadTriageState(scenario?: string): TriageState {
  const fp = triageFilePath(scenario);
  if (fp && fs.existsSync(fp)) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8")) as Partial<TriageState>;
      return {
        decisions: data.decisions && typeof data.decisions === "object" ? data.decisions : {},
        ignored_repos: Array.isArray(data.ignored_repos) ? data.ignored_repos : [],
      };
    } catch { /* ignore */ }
  }

  // Backward compat: migrate legacy .capacitor-reviewed.json → valid decisions
  const legacyFp = legacyReviewedFilePath(scenario);
  if (legacyFp && fs.existsSync(legacyFp)) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(legacyFp, "utf-8"));
      if (Array.isArray(data)) {
        const decisions: Record<string, TriageDecision> = {};
        for (const url of data) { decisions[String(url)] = "valid"; }
        return { decisions, ignored_repos: [] };
      }
    } catch { /* ignore */ }
  }

  return { decisions: {}, ignored_repos: [] };
}

function saveTriageState(state: TriageState, scenario?: string): void {
  const fp = triageFilePath(scenario);
  if (!fp) { return; }
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(fp, JSON.stringify(state, null, 2));
}

// ── Provider ─────────────────────────────────────────────────────────

/**
 * TreeDataProvider that displays freshness results grouped by classification.
 * Reads from output/classifications.json (preferred) or output/report.csv.
 */
export class ResultsProvider implements vscode.TreeDataProvider<ResultItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ResultItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: PageResult[] = [];
  private triageState: TriageState = { decisions: {}, ignored_repos: [] };
  private activeFilter: string | undefined;
  private showUntriagedOnly = false;
  private treeView: vscode.TreeView<ResultItem> | undefined;
  /** Counts from the JSON meta block. */
  private meta: { actionable: number; non_actionable: number; date_excluded: number; total: number } | undefined;
  /** The scenario whose results are currently displayed. */
  private activeScenario: string | undefined;
  private initialLoadTimer: NodeJS.Timeout | undefined;
  private scenarioRetryTimers: NodeJS.Timeout[] = [];

  constructor() {
    // Defer loading until tree view is bound.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("docs-capacitor.scenarioPaths")) {
        this.refresh();
      }
    });
  }

  /** Bind the tree view so we can update its message (summary bar). */
  setTreeView(view: vscode.TreeView<ResultItem>): void {
    this.treeView = view;
    if (this.initialLoadTimer) {
      clearTimeout(this.initialLoadTimer);
    }
    // Allow workspace configuration to settle before first results load.
    this.initialLoadTimer = setTimeout(() => {
      this.loadResults();
      this._onDidChangeTreeData.fire();
      this.updateSummaryMessage();
    }, 500);
  }

  /** Load results for a specific scenario and refresh the tree. */
  loadScenario(scenarioName: string): void {
    for (const t of this.scenarioRetryTimers) {
      clearTimeout(t);
    }
    this.scenarioRetryTimers = [];

    this.activeScenario = scenarioName;
    this.loadResults();
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();

    if (this.results.length > 0) {
      return;
    }

    // On some Windows runs, result files appear moments after process exit.
    // Retry briefly so users don't need manual "Load Results from File".
    const retryDelays = [400, 1200];
    for (const delay of retryDelays) {
      const timer = setTimeout(() => {
        if (this.activeScenario !== scenarioName || this.results.length > 0) {
          return;
        }
        this.loadResults();
        this._onDidChangeTreeData.fire();
        this.updateSummaryMessage();
      }, delay);
      this.scenarioRetryTimers.push(timer);
    }
  }

  /** Reload data from disk and refresh the tree. */
  refresh(): void {
    this.loadResults();
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
  }

  /** Load results directly from a specific file path. */
  loadFile(filePath: string): void {
    this.meta = undefined;
    const parent = path.basename(path.dirname(filePath));
    this.activeScenario = parent !== "output" ? parent : undefined;
    const loaded = filePath.endsWith(".json")
      ? this.loadFromJson(filePath)
      : this.loadFromCsv(filePath);
    if (!loaded) {
      vscode.window.showWarningMessage(`Could not parse results from ${filePath}`);
      return;
    }
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
  }

  /** Get the name of the currently loaded scenario (if any). */
  getActiveScenario(): string | undefined {
    return this.activeScenario;
  }

  /** Return all scenario names that have results in output directories. */
  getAvailableScenarios(): string[] {
    const outputDirs = this.getOutputDirs();
    const scenarios: string[] = [];
    for (const outputDir of outputDirs) {
      if (!fs.existsSync(outputDir)) { continue; }
      try {
        for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const jsonPath = path.join(outputDir, entry.name, "classifications.json");
            if (fs.existsSync(jsonPath) && !scenarios.includes(entry.name)) {
              scenarios.push(entry.name);
            }
            const csvPath = path.join(outputDir, entry.name, "report.csv");
            if (fs.existsSync(csvPath) && !scenarios.includes(entry.name)) {
              scenarios.push(entry.name);
            }
            const localJsonPath = path.join(outputDir, entry.name, "classifications-local.json");
            const localLabel = entry.name + " (Local)";
            if (fs.existsSync(localJsonPath) && !scenarios.includes(localLabel)) {
              scenarios.push(localLabel);
            }
            const localCsvPath = path.join(outputDir, entry.name, "report-local.csv");
            if (fs.existsSync(localCsvPath) && !scenarios.includes(localLabel)) {
              scenarios.push(localLabel);
            }
          }
        }
      } catch { /* ignore */ }
    }
    return scenarios;
  }

  /** Collect all output directories: workspace + scenarioPaths siblings. */
  private getOutputDirs(): string[] {
    const dirs = new Set<string>();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      dirs.add(path.resolve(path.join(workspaceRoot, "output")));
    }
    const scenarioPaths = vscode.workspace
      .getConfiguration("docs-capacitor")
      .get<string[]>("scenarioPaths", []);
    for (const sp of scenarioPaths) {
      const resolved = path.resolve(path.isAbsolute(sp) ? sp : (workspaceRoot ? path.join(workspaceRoot, sp) : sp));
      const candidateDirs = new Set<string>();
      const addCandidate = (candidate: string): void => {
        candidateDirs.add(path.resolve(candidate));
      };

      try {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
          if (/scenario\.ya?ml$/i.test(path.basename(resolved))) {
            // <...>/<scenario>/scenario.yaml -> <...>/output
            addCandidate(path.join(path.dirname(path.dirname(resolved)), "output"));
          }
        } else if (stat.isDirectory()) {
          const directScenario = ["scenario.yaml", "scenario.yml"]
            .some((name) => fs.existsSync(path.join(resolved, name)));
          if (directScenario) {
            // <...>/<scenario>/ -> <...>/output
            addCandidate(path.join(path.dirname(resolved), "output"));
          }

          let hasNestedScenarios = false;
          try {
            for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
              if (!entry.isDirectory()) { continue; }
              const child = path.join(resolved, entry.name);
              if (["scenario.yaml", "scenario.yml"].some((name) => fs.existsSync(path.join(child, name)))) {
                hasNestedScenarios = true;
                break;
              }
            }
          } catch {
            // Skip inaccessible directories.
          }
          if (hasNestedScenarios) {
            // <...>/scenarios -> <...>/scenarios/output
            addCandidate(path.join(resolved, "output"));
          }
        }
      } catch {
        // Skip missing/inaccessible paths safely.
      }

      // Backward-compatible fallbacks from previous behavior.
      addCandidate(path.join(resolved, "..", "output"));
      addCandidate(path.join(resolved, "output"));

      for (const candidate of candidateDirs) {
        if (fs.existsSync(candidate)) {
          dirs.add(candidate);
        }
      }
    }
    return [...dirs];
  }

  /** Get the path to the active report CSV file, if it exists. */
  getActiveReportPath(): string | undefined {
    if (!this.activeScenario) { return undefined; }
    const isLocal = this.activeScenario.endsWith(" (Local)");
    const dirName = isLocal ? this.activeScenario.replace(" (Local)", "") : this.activeScenario;
    const suffix = isLocal ? "-local" : "";
    for (const outputDir of this.getOutputDirs()) {
      const csvPath = path.join(outputDir, dirName, `report${suffix}.csv`);
      if (fs.existsSync(csvPath)) { return csvPath; }
    }
    return undefined;
  }

  /** Set a classification filter (undefined = show all). */
  setFilter(classification: string | undefined): void {
    this.activeFilter = classification;
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
  }

  /** Toggle the "show untriaged only" filter. */
  setShowUntriagedOnly(value: boolean): void {
    this.showUntriagedOnly = value;
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
  }

  /** Apply a triage decision to a URL. */
  triageUrl(url: string, decision: TriageDecision): void {
    this.triageState.decisions[url] = decision;
    saveTriageState(this.triageState, this.activeScenario);
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
  }

  /** Ignore an entire repo — marks all results from that repo as false_positive too. */
  triageIgnoreRepo(repo: string): void {
    if (!this.triageState.ignored_repos.includes(repo)) {
      this.triageState.ignored_repos.push(repo);
    }
    // Mark all results from this repo as false_positive
    for (const r of this.results) {
      if (r.repo === repo) {
        this.triageState.decisions[r.url] = "false_positive";
      }
    }
    saveTriageState(this.triageState, this.activeScenario);
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
  }

  /** Get the current triage decision for a URL. */
  getTriageDecision(url: string): TriageDecision | undefined {
    return this.triageState.decisions[url];
  }

  /** Get the full triage state (for suggestions). */
  getTriageState(): TriageState {
    return this.triageState;
  }

  /** Get all loaded results (for suggestions). */
  getResults(): PageResult[] {
    return this.results;
  }

  // ── TreeDataProvider implementation ────────────────────────────────

  getTreeItem(element: ResultItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ResultItem): ResultItem[] {
    if (!element) {
      return this.getBuckets();
    }
    if (element.kind === "bucket" && element.classification) {
      return this.getPages(element.classification);
    }
    if (element.kind === "page" && element.pageResult) {
      return this.getDetails(element.pageResult);
    }
    return [];
  }

  // ── Tree construction ──────────────────────────────────────────────

  private getBuckets(): ResultItem[] {
    const filtered = this.filteredResults();
    const buckets = [...new Set(filtered.map((r) => r.classification))];
    buckets.sort((a, b) => classificationOrder(a) - classificationOrder(b));

    return buckets.map((c) => {
      const count = filtered.filter((r) => r.classification === c).length;
      const item = new ResultItem(
        c,
        "bucket",
        vscode.TreeItemCollapsibleState.Collapsed,
        c,
      );
      item.description = `${count} page${count !== 1 ? "s" : ""}`;
      item.iconPath = classificationIcon(c);
      item.contextValue = "bucket";
      item.tooltip = `${c}: ${count} page${count !== 1 ? "s" : ""}`;
      return item;
    });
  }

  private getPages(classification: string): ResultItem[] {
    return this.filteredResults()
      .filter((r) => r.classification === classification)
      .map((r) => {
        const decision = this.triageState.decisions[r.url];
        // Show title or last URL segment as the label, full URL as description
        const displayTitle = r.title || titleFromUrl(r.url);
        const shortUrl = shortenUrl(r.url);
        const item = new ResultItem(
          displayTitle,
          "page",
          vscode.TreeItemCollapsibleState.Collapsed,
          classification,
          r,
        );
        const parts: string[] = [shortUrl];
        if (r.topic) { parts.push(r.topic); }

        if (decision === "valid") {
          item.description = `✓ Valid — ${parts.join(" · ")}`;
          item.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
          item.contextValue = "pageTriagedValid";
        } else if (decision === "false_positive" || decision === "ignore_repo") {
          item.description = `✗ False positive — ${parts.join(" · ")}`;
          item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
          item.contextValue = "pageTriagedFP";
        } else {
          item.description = parts.join(" · ");
          item.iconPath = classificationIcon(classification);
          item.contextValue = "page";
        }

        const triageNote = decision === "valid" ? "\n\n✅ _Triaged: Valid Finding_"
          : decision === "false_positive" ? "\n\n❌ _Triaged: False Positive_"
          : decision === "ignore_repo" ? "\n\n🔇 _Triaged: Repo Ignored_"
          : "";
        item.tooltip = new vscode.MarkdownString(
          `**${displayTitle}**\n\n${r.url}\n\nClassification: ${r.classification}  \nConfidence: ${formatConfidence(r.confidence)}` +
          (r.topic ? `  \nTopic: ${r.topic}` : "") +
          (r.reason ? `  \nReason: ${r.reason}` : "") +
          (r.suggested_fix ? `  \nFix: ${r.suggested_fix}` : "") +
          triageNote,
        );
        // No command on click — left-click expands details instead of opening URL.
        // Use the context menu "Open URL" action to open deliberately.
        return item;
      });
  }

  private getDetails(r: PageResult): ResultItem[] {
    const items: ResultItem[] = [];
    const add = (label: string, value: string | undefined, icon = "info"): void => {
      if (!value) { return; }
      const item = new ResultItem(label, "detail", vscode.TreeItemCollapsibleState.None);
      item.description = value;
      item.tooltip = new vscode.MarkdownString(`**${label}**\n\n${value}`);
      item.contextValue = "detail";
      item.iconPath = new vscode.ThemeIcon(icon);
      items.push(item);
    };

    // Show LLM findings first — these are the most actionable
    if (r.llm_findings && r.llm_findings.length > 0) {
      for (const f of r.llm_findings) {
        if (f.title) {
          const item = new ResultItem(
            f.severity ? `[${f.severity}] ${f.title}` : f.title,
            "detail",
            vscode.TreeItemCollapsibleState.None,
          );
          const mdParts: string[] = [`### ${f.title}`];
          if (f.conflict) { mdParts.push(`\n**What's wrong:** ${f.conflict}`); }
          if (f.article_quote) { mdParts.push(`\n**Article says:** _"${f.article_quote}"_`); }
          if (f.fact) { mdParts.push(`\n**Should be:** ${f.fact}`); }
          item.tooltip = new vscode.MarkdownString(mdParts.join("\n"));
          item.tooltip.isTrusted = true;
          item.description = f.conflict ?? "";
          item.iconPath = new vscode.ThemeIcon(
            f.severity === "P0" ? "flame" : f.severity === "P1" ? "warning" : "info",
            f.severity === "P0" ? new vscode.ThemeColor("errorForeground") : undefined,
          );
          item.contextValue = "llmFinding";
          items.push(item);
        }
        if (f.article_quote) {
          add("Article quote", `"${f.article_quote}"`, "quote");
        }
        if (f.fact) {
          add("Correct info", f.fact, "verified");
        }
      }
    }

    add("Confidence", formatConfidence(r.confidence), "dashboard");
    if (r.ms_date) {
      const dateLabel = r.date_flag === "outside_range" ? `${r.ms_date} ⚠️ outside date range` : r.ms_date;
      add("Article Date (ms.date)", dateLabel, "calendar");
    }
    if (!r.llm_findings?.length) {
      // Only show generic reason/fix if there are no detailed LLM findings
      add("Reason", r.reason, "comment");
      add("Suggested Fix", r.suggested_fix, "lightbulb");
    }
    add("Evidence", r.evidence, "search");
    add("Regex Evidence", r.regex_evidence, "regex");
    add("Release Section", r.release_conflict_section, "bookmark");
    if (r.agrees_with_regex !== undefined) {
      add("Agrees with Regex", r.agrees_with_regex ? "Yes ✓" : "No ✗", r.agrees_with_regex ? "check" : "close");
    }

    if (r.regex_signals && r.regex_signals.length > 0) {
      const item = new ResultItem(
        "Regex Signals",
        "detail",
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = r.regex_signals.join(", ");
      item.tooltip = new vscode.MarkdownString(`**Regex Signals**\n\n${r.regex_signals.join(", ")}`);
      item.contextValue = "detail";
      item.iconPath = new vscode.ThemeIcon("regex");
      items.push(item);
    }

    if (items.length === 0) {
      const item = new ResultItem(
        "No additional details",
        "detail",
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon("dash");
      item.contextValue = "detail";
      items.push(item);
    }

    return items;
  }

  // ── Summary bar ────────────────────────────────────────────────────

  private updateSummaryMessage(): void {
    if (!this.treeView) { return; }
    const all = this.results;
    if (all.length === 0) {
      this.treeView.message = "No results loaded. Run a freshness check first.";
      return;
    }
    const outdated = all.filter((r) => r.classification === "P0_OUTDATED").length;
    const needsReview = all.filter((r) => r.classification === "NEEDS_CLARIFICATION").length;
    const triaged = Object.keys(this.triageState.decisions).filter((url) =>
      all.some((r) => r.url === url),
    ).length;
    const remaining = all.length - triaged;

    const parts: string[] = [];
    if (outdated > 0) { parts.push(`🔥 ${outdated} outdated`); }
    if (needsReview > 0) { parts.push(`⚠️ ${needsReview} needs review`); }
    if (parts.length === 0) { parts.push(`${all.length} results`); }
    if (triaged > 0) {
      parts.push(`(${triaged} triaged, ${remaining} remaining)`);
    }
    // Show total scanned including date-excluded and non-actionable
    if (this.meta) {
      const totalScanned = this.meta.total;
      const datePart = this.meta.date_excluded > 0 ? `, ${this.meta.date_excluded} date-excluded` : "";
      parts.push(`of ${totalScanned} scanned${datePart}`);
    }
    const scenarioNote = this.activeScenario ? ` [${this.activeScenario}]` : "";
    const filterNote = this.activeFilter ? ` (filtered: ${this.activeFilter})`
      : this.showUntriagedOnly ? " (untriaged only)" : "";
    this.treeView.message = parts.join(", ") + scenarioNote + filterNote;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private filteredResults(): PageResult[] {
    let results = this.results;
    if (this.activeFilter) {
      results = results.filter((r) => r.classification === this.activeFilter);
    }
    if (this.showUntriagedOnly) {
      results = results.filter((r) => !this.triageState.decisions[r.url]);
    }
    return results;
  }

  private loadResults(): void {
    this.triageState = loadTriageState(this.activeScenario);

    const outputDirs = this.getOutputDirs();

    // If a specific scenario is selected, load its results directly
    if (this.activeScenario) {
      const isLocal = this.activeScenario.endsWith(" (Local)");
      const dirName = isLocal ? this.activeScenario.replace(" (Local)", "") : this.activeScenario;
      for (const outputDir of outputDirs) {
        const jsonNames = isLocal
          ? ["classifications-local.json", "classifications.json"]
          : ["classifications.json", "classifications-local.json"];
        for (const jsonName of jsonNames) {
          const scenarioJson = path.join(outputDir, dirName, jsonName);
          if (fs.existsSync(scenarioJson)) {
            if (this.loadFromJson(scenarioJson)) {
              this.activeScenario = jsonName.includes("-local")
                ? `${dirName} (Local)`
                : dirName;
              return;
            }
          }
        }

        const csvNames = isLocal
          ? ["report-local.csv", "report.csv"]
          : ["report.csv", "report-local.csv"];
        for (const csvName of csvNames) {
          const scenarioCsv = path.join(outputDir, dirName, csvName);
          if (fs.existsSync(scenarioCsv)) {
            if (this.loadFromCsv(scenarioCsv)) {
              this.activeScenario = csvName.includes("-local")
                ? `${dirName} (Local)`
                : dirName;
              return;
            }
          }
        }
      }
    }

    // No active scenario — find the most recent results across all output dirs
    const jsonCandidates: string[] = [];
    const csvCandidates: string[] = [];
    for (const outputDir of outputDirs) {
      jsonCandidates.push(path.join(outputDir, "classifications.json"));
      jsonCandidates.push(path.join(outputDir, "classifications-local.json"));
      csvCandidates.push(path.join(outputDir, "report.csv"));
      csvCandidates.push(path.join(outputDir, "report-local.csv"));
      if (fs.existsSync(outputDir)) {
        try {
          for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              jsonCandidates.push(path.join(outputDir, entry.name, "classifications.json"));
              jsonCandidates.push(path.join(outputDir, entry.name, "classifications-local.json"));
              csvCandidates.push(path.join(outputDir, entry.name, "report.csv"));
              csvCandidates.push(path.join(outputDir, entry.name, "report-local.csv"));
            }
          }
        } catch { /* ignore */ }
      }
    }

    const resolveScenarioFromPath = (resultPath: string): string | undefined => {
      const parent = path.basename(path.dirname(resultPath));
      if (parent === "output") { return undefined; }
      const isLocal = path.basename(resultPath).includes("-local");
      return isLocal ? `${parent} (Local)` : parent;
    };

    const getNewestCandidates = (candidates: string[]): string[] => {
      return Array.from(new Set(candidates))
        .filter((candidate) => fs.existsSync(candidate))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    };

    const sortedJsonCandidates = getNewestCandidates(jsonCandidates);
    for (let i = 0; i < sortedJsonCandidates.length; i += 1) {
      const candidate = sortedJsonCandidates[i];
      const scenario = resolveScenarioFromPath(candidate);
      this.activeScenario = scenario;
      if (this.loadFromJson(candidate)) { return; }
      if (i === 0) {
        console.warn(`[docs-capacitor] Failed to parse newest JSON results candidate: ${candidate}. Trying older candidates.`);
      } else {
        console.warn(`[docs-capacitor] Failed to parse JSON results candidate: ${candidate}`);
      }
    }

    const sortedCsvCandidates = getNewestCandidates(csvCandidates);
    for (let i = 0; i < sortedCsvCandidates.length; i += 1) {
      const candidate = sortedCsvCandidates[i];
      const scenario = resolveScenarioFromPath(candidate);
      this.activeScenario = scenario;
      if (this.loadFromCsv(candidate)) { return; }
      if (i === 0) {
        console.warn(`[docs-capacitor] Failed to parse newest CSV results candidate: ${candidate}. Trying older candidates.`);
      } else {
        console.warn(`[docs-capacitor] Failed to parse CSV results candidate: ${candidate}`);
      }
    }

    this.results = [];
  }

  private loadFromJson(jsonPath: string): boolean {
    try {
      const raw = fs.readFileSync(jsonPath, "utf-8");
      const data: unknown = JSON.parse(raw);

      // Support both new {meta, results} format and legacy flat array
      let items: unknown[];
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const wrapper = data as Record<string, unknown>;
        items = Array.isArray(wrapper["results"]) ? wrapper["results"] as unknown[] : [];
        const m = wrapper["meta"] as Record<string, unknown> | undefined;
        if (m) {
          this.meta = {
            actionable: Number(m["actionable"] ?? 0),
            non_actionable: Number(m["non_actionable"] ?? 0),
            date_excluded: Number(m["date_excluded"] ?? 0),
            total: Number(m["total"] ?? 0),
          };
        }
      } else if (Array.isArray(data)) {
        items = data;
        this.meta = undefined;
      } else {
        return false;
      }

      this.results = items.map((item: unknown) => {
        const r = item as Record<string, unknown>;
        return {
          url: String(r["url"] ?? ""),
          title: r["title"] != null ? String(r["title"]) : undefined,
          classification: String(r["classification"] ?? "unknown"),
          confidence: r["confidence"] != null ? (typeof r["confidence"] === "string" ? String(r["confidence"]) : Number(r["confidence"])) : 0,
          topic: r["topic"] != null ? String(r["topic"]) : undefined,
          reason: r["reason"] != null ? String(r["reason"]) : undefined,
          suggested_fix: r["suggested_fix"] != null ? String(r["suggested_fix"]) : undefined,
          evidence: r["evidence"] != null ? String(r["evidence"]) : undefined,
          regex_evidence: r["regex_evidence"] != null ? String(r["regex_evidence"]) : undefined,
          regex_signals: Array.isArray(r["regex_signals"])
            ? (r["regex_signals"] as unknown[]).map(String)
            : undefined,
          regex_signal: r["regex_signal"] != null ? String(r["regex_signal"]) : undefined,
          release_conflict_section: r["release_conflict_section"] != null ? String(r["release_conflict_section"]) : undefined,
          agrees_with_regex: r["agrees_with_regex"] != null ? Boolean(r["agrees_with_regex"]) : undefined,
          repo: r["repo"] != null ? String(r["repo"]) : undefined,
          llm_findings: Array.isArray(r["llm_findings"])
            ? (r["llm_findings"] as Array<Record<string, unknown>>).map((f) => ({
                title: f["title"] != null ? String(f["title"]) : undefined,
                conflict: f["conflict"] != null ? String(f["conflict"]) : undefined,
                article_quote: f["article_quote"] != null ? String(f["article_quote"]) : undefined,
                fact: f["fact"] != null ? String(f["fact"]) : undefined,
                severity: f["severity"] != null ? String(f["severity"]) : undefined,
              }))
            : undefined,
          ms_date: r["ms_date"] != null ? String(r["ms_date"]) : undefined,
          date_flag: r["date_flag"] != null ? String(r["date_flag"]) : undefined,
        };
      });
      return true;
    } catch { /* fall through */ }
    return false;
  }

  private loadFromCsv(csvPath: string): boolean {
    try {
      const lines = fs.readFileSync(csvPath, "utf-8").split(/\r?\n/).filter(Boolean);
      const header = this.parseCsvLine(lines[0]).map((h) => h.trim().replace(/^\uFEFF/, ""));
      const headerIndex = new Map<string, number>();
      header.forEach((name, idx) => {
        headerIndex.set(name.toLowerCase(), idx);
      });

      const getVal = (cols: string[], ...names: string[]): string => {
        for (const name of names) {
          const idx = headerIndex.get(name.toLowerCase());
          if (idx !== undefined) {
            return cols[idx] ?? "";
          }
        }
        return "";
      };

      this.meta = undefined;
      this.results = lines.slice(1).map((line) => {
        const cols = this.parseCsvLine(line).map((c) => c.trim());
        const rawConfidence = getVal(cols, "confidence");
        const numericConfidence = Number(rawConfidence);
        const confidence: number | string =
          rawConfidence.length === 0
            ? 0
            : Number.isFinite(numericConfidence)
              ? numericConfidence
              : rawConfidence;
        const rawAgrees = getVal(cols, "agrees_with_regex").toLowerCase();

        return {
          url: getVal(cols, "url", "page_url"),
          title: getVal(cols, "title") || undefined,
          classification: getVal(cols, "classification") || "unknown",
          confidence,
          topic: getVal(cols, "release_conflict_topic_title", "topic") || undefined,
          reason: getVal(cols, "reason") || undefined,
          suggested_fix: getVal(cols, "suggested_fix") || undefined,
          evidence: getVal(cols, "evidence") || undefined,
          regex_evidence: getVal(cols, "regex_evidence") || undefined,
          regex_signal: getVal(cols, "regex_signal") || undefined,
          regex_signals: getVal(cols, "regex_rule_ids")
            .split(" | ")
            .map((s) => s.trim())
            .filter(Boolean),
          release_conflict_section: getVal(cols, "release_conflict_section") || undefined,
          agrees_with_regex: rawAgrees
            ? ["true", "1", "yes", "y"].includes(rawAgrees)
            : undefined,
          repo: getVal(cols, "repo") || undefined,
        };
      });
      return true;
    } catch { /* ignore */ }
    return false;
  }

  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          current += "\"";
          i += 1;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === "," && !inQuotes) {
        fields.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    fields.push(current);
    return fields;
  }
}
