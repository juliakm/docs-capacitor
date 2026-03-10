"""Pipeline orchestrator — Collect → Detect → Classify → Report.

Fully driven by CapacitorConfig (scenario YAML). No hardcoded product logic.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urldefrag

from capacitor.config import CapacitorConfig
from capacitor.collectors import COLLECTOR_REGISTRY
from capacitor.detectors import DETECTOR_REGISTRY
from capacitor.classifiers import CLASSIFIER_REGISTRY
from capacitor.reporters import REPORTER_REGISTRY
from capacitor.utils.release_notes import build_snapshot, fetch_page, extract_sections


def _get_github_token() -> str:
    """Get GitHub token from env or fall back to ``gh auth token``."""
    token = os.getenv("GITHUB_TOKEN", "")
    if token:
        return token
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


class Pipeline:
    """Configurable 4-stage pipeline: collect → detect → classify → report."""

    def __init__(self, config: CapacitorConfig, *, out_dir: Optional[Path] = None):
        self.config = config
        self.out_dir = out_dir or Path("output")
        self.pages: List[Dict[str, Any]] = []
        self.findings: List[Dict[str, Any]] = []
        self.classifications: List[Dict[str, Any]] = []
        self.release_notes: Dict[str, Any] = {}
        self.strategy: Dict[str, Any] = {}
        self._seen_urls: set[str] = set()

    # ------------------------------------------------------------------
    # Builder helpers
    # ------------------------------------------------------------------

    def _build_github_collector(self) -> Any:
        cls = COLLECTOR_REGISTRY.get("github")
        if not cls:
            return None
        search = self.config.search
        gh_cfg = search.get("github", {})
        tracker = gh_cfg.get("tracker", "")
        tracker_path = (self.config.scenario_dir / tracker) if tracker else None
        return cls(
            tracker_path=tracker_path,
            excluded_repos=gh_cfg.get("excluded_repos", []),
            orgs=gh_cfg.get("orgs", []),
            queries=gh_cfg.get("queries", []),
            cache_dir=self.out_dir,
            use_cache=gh_cfg.get("use_cache", True),
            repos_file=gh_cfg.get("repos_file"),
            dry_run=gh_cfg.get("dry_run", False),
        )

    def _build_learn_collector(self) -> Any:
        cls = COLLECTOR_REGISTRY.get("learn")
        if not cls:
            return None
        search = self.config.search
        learn_cfg = search.get("learn", {})
        product = self.config.product
        return cls(
            api_url=learn_cfg.get("api_url", "https://learn.microsoft.com/api/search"),
            queries=learn_cfg.get("queries", []),
            path_scopes=learn_cfg.get("path_scopes", [""]),
            exclude_url_patterns=learn_cfg.get("exclude_url_patterns", []),
            relevance_terms=[product.get("name", ""), product.get("tool", "")],
        )

    def _build_local_collector(self, root: str | Path = ".", glob_pattern: str = "**/*.md") -> Any:
        cls = COLLECTOR_REGISTRY.get("local")
        return cls(root=root, glob_pattern=glob_pattern) if cls else None

    def _build_regex_detector(self) -> Any:
        cls = DETECTOR_REGISTRY.get("regex")
        if not cls:
            return None
        rules_path = self.config.detection.get("regex_rules")
        if rules_path:
            rules_path = self.config.scenario_dir / rules_path
        return cls(rules_yaml=rules_path)

    def _build_llm_detector(self) -> Any:
        cls = DETECTOR_REGISTRY.get("llm")
        if not cls:
            return None
        llm_cfg = self.config.detection.get("llm", {})
        product = self.config.product
        url_filters = self.config.url_filters

        prompt_tpl = llm_cfg.get("prompt_template")
        if prompt_tpl:
            prompt_tpl = self.config.scenario_dir / prompt_tpl

        rn_cfg = self.config.release_notes_config
        rn_path = self.out_dir / "release_notes_snapshot.json"

        return cls(
            provider=os.getenv("LLM_PROVIDER", ""),
            github_token=_get_github_token(),
            model=os.getenv("GITHUB_MODELS_MODEL", "gpt-4o"),
            endpoint=os.getenv("AZURE_OPENAI_ENDPOINT", ""),
            api_key=os.getenv("AZURE_OPENAI_API_KEY", ""),
            deployment=os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
            api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview"),
            release_notes_path=rn_path,
            cache_dir=self.out_dir / "llm_cache",
            prompt_template_path=prompt_tpl,
            product_name=product.get("name", ""),
            tool_name=product.get("tool", ""),
            relevant_url_patterns=url_filters.get("relevant", []),
            skip_url_patterns=url_filters.get("skip", []),
            key_facts=llm_cfg.get("key_facts", []),
            section_key=rn_cfg.get("section_key", "product_sections"),
            max_article_chars=llm_cfg.get("max_article_chars", 8000),
            rate_limit_rpm=llm_cfg.get("rate_limit_rpm", 10),
        )

    def _build_classifier(self, areas: list[str] | None = None) -> Any:
        cls = CLASSIFIER_REGISTRY.get("topic_rules")
        if not cls:
            return None
        class_cfg = self.config.classification
        strategy_path = class_cfg.get("strategy")
        if strategy_path:
            strategy_path = self.config.scenario_dir / strategy_path

        rn_cfg = self.config.release_notes_config
        rn_path = self.out_dir / "release_notes_snapshot.json"

        return cls(
            strategy_path=strategy_path,
            release_notes_path=rn_path,
            areas=areas or [],
            section_key=rn_cfg.get("section_key", "product_sections"),
        )

    # ------------------------------------------------------------------
    # Pipeline stages
    # ------------------------------------------------------------------

    def refresh_release_notes(self) -> Dict[str, Any]:
        """Fetch release notes and save snapshot."""
        rn_cfg = self.config.release_notes_config
        url = rn_cfg.get("url", "")
        section_pattern = rn_cfg.get("section_pattern", "")
        section_key = rn_cfg.get("section_key", "product_sections")

        if not url:
            print("No release notes URL configured — skipping refresh.")
            self.release_notes = {}
            return self.release_notes

        print(f"Fetching release notes from {url}")
        html = fetch_page(url)
        sections = extract_sections(html, section_pattern) if section_pattern else []
        self.release_notes = build_snapshot(
            url=url,
            sections=sections,
            section_key=section_key,
        )
        self.out_dir.mkdir(parents=True, exist_ok=True)
        snapshot_path = self.out_dir / "release_notes_snapshot.json"
        snapshot_path.write_text(json.dumps(self.release_notes, indent=2), encoding="utf-8")
        print(f"Saved release notes snapshot ({len(self.release_notes.get(section_key, []))} sections)")
        return self.release_notes

    @staticmethod
    def _normalize_url(url: str) -> str:
        """Normalize a URL for deduplication: strip fragment and trailing slashes."""
        defragged, _ = urldefrag(url)
        return defragged.rstrip("/")

    def collect(self, *, sources: List[str] | None = None, pages_jsonl: str | None = None) -> List[Dict[str, Any]]:
        """Run collector stage with cross-source deduplication."""
        sources = sources or ["github", "learn"]
        self.pages = []
        self._seen_urls = set()
        dedup_count = 0
        for source in sources:
            print(f"Collecting from: {source}")
            if source == "github":
                collector = self._build_github_collector()
            elif source == "learn":
                collector = self._build_learn_collector()
            elif source == "local":
                collector = self._build_local_collector()
            else:
                print(f"  Unknown source: {source}, skipping")
                continue
            if collector is None:
                print(f"  {source} collector not available, skipping")
                continue
            pages = list(collector.collect(pages_jsonl=pages_jsonl) if source == "github" else collector.collect())
            added = 0
            for page in pages:
                raw_url = page.get("url") or page.get("file") or ""
                norm = self._normalize_url(raw_url)
                if norm and norm in self._seen_urls:
                    dedup_count += 1
                    continue
                if norm:
                    self._seen_urls.add(norm)
                self.pages.append(page)
                added += 1
            print(f"  Collected {len(pages)} pages from {source} ({added} new)")
        if dedup_count:
            print(f"  Deduplicated {dedup_count} duplicate page(s)")
        print(f"Total pages collected: {len(self.pages)}")
        return self.pages

    def detect(self, *, detectors: List[str] | None = None, emit_all: bool = False) -> List[Dict[str, Any]]:
        """Run detector stage."""
        detectors = detectors or ["regex"]
        self.findings = []
        for det_name in detectors:
            print(f"Running detector: {det_name}")
            if det_name == "regex":
                detector = self._build_regex_detector()
            elif det_name == "llm":
                detector = self._build_llm_detector()
            else:
                print(f"  Unknown detector: {det_name}, skipping")
                continue
            if detector is None:
                print(f"  {det_name} detector not available, skipping")
                continue
            results = detector.detect(self.pages, emit_all=emit_all)
            print(f"  {det_name} found {len(results)} findings")
            self.findings.extend(results)
        print(f"Total findings: {len(self.findings)}")
        return self.findings

    def classify(self, *, areas: list[str] | None = None) -> List[Dict[str, Any]]:
        """Run classifier stage."""
        print("Classifying findings")
        classifier = self._build_classifier(areas)
        if classifier is None:
            print("  Classifier not available")
            return []
        self.classifications = classifier.classify(self.findings, self.pages)
        from collections import Counter
        counts = Counter(row["classification"] for row in self.classifications)
        for cls_name, count in counts.most_common():
            print(f"  {cls_name}: {count}")
        return self.classifications

    def report(self, *, formats: List[str] | None = None) -> List[Path]:
        """Run reporter stage."""
        formats = formats or self.config.reporting.get("formats", ["markdown"])
        report_title = self.config.reporting.get("title", "Documentation Freshness Report")
        section_key = self.config.release_notes_config.get("section_key", "product_sections")

        paths: List[Path] = []
        for fmt in formats:
            reporter_cls = REPORTER_REGISTRY.get(fmt)
            if reporter_cls is None:
                print(f"Unknown reporter: {fmt}")
                continue
            reporter = reporter_cls()
            path = reporter.report(
                self.classifications,
                self.out_dir,
                release_notes=self.release_notes,
                strategy=self.strategy,
                report_title=report_title,
                section_key=section_key,
            )
            print(f"Report written: {path}")
            paths.append(path)
        return paths

    def run(
        self,
        *,
        sources: List[str] | None = None,
        detectors: List[str] | None = None,
        areas: list[str] | None = None,
        formats: List[str] | None = None,
        skip_collect: bool = False,
        pages_jsonl: str | None = None,
    ) -> List[Path]:
        """Run the full pipeline end-to-end."""
        self.refresh_release_notes()
        if not skip_collect:
            self.collect(sources=sources, pages_jsonl=pages_jsonl)
        self.detect(detectors=detectors, emit_all=True)
        self.classify(areas=areas)
        return self.report(formats=formats)
