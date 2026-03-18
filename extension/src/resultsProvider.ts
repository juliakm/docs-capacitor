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

  constructor() {
    this.loadResults();
  }

  /** Bind the tree view so we can update its message (summary bar). */
  setTreeView(view: vscode.TreeView<ResultItem>): void {
    this.treeView = view;
    this.updateSummaryMessage();
  }

  /** Load results for a specific scenario and refresh the tree. */
  loadScenario(scenarioName: string): void {
    this.activeScenario = scenarioName;
    this.loadResults();
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
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

  /** Return all scenario names that have results in the output directory. */
  getAvailableScenarios(): string[] {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return []; }
    const outputDir = path.join(workspaceRoot, "output");
    if (!fs.existsSync(outputDir)) { return []; }
    const scenarios: string[] = [];
    try {
      for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const jsonPath = path.join(outputDir, entry.name, "classifications.json");
          if (fs.existsSync(jsonPath)) {
            scenarios.push(entry.name);
          }
          const localJsonPath = path.join(outputDir, entry.name, "classifications-local.json");
          if (fs.existsSync(localJsonPath)) {
            scenarios.push(entry.name + " (Local)");
          }
        }
      }
    } catch { /* ignore */ }
    return scenarios;
  }

  /** Get the path to the active report CSV file, if it exists. */
  getActiveReportPath(): string | undefined {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot || !this.activeScenario) { return undefined; }
    const isLocal = this.activeScenario.endsWith(" (Local)");
    const dirName = isLocal ? this.activeScenario.replace(" (Local)", "") : this.activeScenario;
    const suffix = isLocal ? "-local" : "";
    const csvPath = path.join(workspaceRoot, "output", dirName, `report${suffix}.csv`);
    return fs.existsSync(csvPath) ? csvPath : undefined;
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

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.results = [];
      return;
    }

    const outputDir = path.join(workspaceRoot, "output");

    // If a specific scenario is selected, load its results directly
    if (this.activeScenario) {
      const isLocal = this.activeScenario.endsWith(" (Local)");
      const dirName = isLocal ? this.activeScenario.replace(" (Local)", "") : this.activeScenario;
      const suffix = isLocal ? "-local" : "";
      const scenarioJson = path.join(outputDir, dirName, `classifications${suffix}.json`);
      if (fs.existsSync(scenarioJson)) {
        if (this.loadFromJson(scenarioJson)) { return; }
      }
      const scenarioCsv = path.join(outputDir, dirName, `report${suffix}.csv`);
      if (fs.existsSync(scenarioCsv)) {
        if (this.loadFromCsv(scenarioCsv)) { return; }
      }
    }

    // No active scenario — find the most recent results across all scenario subdirs
    const jsonCandidates: string[] = [];
    // Legacy: top-level output/classifications.json
    jsonCandidates.push(path.join(outputDir, "classifications.json"));
    if (fs.existsSync(outputDir)) {
      try {
        for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            jsonCandidates.push(path.join(outputDir, entry.name, "classifications.json"));
          }
        }
      } catch { /* ignore */ }
    }

    // Use the most recently modified classifications.json
    let jsonPath: string | undefined;
    let latestMtime = 0;
    for (const candidate of jsonCandidates) {
      if (fs.existsSync(candidate)) {
        const mtime = fs.statSync(candidate).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          jsonPath = candidate;
        }
      }
    }

    if (jsonPath) {
      // Infer the active scenario from the path
      const parent = path.basename(path.dirname(jsonPath));
      if (parent !== "output") {
        this.activeScenario = parent;
      }
      if (this.loadFromJson(jsonPath)) { return; }
    }

    // Fallback: legacy report.csv
    const csvPath = path.join(outputDir, "report.csv");
    if (fs.existsSync(csvPath)) {
      if (this.loadFromCsv(csvPath)) { return; }
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
      const lines = fs.readFileSync(csvPath, "utf-8").split("\n").filter(Boolean);
      const header = lines[0].split(",");
      const urlIdx = header.indexOf("url");
      const classIdx = header.indexOf("classification");
      const confIdx = header.indexOf("confidence");
      this.results = lines.slice(1).map((line) => {
        const cols = line.split(",");
        return {
          url: cols[urlIdx] ?? "",
          classification: cols[classIdx] ?? "unknown",
          confidence: Number(cols[confIdx] ?? 0),
        };
      });
      return true;
    } catch { /* ignore */ }
    return false;
  }
}
