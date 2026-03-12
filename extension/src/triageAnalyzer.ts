import { PageResult, TriageState, TriageDecision } from "./resultsProvider";

// ── Interfaces ───────────────────────────────────────────────────────

export interface TriageSuggestion {
  id: string;
  type: "exclude_repo" | "url_exclusion" | "content_exclusion" | "remove_allowed_repo";
  description: string;
  yamlFile: "scenario.yaml" | "strategy.yaml";
  yamlKey: string;
  value: string;
  impact: {
    fp_removed: number;
    valid_at_risk: number;
    fp_urls: string[];
    valid_urls: string[];
  };
  confidence: "high" | "medium" | "low";
  safe: boolean;
}

export interface TriageAnalysis {
  summary: {
    total_triaged: number;
    valid_count: number;
    fp_count: number;
    current_precision: number;
  };
  suggestions: TriageSuggestion[];
  remaining_fps: string[];
}

export interface ScenarioConfig {
  excluded_repos: string[];
  allowed_repos: string[];
  hard_exclusion_url_regex: string[];
  hard_exclusion_repo_regex: string[];
}

// Segments that are too generic to be useful exclusion patterns
const GENERIC_SEGMENTS = new Set([
  "en-us", "en", "docs", "blob", "main", "master", "tree",
  "github.com", "learn.microsoft.com", "go.microsoft.com",
  "articles", "includes", "media", "index", "readme",
  "latest", "stable", "api", "reference", "overview",
]);

// ── Analysis engine ──────────────────────────────────────────────────

/**
 * Analyze triage decisions against results to produce actionable suggestions
 * for improving retrieval precision.
 */
export function analyzeTriage(
  results: PageResult[],
  triageState: TriageState,
  scenarioConfig: ScenarioConfig,
): TriageAnalysis {
  // Step 1: Classify results into valid and FP lists
  const validResults: PageResult[] = [];
  const fpResults: PageResult[] = [];

  for (const r of results) {
    const decision = triageState.decisions[r.url];
    if (decision === "false_positive" || decision === "ignore_repo") {
      fpResults.push(r);
    } else if (decision === "valid") {
      validResults.push(r);
    }
    // Untriaged results are ignored — we only analyze explicit decisions
  }

  const totalTriaged = validResults.length + fpResults.length;
  const precision = totalTriaged > 0 ? validResults.length / totalTriaged : 1;

  const suggestions: TriageSuggestion[] = [];
  const coveredFpUrls = new Set<string>();

  // Step 2: Repo-level analysis
  analyzeRepos(fpResults, validResults, scenarioConfig, suggestions, coveredFpUrls);

  // Step 3: URL segment analysis
  analyzeUrlSegments(fpResults, validResults, suggestions, coveredFpUrls);

  // Step 4: Allowed repos pruning
  analyzeAllowedRepos(fpResults, validResults, scenarioConfig, suggestions, coveredFpUrls);

  // Step 5: Score and rank
  rankSuggestions(suggestions);

  // Step 6: Identify remaining FPs
  const remaining_fps = fpResults
    .map((r) => r.url)
    .filter((url) => !coveredFpUrls.has(url));

  return {
    summary: {
      total_triaged: totalTriaged,
      valid_count: validResults.length,
      fp_count: fpResults.length,
      current_precision: precision,
    },
    suggestions,
    remaining_fps,
  };
}

// ── Step 2: Repo-level analysis ──────────────────────────────────────

