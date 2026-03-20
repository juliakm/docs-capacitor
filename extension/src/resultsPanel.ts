import * as vscode from "vscode";
import { PageResult, LlmFinding, TriageState, TriageDecision } from "./resultsProvider";

export { PageResult, LlmFinding, TriageState, TriageDecision };

/**
 * Singleton webview panel that displays freshness-check results
 * in a rich, filterable HTML table inside the main editor area.
 */
export class ResultsPanel {
  public static readonly viewType = "docsCapacitor.resultsPanel";

  private static instance: ResultsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private results: PageResult[];
  private scenarioName: string;
  private triageState: TriageState;

  /** Optional callback when triage actions occur in the panel. */
  public static onTriageCallback?: (url: string, decision: TriageDecision) => void;

  /** Show the results panel (reuses existing panel when possible). */
  public static createOrShow(
    extensionUri: vscode.Uri,
    results: PageResult[],
    scenarioName: string,
    triageState: TriageState,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ResultsPanel.instance) {
      ResultsPanel.instance.results = results;
      ResultsPanel.instance.scenarioName = scenarioName;
      ResultsPanel.instance.triageState = triageState;
      // Force fresh HTML to pick up any code changes
      ResultsPanel.instance.panel.webview.html = ResultsPanel.instance.getHtml();
      ResultsPanel.instance.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ResultsPanel.viewType,
      `Results: ${scenarioName}`,
      column,
      { enableScripts: true },
    );

    ResultsPanel.instance = new ResultsPanel(panel, extensionUri, results, scenarioName, triageState);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    results: PageResult[],
    scenarioName: string,
    triageState: TriageState,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.results = results;
    this.scenarioName = scenarioName;
    this.triageState = triageState;

    this.panel.webview.onDidReceiveMessage(
      (msg: { command: string; url?: string; decision?: TriageDecision }) => {
        switch (msg.command) {
          case "ready":
            this.pushResults();
            break;
          case "triage":
            if (msg.url && msg.decision) {
              this.handleTriage(msg.url, msg.decision);
            }
            break;
          case "openUrl":
            if (msg.url) {
              vscode.env.openExternal(vscode.Uri.parse(msg.url));
            }
            break;
          case "copyUrl":
            if (msg.url) {
              vscode.env.clipboard.writeText(msg.url);
              vscode.window.showInformationMessage("URL copied to clipboard.");
            }
            break;
        }
      },
      null,
      this.disposables,
    );

    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private dispose(): void {
    ResultsPanel.instance = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
  }

  private handleTriage(url: string, decision: TriageDecision): void {
    this.triageState.decisions[url] = decision;
    this.panel.webview.postMessage({ command: "updateTriage", url, decision });
    ResultsPanel.onTriageCallback?.(url, decision);
  }

  private pushResults(): void {
    this.panel.webview.postMessage({
      command: "setResults",
      results: this.results,
      scenarioName: this.scenarioName,
      triageState: this.triageState,
    });
  }

  // ── HTML ──────────────────────────────────────────────────────────────

  public getHtml(): string {
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Freshness Results</title>
  <style nonce="${nonce}">
    :root { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); }
    * { box-sizing: border-box; }
    body { padding: 0 16px 16px; margin: 0; background: var(--vscode-editor-background); }

