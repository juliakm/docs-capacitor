"""LLMDetector — LLM-based conflict detection against release notes.

Fully parameterized: URL filters, prompt template, key facts, and rate
limits all come from scenario config. The prompt is rendered via Jinja2
from a template file, or falls back to a generic built-in template.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from capacitor.detectors.base import BaseDetector
from capacitor.detectors import register_detector


# ------------------------------------------------------------------
# Cache helpers
# ------------------------------------------------------------------

def _cache_key(url: str, text: str, key_facts: List[str], max_chars: int) -> str:
    truncated = text[:max_chars]
    payload = json.dumps({"url": url, "text": truncated, "facts": sorted(key_facts)}, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _get_cached(cache_dir: Path, cache_key: str) -> Optional[List[Dict[str, Any]]]:
    cache_file = cache_dir / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with cache_file.open("r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None
    return None


def _set_cached(cache_dir: Path, cache_key: str, result: List[Dict[str, Any]]) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{cache_key}.json"
    with cache_file.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)


# ------------------------------------------------------------------
# URL filter helpers
# ------------------------------------------------------------------

def is_relevant_page(
    url: str,
    relevant_patterns: List[str],
    skip_patterns: List[str],
) -> bool:
    """Check if a URL should be processed by the LLM detector."""
    url_lower = url.lower()
    if "github.com/" in url_lower:
        return True
    for pattern in skip_patterns:
        if pattern in url_lower:
            return False
    for pattern in relevant_patterns:
        if pattern in url_lower:
            return True
    # If no relevant patterns configured, accept all non-skipped pages
    return len(relevant_patterns) == 0


# ------------------------------------------------------------------
# Prompt building
# ------------------------------------------------------------------

def _load_jinja_template(template_path: Path) -> Any:
    """Load a Jinja2 template from a file."""
    from jinja2 import Environment, FileSystemLoader
    env = Environment(
        loader=FileSystemLoader(str(template_path.parent)),
        keep_trailing_newline=True,
    )
    return env.get_template(template_path.name)


_BUILTIN_PROMPT = """\
You are a documentation freshness reviewer for Microsoft Learn.
You are reviewing articles about {{ product_name }}{% if tool_name %} used with {{ tool_name }}{% endif %}.

IMPORTANT RULES:
- Only flag ACTUAL CONFLICTS where the article explicitly states something wrong.
- Do NOT flag an article for "not mentioning" something. Absence is not a conflict.

KNOWN FACTS:

{% for fact in key_facts %}- {{ fact }}
{% endfor %}

Article content:
URL: {{ article_url }}

---
{{ article_text }}
---

Find statements in the article that EXPLICITLY CONTRADICT the known facts.
Only report issues where the article ACTIVELY SAYS something incorrect.

For each real conflict, return a JSON object:
- "severity": "P0" for broken instructions, "P1" for stale versions/features, "INFO" for minor staleness
- "rule_id": "LLM.conflict"
- "title": short title of the conflict
- "conflict": description of the conflict
- "article_quote": the EXACT conflicting text from the article (max 200 chars, must be a real quote)
- "fact": the correct fact