function analyzeRepos(
  fpResults: PageResult[],
  validResults: PageResult[],
  scenarioConfig: ScenarioConfig,
  suggestions: TriageSuggestion[],
  coveredFpUrls: Set<string>,
): void {
  const repoFps = new Map<string, PageResult[]>();
  const repoValids = new Map<string, PageResult[]>();

  for (const r of fpResults) {
    const repo = extractRepo(r);
    if (!repo) { continue; }
    if (!repoFps.has(repo)) { repoFps.set(repo, []); }
    repoFps.get(repo)!.push(r);
  }

  for (const r of validResults) {
    const repo = extractRepo(r);
    if (!repo) { continue; }
    if (!repoValids.has(repo)) { repoValids.set(repo, []); }
    repoValids.get(repo)!.push(r);
  }

  for (const [repo, fps] of repoFps) {
    // Skip repos already in excluded list
    if (scenarioConfig.excluded_repos.some((e) => repoMatches(e, repo))) {
      continue;
    }

    const valids = repoValids.get(repo) ?? [];
    const totalInRepo = fps.length + valids.length;
    const fpRate = fps.length / totalInRepo;

    if (valids.length === 0) {
      // Pure FP repo → high confidence exclusion
      suggestions.push({
        id: "", // assigned in ranking
        type: "exclude_repo",
        description: `Exclude repo "${repo}" — all ${fps.length} results are false positives`,
        yamlFile: "scenario.yaml",
        yamlKey: "search.github.excluded_repos",
        value: repo,
        impact: {
          fp_removed: fps.length,
          valid_at_risk: 0,
          fp_urls: fps.map((r) => r.url),
          valid_urls: [],
        },
        confidence: "high",
        safe: true,
      });
      for (const r of fps) { coveredFpUrls.add(r.url); }
    } else if (fpRate > 0.8 && fps.length >= 3) {
      // Mostly FP repo → medium confidence with warning
      suggestions.push({
        id: "",
        type: "exclude_repo",
        description: `Exclude repo "${repo}" — ${fps.length}/${totalInRepo} results are FPs (${Math.round(fpRate * 100)}%)`,
        yamlFile: "scenario.yaml",
        yamlKey: "search.github.excluded_repos",
        value: repo,
        impact: {
          fp_removed: fps.length,
          valid_at_risk: valids.length,
          fp_urls: fps.map((r) => r.url),
          valid_urls: valids.map((r) => r.url),
        },
        confidence: "medium",
        safe: false,
      });
      for (const r of fps) { coveredFpUrls.add(r.url); }
    }
  }
}

// ── Step 3: URL segment analysis ─────────────────────────────────────

function analyzeUrlSegments(
  fpResults: PageResult[],
  validResults: PageResult[],
  suggestions: TriageSuggestion[],
  coveredFpUrls: Set<string>,
): void {
  // Extract meaningful segments from all URLs
  const segmentFps = new Map<string, PageResult[]>();
  const segmentValids = new Map<string, PageResult[]>();

  for (const r of fpResults) {
    for (const seg of extractMeaningfulSegments(r.url)) {
      if (!segmentFps.has(seg)) { segmentFps.set(seg, []); }
      segmentFps.get(seg)!.push(r);
    }
  }

  for (const r of validResults) {
    for (const seg of extractMeaningfulSegments(r.url)) {
      if (!segmentValids.has(seg)) { segmentValids.set(seg, []); }
      segmentValids.get(seg)!.push(r);
    }
  }

  // Analyze individual segments
  for (const [segment, fps] of segmentFps) {
    const valids = segmentValids.get(segment) ?? [];

    if (fps.length >= 3 && valids.length === 0) {
      const pattern = escapeRegex(`/${segment}/`);
      suggestions.push({
        id: "",
        type: "url_exclusion",
        description: `Exclude URL pattern "/${segment}/" — matches ${fps.length} FPs, 0 valid`,
        yamlFile: "strategy.yaml",
        yamlKey: "hard_exclusions.url_regex",
        value: pattern,
        impact: {
          fp_removed: fps.length,
          valid_at_risk: 0,
          fp_urls: fps.map((r) => r.url),
          valid_urls: [],
        },
        confidence: "high",
        safe: true,
      });
      for (const r of fps) { coveredFpUrls.add(r.url); }
    } else if (fps.length >= 5 && valids.length <= 1) {
      const pattern = escapeRegex(`/${segment}/`);
      suggestions.push({
        id: "",
        type: "url_exclusion",
        description: `Exclude URL pattern "/${segment}/" — matches ${fps.length} FPs, ${valids.length} valid at risk`,
        yamlFile: "strategy.yaml",
        yamlKey: "hard_exclusions.url_regex",
        value: pattern,
        impact: {
          fp_removed: fps.length,
          valid_at_risk: valids.length,
          fp_urls: fps.map((r) => r.url),
          valid_urls: valids.map((r) => r.url),
        },
        confidence: "medium",
        safe: false,
      });
      for (const r of fps) { coveredFpUrls.add(r.url); }
    }
  }

  // Detect shared path prefixes among FPs
  analyzePrefixPatterns(fpResults, validResults, suggestions, coveredFpUrls);
}

