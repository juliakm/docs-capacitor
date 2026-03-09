import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// ── Interfaces ───────────────────────────────────────────────────────

/** A single page result from the freshness pipeline. */
export interface PageResult {
  url: string;
  title?: string;
  classification: string;
  confidence: number;
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

// ── Reviewed state persistence ───────────────────────────────────────

function reviewedFilePath(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { return undefined; }
  return path.join(root, "output", ".capacitor-reviewed.json");
}

function loadReviewed(): Set<string> {
  const fp = reviewedFilePath();
  if (!fp || !fs.existsSync(fp)) { return new Set(); }
  try {
    const data: unknown = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (Array.isArray(data)) { return new Set(data.map(String)); }
  } catch { /* ignore */ }
  return new Set();
}

function saveReviewed(urls: Set<string>): void {
  const fp = reviewedFilePath();
  if (!fp) { return; }
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(fp, JSON.stringify([...urls], null, 2));
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
  private reviewed: Set<string> = new Set();
  private activeFilter: string | undefined;
  private treeView: vscode.TreeView<ResultItem> | undefined;

  constructor() {
    this.loadResults();
  }

  /** Bind the tree view so we can update its message (summary bar). */
  setTreeView(view: vscode.TreeView<ResultItem>): void {
    this.treeView = view;
    this.updateSummaryMessage();
  }

  /** Reload data from disk and refresh the tree. */
  refresh(): void {
    this.loadResults();
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
  }

  /** Set a classification filter (undefined = show all). */
  setFilter(classification: string | undefined): void {
    this.activeFilter = classification;
    this._onDidChangeTreeData.fire();
    this.updateSummaryMessage();
  }

  /** Mark a URL as reviewed and persist. */
  markReviewed(url: string): void {
    this.reviewed.add(url);
    saveReviewed(this.reviewed);
    this._onDidChangeTreeData.fire();
  }

  /** Check if a URL has been reviewed. */
  isReviewed(url: string): boolean {
    return this.reviewed.has(url);
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
        const reviewed = this.reviewed.has(r.url);
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
        item.description = parts.join(" · ");
        item.tooltip = new vscode.MarkdownString(
          `**${displayTitle}**\n\n${r.url}\n\nClassification: ${r.classification}  \nConfidence: ${(r.confidence * 100).toFixed(0)}%` +
          (r.topic ? `  \nTopic: ${r.topic}` : "") +
          (r.reason ? `  \nReason: ${r.reason}` : "") +
          (r.suggested_fix ? `  \nFix: ${r.suggested_fix}` : "") +
          (reviewed ? "\n\n✅ _Reviewed_" : ""),
        );
        item.iconPath = reviewed
          ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("disabledForeground"))
          : classificationIcon(classification);
        item.contextValue = reviewed ? "pageReviewed" : "page";
        item.command = {
          command: "docs-capacitor.openResultUrl",
          title: "Open URL",
          arguments: [r.url],
        };
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

    add("Confidence", `${(r.confidence * 100).toFixed(0)}%`, "dashboard");
    add("Reason", r.reason, "comment");
    add("Suggested Fix", r.suggested_fix, "lightbulb");
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
    const upToDate = all.filter((r) => r.classification === "UP_TO_DATE").length;
    const parts: string[] = [];
    if (outdated > 0) { parts.push(`${outdated} outdated`); }
    if (needsReview > 0) { parts.push(`${needsReview} needs review`); }
    if (upToDate > 0) { parts.push(`${upToDate} up to date`); }
    if (parts.length === 0) { parts.push(`${all.length} results`); }
    const filterNote = this.activeFilter ? ` (filtered: ${this.activeFilter})` : "";
    this.treeView.message = parts.join(", ") + filterNote;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private filteredResults(): PageResult[] {
    if (!this.activeFilter) { return this.results; }
    return this.results.filter((r) => r.classification === this.activeFilter);
  }

  private loadResults(): void {
    this.reviewed = loadReviewed();

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.results = [];
      return;
    }

    // Prefer classifications.json — check output/ and output/*/ subdirectories
    const outputDir = path.join(workspaceRoot, "output");
    const jsonCandidates = [path.join(outputDir, "classifications.json")];
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
      try {
        const raw = fs.readFileSync(jsonPath, "utf-8");
        const data: unknown = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.results = data.map((item: Record<string, unknown>) => ({
            url: String(item["url"] ?? ""),
            title: item["title"] != null ? String(item["title"]) : undefined,
            classification: String(item["classification"] ?? "unknown"),
            confidence: Number(item["confidence"] ?? 0),
            topic: item["topic"] != null ? String(item["topic"]) : undefined,
            reason: item["reason"] != null ? String(item["reason"]) : undefined,
            suggested_fix: item["suggested_fix"] != null ? String(item["suggested_fix"]) : undefined,
            evidence: item["evidence"] != null ? String(item["evidence"]) : undefined,
            regex_evidence: item["regex_evidence"] != null ? String(item["regex_evidence"]) : undefined,
            regex_signals: Array.isArray(item["regex_signals"])
              ? (item["regex_signals"] as unknown[]).map(String)
              : undefined,
            regex_signal: item["regex_signal"] != null ? String(item["regex_signal"]) : undefined,
            release_conflict_section: item["release_conflict_section"] != null ? String(item["release_conflict_section"]) : undefined,
            agrees_with_regex: item["agrees_with_regex"] != null ? Boolean(item["agrees_with_regex"]) : undefined,
            repo: item["repo"] != null ? String(item["repo"]) : undefined,
          }));
        }
        return;
      } catch {
        // fall through to CSV
      }
    }

    // Fallback: report.csv
    const csvPath = path.join(workspaceRoot, "output", "report.csv");
    if (fs.existsSync(csvPath)) {
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
        return;
      } catch {
        // ignore
      }
    }

    this.results = [];
  }
}