If no real conflicts, return: []
Respond ONLY with a valid JSON array."""


def build_prompt(
    article_url: str,
    article_text: str,
    key_facts: List[str],
    *,
    template_path: Optional[Path] = None,
    product_name: str = "",
    tool_name: str = "",
    max_article_chars: int = 8000,
) -> str:
    """Build the LLM prompt, using a Jinja2 template if available."""
    truncated = article_text[:max_article_chars]
    context = {
        "article_url": article_url,
        "article_text": truncated,
        "key_facts": key_facts,
        "product_name": product_name,
        "tool_name": tool_name,
    }

    if template_path and template_path.exists():
        template = _load_jinja_template(template_path)
        return template.render(**context)

    from jinja2 import Environment
    env = Environment(keep_trailing_newline=True)
    template = env.from_string(_BUILTIN_PROMPT)
    return template.render(**context)


def load_key_facts(
    release_notes_path: Path,
    section_key: str = "product_sections",
    static_facts: Optional[List[str]] = None,
) -> List[str]:
    """Load key facts from release notes snapshot + static facts from config."""
    facts: List[str] = []

    if release_notes_path.exists():
        with open(release_notes_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if "key_facts" in data:
            facts.extend(data["key_facts"])
        else:
            for section in data.get(section_key, []):
                heading = section.get("heading", "")
                summary = section.get("summary", section.get("text", section.get("content", "")))
                if heading:
                    facts.append(f"{heading} -- {summary[:200]}")

    if static_facts:
        facts.extend(static_facts)

    return facts


# ------------------------------------------------------------------
# LLMDetector class
# ------------------------------------------------------------------

@register_detector("llm")
class LLMDetector(BaseDetector):
    """LLM-based conflict detection comparing articles to release notes."""

    @property
    def name(self) -> str:
        return "llm"

    def __init__(
        self,
        *,
        # Provider selection: "github_models" (preferred) or "azure_openai"
        provider: str = "",
        # GitHub Models config
        github_token: str = "",
        model: str = "gpt-4o",
        # Azure OpenAI config (fallback)
        endpoint: str = "",
        api_key: str = "",
        deployment: str = "gpt-4o",
        api_version: str = "2024-12-01-preview",
        # Common config
        release_notes_path: str | Path | None = None,
        cache_dir: str | Path | None = None,
        use_cache: bool = True,
        prompt_template_path: str | Path | None = None,
        product_name: str = "",
        tool_name: str = "",
        relevant_url_patterns: List[str] | None = None,
        skip_url_patterns: List[str] | None = None,
        key_facts: List[str] | None = None,
        section_key: str = "product_sections",
        max_article_chars: int = 8000,
        rate_limit_rpm: int = 10,
    ):
        # Auto-detect provider if not explicitly set
        if provider:
            self.provider = provider
        elif github_token:
            self.provider = "github_models"
        elif endpoint and api_key:
            self.provider = "azure_openai"
        else:
            self.provider = "github_models"  # preferred default

        self.github_token = github_token
        self.model = model
        self.endpoint = endpoint
        self.api_key = api_key
        self.deployment = deployment
        self.api_version = api_version
        self.release_notes_path = Path(release_notes_path) if release_notes_path else None
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.use_cache = use_cache
        self.prompt_template_path = Path(prompt_template_path) if prompt_template_path else None
        self.product_name = product_name
        self.tool_name = tool_name
        self.relevant_url_patterns = relevant_url_patterns or []
        self.skip_url_patterns = skip_url_patterns or []
        self.static_key_facts = key_facts or []
        self.section_key = section_key
        self.max_article_chars = max_article_chars
        self.request_delay = 60.0 / rate_limit_rpm if rate_limit_rpm > 0 else 6.0

    def _is_configured(self) -> bool:
        try:
            from openai import OpenAI  # noqa: F401
        except ImportError:
            return False
        if self.provider == "github_models":
            return bool(self.github_token)
        return bool(self.endpoint and self.api_key)

    def _create_client(self) -> Any:
        """Create the appropriate OpenAI client based on provider."""
        if self.provider == "github_models":
            from openai import OpenAI
            return OpenAI(
                base_url="https://models.inference.ai.azure.com",
                api_key=self.github_token,
            )
        else:
            from openai import AzureOpenAI
            return AzureOpenAI(
                azure_endpoint=self.endpoint,
                api_key=self.api_key,
                api_version=self.api_version,
            )

    def _get_model_name(self) -> str:
        """Return the model/deployment name for the current provider."""
        if self.provider == "github_models":
            return self.model
        return self.deployment

    def detect(self, pages: List[Dict[str, Any]], *, emit_all: bool = False, **kwargs: Any) -> List[Dict[str, Any]]:
        if not self._is_configured():
            print("  Warning: Azure OpenAI not configured — skipping LLM conflict detection")
            return []

        if self.release_notes_path is None:
            print("  Warning: No release notes path — skipping LLM conflict detection")
            return []

        key_facts = load_key_facts(
            self.release_notes_path,
            section_key=self.section_key,
            static_facts=self.static_key_facts,
        )
        if not key_facts:
            print("  Warning: No key facts found — skipping LLM conflict detection")
            return []

        relevant = [
            p for p in pages
            if is_relevant_page(
                p.get("url", ""),
                self.relevant_url_patterns,
                self.skip_url_patterns,
            )
        ]
        print(f"  LLM conflict check: {len(relevant)} relevant pages ({len(pages) - len(relevant)} skipped)")

        all_findings: List[Dict[str, Any]] = []
        for i, page in enumerate(relevant):
            url = page.get("url", "")
            text = page.get("text", "")

            ck = _cache_key(url, text, key_facts, self.max_article_chars)
            hit = (
                self.use_cache
                and self.cache_dir is not None
                and _get_cached(self.cache_dir, ck) is not None
            )
            print(f"    [{i + 1}/{len(relevant)}] {'(cached) ' if hit else ''}{url}")

            try:
                findings = self._check_page(url, text, key_facts, ck)
            except Exception as e:
                print(f"      Warning: {e}")
                findings = []

            if findings:
                print(f"      Found {len(findings)} conflict(s)")
                all_findings.extend(findings)
            else:
                print(f"      No conflicts")

            if not hit and i < len(relevant) - 1:
                time.sleep(self.request_delay)

        return all_findings

    def _check_page(
        self,
        url: str,
        text: str,
        key_facts: List[str],
        cache_key: str,
    ) -> List[Dict[str, Any]]:
        if not text.strip():
            return []

        if self.use_cache and self.cache_dir is not None:
            cached = _get_cached(self.cache_dir, cache_key)
            if cached is not None:
                return cached

        from openai import OpenAI  # noqa: F401

        client = self._create_client()
        prompt = build_prompt(
            url, text, key_facts,
            template_path=self.prompt_template_path,
            product_name=self.product_name,
            tool_name=self.tool_name,
            max_article_chars=self.max_article_chars,
        )
        response = client.chat.completions.create(
            model=self._get_model_name(),
            messages=[
                {"role": "system", "content": "You are a documentation freshness reviewer. Only flag explicit contradictions. Respond only with valid JSON."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.0,
            max_tokens=2000,
            timeout=60,
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            lines = raw.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            raw = "\n".join(lines).strip()
        try:
            result = json.loads(raw)
            if isinstance(result, dict):
                result = [result]
            if isinstance(result, list):
                for item in result:
                    item["url"] = url
                    item.setdefault("rule_id", "LLM.conflict")
                    item["source"] = "llm"
                if self.cache_dir:
                    _set_cached(self.cache_dir, cache_key, result)
                return result
        except json.JSONDecodeError:
            pass

        if self.cache_dir:
            _set_cached(self.cache_dir, cache_key, [])
        return []