/**
 * Find common path prefixes shared by multiple FPs but no valids.
 */
function analyzePrefixPatterns(
  fpResults: PageResult[],
  validResults: PageResult[],
  suggestions: TriageSuggestion[],
  coveredFpUrls: Set<string>,
): void {
  const fpPaths = extractPaths(fpResults);
  const validPaths = new Set(extractPaths(validResults));

  // Build prefix frequency map (minimum 3 segments in prefix)
  const prefixFps = new Map<string, PageResult[]>();
  for (let i = 0; i < fpPaths.length; i++) {
    const segments = fpPaths[i].split("/").filter(Boolean);
    // Generate prefixes of length 3+
    for (let len = 3; len <= Math.min(segments.length - 1, 6); len++) {
      const prefix = "/" + segments.slice(0, len).join("/") + "/";
      // Skip if this prefix is just generic segments
      if (segments.slice(0, len).every((s) => GENERIC_SEGMENTS.has(s.toLowerCase()))) {
        continue;
      }
      if (!prefixFps.has(prefix)) { prefixFps.set(prefix, []); }
      prefixFps.get(prefix)!.push(fpResults[i]);
    }
  }

  for (const [prefix, fps] of prefixFps) {
    if (fps.length < 3) { continue; }

    // Check how many valids share this prefix
    const validHits: string[] = [];
    for (const vp of validPaths) {
      if (vp.startsWith(prefix) || vp.includes(prefix)) {
        validHits.push(vp);
      }
    }

    if (validHits.length === 0) {
      // Deduplicate FP urls in this prefix group
      const uniqueFps = [...new Set(fps.map((r) => r.url))];
      if (uniqueFps.length < 3) { continue; }

      const pattern = escapeRegex(prefix);
      suggestions.push({
        id: "",
        type: "url_exclusion",
        description: `Exclude URL prefix "${prefix}" — matches ${uniqueFps.length} FPs, 0 valid`,
        yamlFile: "strategy.yaml",
        yamlKey: "hard_exclusions.url_regex",
        value: pattern,
        impact: {
          fp_removed: uniqueFps.length,
          valid_at_risk: 0,
          fp_urls: uniqueFps,
          valid_urls: [],
        },
        confidence: "high",
        safe: true,
      });
      for (const u of uniqueFps) { coveredFpUrls.add(u); }
    }
  }
}

// ── Step 4: Allowed repos pruning ────────────────────────────────────

function analyzeAllowedRepos(
  fpResults: PageResult[],
  validResults: PageResult[],
  scenarioConfig: ScenarioConfig,
  suggestions: TriageSuggestion[],
  coveredFpUrls: Set<string>,
): void {
  if (scenarioConfig.allowed_repos.length === 0) { return; }

  const repoFps = new Map<string, PageResult[]>();
  const repoValids = new Map<string, PageResult[]>();

  for (const r of fpResults) {
    const repo = extractRepo(r);
    if (!repo) { continue; }
    if (!repoFps.has(repo)) { repoFps.set(repo, []); }
    repoFps.get(repo)!.push(r);
  }

  for (const r of validResults) {
    const repo = extractRepo(r);
    if (!repo) { continue; }
    if (!repoValids.has(repo)) { repoValids.set(repo, []); }
    repoValids.get(repo)!.push(r);
  }

  for (const allowedRepo of scenarioConfig.allowed_repos) {
    // Find the matching key in our maps (allowed_repos may use short names)
    const matchingFps = findRepoResults(allowedRepo, repoFps);
    const matchingValids = findRepoResults(allowedRepo, repoValids);

    if (matchingFps.length > 0 && matchingValids.length === 0) {
      suggestions.push({
        id: "",
        type: "remove_allowed_repo",
        description: `Remove "${allowedRepo}" from allowed_repos — all ${matchingFps.length} results are FPs`,
        yamlFile: "scenario.yaml",
        yamlKey: "search.github.allowed_repos",
        value: allowedRepo,
        impact: {
          fp_removed: matchingFps.length,
          valid_at_risk: 0,
          fp_urls: matchingFps.map((r) => r.url),
          valid_urls: [],
        },
        confidence: "high",
        safe: true,
      });
      for (const r of matchingFps) { coveredFpUrls.add(r.url); }
    }
  }
}