    /* ── summary bar ─────────────────────────────────── */
    .summary-bar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
      padding: 10px 0; border-bottom: 1px solid var(--vscode-widget-border, #444);
      margin-bottom: 10px;
    }
    .summary-bar h2 { margin: 0; font-size: 14px; font-weight: 600; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 12px; font-weight: 600; color: #fff;
    }
    .badge-p0        { background: #f44336; }
    .badge-needs     { background: #ff9800; }
    .badge-uptodate  { background: #4caf50; }
    .badge-excluded  { background: #9e9e9e; }
    .badge-total     { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

    /* ── filter bar ──────────────────────────────────── */
    .filter-bar {
      display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
      padding: 8px 0; margin-bottom: 6px;
    }
    .filter-bar label { font-size: 12px; font-weight: 600; margin-right: 2px; }
    .filter-bar select, .filter-bar input {
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555); border-radius: 3px;
      padding: 4px 6px; font-size: 12px; font-family: inherit;
    }
    .filter-bar input { width: 200px; }
    .showing-count { font-size: 12px; margin-left: auto; opacity: 0.8; }

    /* ── table ────────────────────────────────────────── */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead th {
      position: sticky; top: 0; z-index: 2;
      text-align: left; padding: 6px 8px; cursor: pointer; user-select: none;
      background: var(--vscode-editor-background);
      border-bottom: 2px solid var(--vscode-widget-border, #444);
      font-weight: 600; font-size: 12px; white-space: nowrap;
    }
    thead th:hover { color: var(--vscode-textLink-foreground); }
    thead th .sort-arrow { font-size: 10px; margin-left: 4px; }
    tbody tr { cursor: pointer; border-bottom: 1px solid var(--vscode-widget-border, #333); }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody td { padding: 6px 8px; vertical-align: top; }

    /* classification badge in table */
    .cls-badge {
      display: inline-block; padding: 1px 7px; border-radius: 8px;
      font-size: 11px; font-weight: 600; color: #fff; white-space: nowrap;
    }
    .cls-P0_OUTDATED          { background: #f44336; }
    .cls-NEEDS_CLARIFICATION  { background: #ff9800; }
    .cls-UP_TO_DATE           { background: #4caf50; }
    .cls-EXCLUDED             { background: #9e9e9e; }

    /* article cell */
    .article-title { font-weight: 500; }
    .article-url   { font-size: 11px; opacity: 0.65; word-break: break-all; }

    /* triage buttons */
    .triage-btn {
      border: none; border-radius: 3px; padding: 2px 7px; font-size: 12px;
      cursor: pointer; margin-right: 3px;
      background: var(--vscode-button-secondaryBackground, #3a3a3a);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .triage-btn:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .triage-btn.active-valid          { background: #4caf50; color: #fff; }
    .triage-btn.active-false_positive { background: #ff9800; color: #fff; }
    .triage-btn.active-ignore_repo    { background: #9e9e9e; color: #fff; }

    /* expanded detail row */
    .detail-row td { padding: 8px 16px 12px; background: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e); }
    .detail-row .detail-section { margin-bottom: 8px; }
    .detail-row .detail-label  { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
    .detail-row .detail-value  { font-size: 12px; white-space: pre-wrap; }
    .detail-row .llm-card {
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
      padding: 4px 10px; margin: 4px 0; background: var(--vscode-editor-background);
      border-radius: 0 4px 4px 0;
    }
    .detail-row .llm-card .llm-title { font-weight: 600; font-size: 12px; }
    .detail-row .llm-card .llm-field { font-size: 12px; opacity: 0.85; margin-top: 2px; }
    .action-link {
      font-size: 12px; color: var(--vscode-textLink-foreground); cursor: pointer;
      text-decoration: underline; margin-right: 10px;
    }

    .hidden { display: none; }
  </style>
</head>
<body>

  <!-- summary -->
  <div class="summary-bar" id="summaryBar"></div>

  <!-- filters -->
  <div class="filter-bar">
    <label>Classification:</label>
    <select id="filterClass">
      <option value="">All</option>
      <option value="P0_OUTDATED">P0_OUTDATED</option>
      <option value="NEEDS_CLARIFICATION">NEEDS_CLARIFICATION</option>
      <option value="UP_TO_DATE">UP_TO_DATE</option>
      <option value="EXCLUDED">EXCLUDED</option>
    </select>

    <label>Repo:</label>
    <select id="filterRepo"><option value="">All</option></select>

    <label>Source:</label>
    <select id="filterSource">
      <option value="">All</option>
      <option value="Regex">Regex</option>
      <option value="LLM">LLM</option>
      <option value="Both">Both</option>
      <option value="—">None</option>
    </select>

    <label>Triage:</label>
    <select id="filterTriage">
      <option value="">All</option>
      <option value="untriaged">Untriaged</option>
      <option value="valid">Valid</option>
      <option value="false_positive">False Positive</option>
      <option value="ignore_repo">Ignored</option>
    </select>

    <label>Search:</label>
    <input id="filterSearch" type="text" placeholder="URL, title, reason, evidence…" />

    <span class="showing-count" id="showingCount"></span>
  </div>

  <!-- table -->
  <table>
    <thead>
      <tr>
        <th data-col="classification">Status <span class="sort-arrow"></span></th>
        <th data-col="title">Article <span class="sort-arrow"></span></th>
        <th data-col="repo">Repo <span class="sort-arrow"></span></th>
        <th data-col="source">Source <span class="sort-arrow"></span></th>
        <th data-col="severity">Severity <span class="sort-arrow"></span></th>
        <th data-col="triage">Triage</th>
      </tr>
    </thead>
    <tbody id="resultsBody"></tbody>
  </table>

  <script nonce="${nonce}">
  (function () {
    var vscode = acquireVsCodeApi();

    var allResults = [];
    var scenarioName = '';
    var triageState = { decisions: {}, ignored_repos: [] };
    var sortCol = 'classification';
    var sortAsc = true;
    var expandedUrl = null;

    function showHydrationError(message) {
      var bar = document.getElementById('summaryBar');
      bar.innerHTML = '<span class="badge badge-p0">Data load failed</span><span>' + escHtml(message) + '</span>';
      document.getElementById('showingCount').textContent = '';
      document.getElementById('resultsBody').innerHTML = '';
    }

    // ── helpers ───────────────────────────────────────────
    function getSource(r) {
      var hasRegex = r.regex_signal && r.regex_signal !== 'none' && r.regex_signal !== 'EXCLUDED';
      var hasLlm = r.llm_findings && r.llm_findings.length > 0;
      if (hasRegex && hasLlm) return 'Both';
      if (hasRegex) return 'Regex';
      if (hasLlm) return 'LLM';
      return '\\u2014';
    }

    function repoFromUrl(url) {
      if (typeof url !== 'string') return '';
      var m = url.match(/github\\.com\\/([^/]+\\/[^/]+)/);
      if (m) return m[1];
      if (/learn\\.microsoft\\.com/.test(url)) return 'Microsoft Learn';
      return '';
    }

    function titleFromUrl(url) {
      try {
        var p = new URL(url).pathname;
        var seg = p.split('/').filter(Boolean).pop() || '';
        return seg.replace(/-/g, ' ').replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
      } catch (e) { return url; }
    }

    function shortenUrl(url) {
      try {
        var u = new URL(url);
        var p = u.pathname.length > 60 ? '\\u2026' + u.pathname.slice(-55) : u.pathname;
        return u.host + p;
      } catch (e) { return url; }
    }

    function severity(r) {
      if (r.regex_signal && r.regex_signal !== 'none' && r.regex_signal !== 'EXCLUDED') return r.regex_signal;
      if (r.llm_findings) {
        for (var i = 0; i < r.llm_findings.length; i++) {
          if (r.llm_findings[i].severity) return r.llm_findings[i].severity;
        }
      }
      return '';
    }

    function escHtml(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function triageOf(url) {
      if (!triageState || !triageState.decisions || typeof triageState.decisions !== 'object') {
        return 'untriaged';
      }
      return triageState.decisions[url] || 'untriaged';
    }

    function normalizeResult(item) {
      var r = item && typeof item === 'object' ? item : {};
      var url = typeof r.url === 'string' ? r.url : String(r.url || '');
      return {
        url: url,
        title: r.title != null ? String(r.title) : '',
        classification: r.classification != null ? String(r.classification) : '',
        confidence: r.confidence,
        topic: r.topic,
        reason: r.reason != null ? String(r.reason) : '',
        suggested_fix: r.suggested_fix != null ? String(r.suggested_fix) : '',
        evidence: r.evidence != null ? String(r.evidence) : '',
        regex_evidence: r.regex_evidence != null ? String(r.regex_evidence) : '',
        regex_signals: Array.isArray(r.regex_signals) ? r.regex_signals : [],
        regex_signal: r.regex_signal != null ? String(r.regex_signal) : '',
        release_conflict_section: r.release_conflict_section != null ? String(r.release_conflict_section) : '',
        agrees_with_regex: r.agrees_with_regex,
        repo: r.repo != null ? String(r.repo) : '',
        llm_findings: Array.isArray(r.llm_findings) ? r.llm_findings : [],
        ms_date: r.ms_date,
        date_flag: r.date_flag,
      };
    }

    var classOrder = { 'P0_OUTDATED': 0, 'NEEDS_CLARIFICATION': 1, 'UP_TO_DATE': 2, 'EXCLUDED': 3 };

    // ── render ────────────────────────────────────────────
    function renderSummary() {
      var counts = { P0_OUTDATED: 0, NEEDS_CLARIFICATION: 0, UP_TO_DATE: 0, EXCLUDED: 0 };
      for (var i = 0; i < allResults.length; i++) {
        if (counts[allResults[i].classification] !== undefined) counts[allResults[i].classification]++;
      }
      var total = allResults.length;
      document.getElementById('summaryBar').innerHTML =
        '<h2>' + escHtml(scenarioName) + '</h2>' +
        '<span class="badge badge-total">Total: ' + total + '</span>' +
        '<span class="badge badge-p0">P0: ' + counts.P0_OUTDATED + '</span>' +
        '<span class="badge badge-needs">Review: ' + counts.NEEDS_CLARIFICATION + '</span>' +
        '<span class="badge badge-uptodate">OK: ' + counts.UP_TO_DATE + '</span>' +
        '<span class="badge badge-excluded">Excl: ' + counts.EXCLUDED + '</span>';
    }

    function populateRepoFilter() {
      var repos = {};
      for (var i = 0; i < allResults.length; i++) {
        var rp = allResults[i].repo || repoFromUrl(allResults[i].url);
        if (rp) repos[rp] = true;
      }
      var sel = document.getElementById('filterRepo');
      var sorted = Object.keys(repos).sort();
      var opts = '<option value="">All</option>';
      for (var j = 0; j < sorted.length; j++) {
        opts += '<option value="' + escHtml(sorted[j]) + '">' + escHtml(sorted[j]) + '</option>';
      }
      sel.innerHTML = opts;
    }

    function filtered() {
      var fc = document.getElementById('filterClass').value;
      var fr = document.getElementById('filterRepo').value;
      var fs = document.getElementById('filterSource').value;
      var ft = document.getElementById('filterTriage').value;
      var fq = document.getElementById('filterSearch').value.toLowerCase();

      var out = [];
      for (var i = 0; i < allResults.length; i++) {
        var r = allResults[i];
        if (fc && r.classification !== fc) continue;
        var repo = r.repo || repoFromUrl(r.url);
        if (fr && repo !== fr) continue;
        var src = getSource(r);
        if (fs && src !== fs) continue;
        var tri = triageOf(r.url);
        if (ft && tri !== ft) continue;
        if (fq) {
          var haystack = [r.url, r.title, r.reason, r.evidence, r.regex_evidence, r.suggested_fix]
            .filter(Boolean).join(' ').toLowerCase();
          if (haystack.indexOf(fq) === -1) continue;
        }
        out.push(r);
      }
      return out;
    }

    function sortedRows(rows) {
      return rows.slice().sort(function(a, b) {
        var va, vb;
        switch (sortCol) {
          case 'classification':
            va = classOrder[a.classification] !== undefined ? classOrder[a.classification] : 99;
            vb = classOrder[b.classification] !== undefined ? classOrder[b.classification] : 99;
            break;
          case 'title':
            va = (a.title || titleFromUrl(a.url)).toLowerCase();
            vb = (b.title || titleFromUrl(b.url)).toLowerCase();
            break;
          case 'repo':
            va = (a.repo || repoFromUrl(a.url)).toLowerCase();
            vb = (b.repo || repoFromUrl(b.url)).toLowerCase();
            break;
          case 'source':
            va = getSource(a); vb = getSource(b); break;
          case 'severity':
            va = severity(a); vb = severity(b); break;
          default:
            va = ''; vb = '';
        }
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
      });
    }

    function renderTable() {
      try {
        var filt = filtered();
        var rows = sortedRows(filt);
        document.getElementById('showingCount').textContent =
          'Showing ' + rows.length + ' of ' + allResults.length;

        var tbody = document.getElementById('resultsBody');
        var html = '';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var cls = r.classification || '';
          var title = escHtml(r.title || titleFromUrl(r.url));
          var urlShort = escHtml(shortenUrl(r.url));
          var repo = escHtml(r.repo || repoFromUrl(r.url));
          var src = escHtml(getSource(r));
          var sev = escHtml(severity(r));
          var tri = triageOf(r.url);
          var expanded = expandedUrl === r.url;

          html += '<tr data-url="' + escHtml(r.url) + '">' +
            '<td><span class="cls-badge cls-' + escHtml(cls) + '">' + escHtml(cls) + '</span></td>' +
            '<td><div class="article-title">' + title + '</div><div class="article-url">' + urlShort + '</div></td>' +
            '<td>' + repo + '</td>' +
            '<td>' + src + '</td>' +
            '<td>' + sev + '</td>' +
            '<td>' + triageButtons(r.url, tri) + '</td>' +
            '</tr>';

          if (expanded) {
            html += detailRow(r);
          }
        }
        tbody.innerHTML = html;
      } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        showHydrationError('Render error: ' + msg);
        console.error('[DocsCapacitor] Render error:', e);
      }
    }

    function triageButtons(url, current) {
      var safeUrl = escHtml(url);
      return '<button class="triage-btn' + (current === 'valid' ? ' active-valid' : '') +
             '" data-triage="valid" data-url="' + safeUrl + '" title="Valid">\\u2713</button>' +
             '<button class="triage-btn' + (current === 'false_positive' ? ' active-false_positive' : '') +
             '" data-triage="false_positive" data-url="' + safeUrl + '" title="False Positive">\\u2717</button>' +
             '<button class="triage-btn' + (current === 'ignore_repo' ? ' active-ignore_repo' : '') +
             '" data-triage="ignore_repo" data-url="' + safeUrl + '" title="Ignore Repo">\\u26D4</button>';
    }

    function detailRow(r) {
      var inner = '';
      if (r.reason) inner += detailSection('Reason', r.reason);
      if (r.evidence) inner += detailSection('Evidence', r.evidence);
      if (r.regex_evidence) inner += detailSection('Regex Evidence', r.regex_evidence);
      if (r.release_conflict_section) inner += detailSection('Release Conflict', r.release_conflict_section);
      if (r.llm_findings && r.llm_findings.length) {
        inner += '<div class="detail-section"><div class="detail-label">LLM Findings</div>';
        for (var fi = 0; fi < r.llm_findings.length; fi++) {
          var f = r.llm_findings[fi];
          inner += '<div class="llm-card">';
          if (f.title) inner += '<div class="llm-title">' + escHtml(f.title) + '</div>';
          if (f.conflict) inner += '<div class="llm-field"><strong>Conflict:</strong> ' + escHtml(f.conflict) + '</div>';
          if (f.article_quote) inner += '<div class="llm-field"><strong>Quote:</strong> ' + escHtml(f.article_quote) + '</div>';
          if (f.fact) inner += '<div class="llm-field"><strong>Fact:</strong> ' + escHtml(f.fact) + '</div>';
          if (f.severity) inner += '<div class="llm-field"><strong>Severity:</strong> ' + escHtml(f.severity) + '</div>';
          inner += '</div>';
        }
        inner += '</div>';
      }
      if (r.suggested_fix) inner += detailSection('Suggested Fix', r.suggested_fix);
      inner += '<span class="action-link" data-action="open" data-url="' + escHtml(r.url) + '">Open in browser</span>';
      inner += '<span class="action-link" data-action="copy" data-url="' + escHtml(r.url) + '">Copy URL</span>';
      return '<tr class="detail-row"><td colspan="6">' + inner + '</td></tr>';
    }

    function detailSection(label, value) {
      return '<div class="detail-section"><div class="detail-label">' +
        escHtml(label) + '</div><div class="detail-value">' + escHtml(value) + '</div></div>';
    }

    // ── sort headers ──────────────────────────────────────
    var thList = document.querySelectorAll('thead th[data-col]');
    for (var ti = 0; ti < thList.length; ti++) {
      (function(th) {
        th.addEventListener('click', function() {
          var col = th.getAttribute('data-col');
          if (col === sortCol) { sortAsc = !sortAsc; }
          else { sortCol = col; sortAsc = true; }
          updateSortArrows();
          renderTable();
        });
      })(thList[ti]);
    }

    function updateSortArrows() {
      var ths = document.querySelectorAll('thead th[data-col]');
      for (var ui = 0; ui < ths.length; ui++) {
        var arrow = ths[ui].querySelector('.sort-arrow');
        if (!arrow) continue;
        if (ths[ui].getAttribute('data-col') === sortCol) {
          arrow.textContent = sortAsc ? '\\u25B2' : '\\u25BC';
        } else {
          arrow.textContent = '';
        }
      }
    }

    // ── filter events ─────────────────────────────────────
    var filterIds = ['filterClass', 'filterRepo', 'filterSource', 'filterTriage'];
    for (var fi2 = 0; fi2 < filterIds.length; fi2++) {
      document.getElementById(filterIds[fi2]).addEventListener('change', function() { renderTable(); });
    }
    var searchTimer = 0;
    document.getElementById('filterSearch').addEventListener('input', function() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function() { renderTable(); }, 200);
    });

    // ── table clicks (expand/triage/action links) ─────────
    document.getElementById('resultsBody').addEventListener('click', function(e) {
      var target = e.target;

      // triage button
      if (target.classList && target.classList.contains('triage-btn')) {
        e.stopPropagation();
        var url = target.getAttribute('data-url');
        var decision = target.getAttribute('data-triage');
        vscode.postMessage({ command: 'triage', url: url, decision: decision });
        triageState.decisions[url] = decision;
        renderTable();
        return;
      }

      // action links in detail row
      if (target.classList && target.classList.contains('action-link')) {
        e.stopPropagation();
        var action = target.getAttribute('data-action');
        var aUrl = target.getAttribute('data-url');
        if (action === 'open') vscode.postMessage({ command: 'openUrl', url: aUrl });
        if (action === 'copy') vscode.postMessage({ command: 'copyUrl', url: aUrl });
        return;
      }

      // row expand/collapse
      var tr = target;
      while (tr && tr.tagName !== 'TR') tr = tr.parentElement;
      if (!tr || tr.classList.contains('detail-row')) return;
      var rowUrl = tr.getAttribute('data-url');
      expandedUrl = (expandedUrl === rowUrl) ? null : rowUrl;
      renderTable();
    });

    // ── messages from extension (refresh & triage updates) ─
    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch (msg.command) {
        case 'setResults':
          if (!msg || !Array.isArray(msg.results)) {
            showHydrationError('Results payload is invalid. Reopen the panel after running a freshness check.');
            return;
          }
          allResults = msg.results.map(normalizeResult);
          scenarioName = msg.scenarioName || '';
          triageState = (msg.triageState && typeof msg.triageState === 'object')
            ? msg.triageState
            : { decisions: {}, ignored_repos: [] };
          renderSummary();
          populateRepoFilter();
          updateSortArrows();
          renderTable();
          break;
        case 'updateTriage':
          triageState.decisions[msg.url] = msg.decision;
          renderTable();
          break;
      }
    });

    // Ask extension host to send deterministic panel data after script is ready.
    vscode.postMessage({ command: 'ready' });
  })();
  </script>
</body>
</html>`;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