// ── Step 5: Ranking ──────────────────────────────────────────────────

function rankSuggestions(suggestions: TriageSuggestion[]): void {
  // Sort: safe first, then by fp_removed descending
  suggestions.sort((a, b) => {
    if (a.safe !== b.safe) { return a.safe ? -1 : 1; }
    return b.impact.fp_removed - a.impact.fp_removed;
  });

  // Assign IDs based on type
  const counters: Record<string, number> = {};
  for (const s of suggestions) {
    const prefix = s.type === "exclude_repo" ? "repo"
      : s.type === "url_exclusion" ? "url"
      : s.type === "remove_allowed_repo" ? "allow"
      : "content";
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    s.id = `${prefix}-${counters[prefix]}`;
  }

  // Deduplicate: if a URL exclusion is entirely subsumed by a repo exclusion, drop it
  deduplicateSuggestions(suggestions);
}

function deduplicateSuggestions(suggestions: TriageSuggestion[]): void {
  // Build set of all FP URLs already covered by repo-level suggestions
  const repoCoveredUrls = new Set<string>();
  for (const s of suggestions) {
    if (s.type === "exclude_repo" || s.type === "remove_allowed_repo") {
      for (const url of s.impact.fp_urls) {
        repoCoveredUrls.add(url);
      }
    }
  }

  // Remove URL suggestions whose FPs are entirely covered by repo suggestions
  for (let i = suggestions.length - 1; i >= 0; i--) {
    const s = suggestions[i];
    if (s.type === "url_exclusion") {
      const uncovered = s.impact.fp_urls.filter((u) => !repoCoveredUrls.has(u));
      if (uncovered.length === 0) {
        suggestions.splice(i, 1);
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractRepo(r: PageResult): string | undefined {
  // Use the repo field if available
  if (r.repo) { return r.repo; }
  // Try to extract from GitHub URL
  try {
    const u = new URL(r.url);
    if (u.hostname === "github.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

function repoMatches(pattern: string, repo: string): boolean {
  // Handle both "org/repo" and short "repo" formats
  if (pattern === repo) { return true; }
  if (pattern.includes("/") && repo.includes("/")) {
    return pattern.toLowerCase() === repo.toLowerCase();
  }
  // Short name match: "vscode-docs" matches "MicrosoftDocs/vscode-docs"
  const shortPattern = pattern.includes("/") ? pattern.split("/")[1] : pattern;
  const shortRepo = repo.includes("/") ? repo.split("/")[1] : repo;
  return shortPattern.toLowerCase() === shortRepo.toLowerCase();
}

function findRepoResults(allowedRepo: string, repoMap: Map<string, PageResult[]>): PageResult[] {
  for (const [repo, results] of repoMap) {
    if (repoMatches(allowedRepo, repo)) {
      return results;
    }
  }
  return [];
}

function extractMeaningfulSegments(url: string): string[] {
  try {
    const u = new URL(url);
    return u.pathname
      .split("/")
      .filter(Boolean)
      .filter((s) => !GENERIC_SEGMENTS.has(s.toLowerCase()))
      .filter((s) => s.length > 1 && !/^\d+$/.test(s)); // skip single chars and pure numbers
  } catch {
    return [];
  }
}

function extractPaths(results: PageResult[]): string[] {
  return results
    .map((r) => {
      try { return new URL(r.url).pathname; } catch { return ""; }
    })
    .filter(Boolean);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
