#!/usr/bin/env python3
"""
preseason.ai scraper

The site is a Next.js app that serializes its data into RSC payloads embedded
as `self.__next_f.push([1, "<chunk>"])` blocks in each rendered HTML page.
Decoding those chunks gives clean JSON with full ranking/match/prompt data.

Usage:
    scrape.py inventory       # build categories.json + tools.json + prompts.json + matches index
    scrape.py plan            # generate scrape_plan.json (URLs to fetch)
    scrape.py scrape          # execute the plan, caching raw HTML to data/raw/
    scrape.py extract         # parse cached raw -> data/json/{tools,matches,prompts,...}.json
    scrape.py all             # inventory -> plan -> scrape -> extract

Subcommands are idempotent and resumable — `scrape` skips files already in
data/raw/ unless --force is passed.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import logging
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "data" / "raw"
JSON_DIR = ROOT / "data" / "json"
LOG_DIR = ROOT / "logs"
RAW_DIR.mkdir(parents=True, exist_ok=True)
JSON_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

BASE = "https://www.preseason.ai"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stderr),
        logging.FileHandler(LOG_DIR / "scrape.log"),
    ],
)
log = logging.getLogger("preseason")


# ---------------------------------------------------------------------------
# HTTP with adaptive throttle
# ---------------------------------------------------------------------------


@dataclass
class Throttle:
    """Adaptive concurrency + backoff. Thread-safe."""

    max_concurrency: int = 2
    min_concurrency: int = 1
    base_delay_ms: int = 500
    jitter_ms: int = 300
    backoff_until: float = 0.0
    backoff_streak: int = 0
    _sema: threading.Semaphore = field(init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        self._sema = threading.Semaphore(self.max_concurrency)

    def __enter__(self) -> "Throttle":
        self._sema.acquire()
        # Honor any global backoff window
        while True:
            with self._lock:
                wait = self.backoff_until - time.time()
            if wait <= 0:
                break
            time.sleep(min(wait, 30) + random.random())
        # Per-request jitter
        time.sleep(self.base_delay_ms / 1000 + random.random() * self.jitter_ms / 1000)
        return self

    def __exit__(self, *exc: Any) -> None:
        self._sema.release()

    def report_throttle(self, retry_after: float | None = None) -> None:
        with self._lock:
            self.backoff_streak += 1
            wait = retry_after if retry_after else min(60, 2**self.backoff_streak)
            self.backoff_until = max(self.backoff_until, time.time() + wait)
            # Shrink concurrency if we keep getting throttled
            if self.backoff_streak >= 2 and self.max_concurrency > self.min_concurrency:
                # Drain one permit
                if self._sema.acquire(blocking=False):
                    self.max_concurrency -= 1
                    log.warning("Reducing concurrency to %d", self.max_concurrency)
        log.warning("Throttled; backing off ~%.1fs (streak=%d)", wait, self.backoff_streak)

    def report_ok(self) -> None:
        with self._lock:
            self.backoff_streak = max(0, self.backoff_streak - 1)


THROTTLE = Throttle()


def http_get(url: str, attempts: int = 5) -> str:
    """GET with retry, backoff, and rate-limit detection."""
    last_err: Exception | None = None
    for i in range(attempts):
        with THROTTLE:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    body = resp.read().decode("utf-8", errors="replace")
                    THROTTLE.report_ok()
                    return body
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code in (429, 503, 502, 504):
                    retry_after = None
                    if e.headers.get("Retry-After"):
                        try:
                            retry_after = float(e.headers["Retry-After"])
                        except ValueError:
                            retry_after = None
                    THROTTLE.report_throttle(retry_after)
                    continue
                if e.code == 404:
                    raise
                log.error("HTTP %d on %s; retrying", e.code, url)
                time.sleep(2**i)
            except Exception as e:  # noqa: BLE001
                last_err = e
                log.error("Network error on %s: %s; retrying", url, e)
                time.sleep(2**i)
    raise RuntimeError(f"Failed after {attempts} attempts: {url} ({last_err})")


# ---------------------------------------------------------------------------
# RSC payload extraction
# ---------------------------------------------------------------------------

_PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,(".*?")\]\)', re.S)
_CHUNK_RE = re.compile(r"^([0-9a-f]+):(.*)$", re.M)


def decode_rsc_chunks(html: str) -> dict[str, str]:
    """Return a dict {chunk_id: raw_payload_string}.

    The raw payload is the text after `<id>:`. Some chunks are JSON
    (arrays/objects starting with `[` or `{`); some are like `I[...]` (component
    refs); some are quoted strings (`"...module..."`). Caller decides how to
    parse each.
    """
    text = ""
    for m in _PUSH_RE.finditer(html):
        try:
            text += json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
    chunks: dict[str, str] = {}
    for m in _CHUNK_RE.finditer(text):
        chunks[m.group(1)] = m.group(2)
    return chunks


def find_in_json(obj: Any, predicate, *, max_depth: int = 30):
    """DFS for the first sub-object matching predicate."""
    stack: list[tuple[Any, int]] = [(obj, 0)]
    while stack:
        cur, d = stack.pop()
        if d > max_depth:
            continue
        if predicate(cur):
            return cur
        if isinstance(cur, dict):
            for v in cur.values():
                stack.append((v, d + 1))
        elif isinstance(cur, list):
            for v in cur:
                stack.append((v, d + 1))
    return None


def find_all_in_json(obj: Any, predicate, *, max_depth: int = 30) -> list[Any]:
    out: list[Any] = []
    stack: list[tuple[Any, int]] = [(obj, 0)]
    while stack:
        cur, d = stack.pop()
        if d > max_depth:
            continue
        if predicate(cur):
            out.append(cur)
        if isinstance(cur, dict):
            for v in cur.values():
                stack.append((v, d + 1))
        elif isinstance(cur, list):
            for v in cur:
                stack.append((v, d + 1))
    return out


def parse_rsc_data(html: str) -> list[Any]:
    """Return the parsed JSON of every chunk that looks like data (not module refs / strings)."""
    parsed = []
    for cid, payload in decode_rsc_chunks(html).items():
        if not payload or payload[0] not in "[{":
            continue
        if payload.startswith("I["):  # module ref
            continue
        try:
            parsed.append(json.loads(payload))
        except json.JSONDecodeError:
            continue
    return parsed


def parse_rsc_chunks_resolved(html: str) -> dict[str, Any]:
    """Return {chunk_id: parsed_node} with `$Lxx` references inlined.

    RSC ships sub-trees in separate chunks and references them via `"$Lxx"`
    placeholders. Match-detail pages spread per-row data across many chunks,
    so we need full resolution before walking JSX tables.
    """
    raw_chunks = decode_rsc_chunks(html)
    parsed: dict[str, Any] = {}
    for cid, payload in raw_chunks.items():
        if not payload or payload[0] not in "[{" or payload.startswith("I["):
            continue
        try:
            parsed[cid] = json.loads(payload)
        except json.JSONDecodeError:
            continue

    def resolve(node: Any, depth: int = 0) -> Any:
        if depth > 80:
            return node
        if isinstance(node, str) and node.startswith("$"):
            ref = node[2:] if node.startswith("$L") else node[1:]
            if ref and all(c in "0123456789abcdef" for c in ref):
                sub = parsed.get(ref)
                if sub is not None:
                    return resolve(sub, depth + 1)
            return node
        if isinstance(node, list):
            return [resolve(x, depth + 1) for x in node]
        if isinstance(node, dict):
            return {k: resolve(v, depth + 1) for k, v in node.items()}
        return node

    return {cid: resolve(node) for cid, node in parsed.items()}


def jsx_find_tag(node: Any, tag: str) -> Any:
    """First descendant JSX element with the given tag."""
    if isinstance(node, list) and len(node) >= 4 and node[0] == "$" and node[1] == tag:
        return node
    if isinstance(node, list):
        for x in node:
            r = jsx_find_tag(x, tag)
            if r is not None:
                return r
    if isinstance(node, dict):
        return jsx_find_tag(node.get("children"), tag) if "children" in node else None
    return None


def jsx_find_all(node: Any, tag: str, into: list[Any]) -> None:
    if isinstance(node, list) and len(node) >= 4 and node[0] == "$" and node[1] == tag:
        into.append(node)
    if isinstance(node, list):
        for x in node:
            jsx_find_all(x, tag, into)
    elif isinstance(node, dict):
        jsx_find_all(node.get("children"), tag, into)


def jsx_text(node: Any) -> Any:
    """Extract a leaf text/number from a JSX cell, or join multiple leaves."""
    if isinstance(node, (int, float)):
        return node
    if isinstance(node, str):
        return None if node.startswith("$") else node
    leaves: list[Any] = []
    def collect(n: Any) -> None:
        if isinstance(n, (int, float)):
            leaves.append(n)
        elif isinstance(n, str) and not n.startswith("$"):
            leaves.append(n)
        elif isinstance(n, list) and len(n) >= 4 and n[0] == "$":
            if isinstance(n[3], dict):
                collect(n[3].get("children"))
        elif isinstance(n, list):
            for x in n:
                collect(x)
    collect(node)
    if not leaves:
        return None
    if len(leaves) == 1:
        return leaves[0]
    # E.g. ["65.7", "% - ", "67.3", "%"] → "65.7% - 67.3%"
    return "".join(str(x) for x in leaves)


def parse_jsx_table(table_node: Any) -> tuple[list[Any], list[list[Any]]]:
    headers: list[Any] = []
    rows: list[list[Any]] = []
    thead = jsx_find_tag(table_node, "thead")
    tbody = jsx_find_tag(table_node, "tbody")
    if thead:
        ths: list[Any] = []
        jsx_find_all(thead, "th", ths)
        for th in ths:
            ch = th[3].get("children") if isinstance(th[3], dict) else None
            headers.append(jsx_text(ch))
    if tbody:
        trs: list[Any] = []
        jsx_find_all(tbody, "tr", trs)
        for tr in trs:
            tds: list[Any] = []
            jsx_find_all(tr, "td", tds)
            row = []
            for td in tds:
                ch = td[3].get("children") if isinstance(td[3], dict) else None
                row.append(jsx_text(ch))
            if row:
                rows.append(row)
    return headers, rows


def find_table_after_heading(chunks: dict[str, Any], heading: str) -> Any:
    """Return the JSX `<table>` from the card whose `<h3>` text equals `heading`.

    Each "card" on a match page renders as one chunk that begins with a
    rounded-lg div containing an h3 with the section title. We pick the chunk
    where the *first h3* matches, then walk to its table.
    """
    for node in chunks.values():
        h3 = jsx_find_tag(node, "h3")
        if not h3 or not isinstance(h3[3], dict):
            continue
        text = jsx_text(h3[3].get("children"))
        if not isinstance(text, str) or text.strip() != heading:
            continue
        tbl = jsx_find_tag(node, "table")
        if tbl is not None:
            return tbl
    return None


# ---------------------------------------------------------------------------
# File cache (raw HTML)
# ---------------------------------------------------------------------------


def cache_path_for(url: str) -> Path:
    h = hashlib.sha1(url.encode()).hexdigest()[:12]
    # Human-readable slug for debugging
    slug = re.sub(r"[^a-z0-9]+", "_", url.replace(BASE, "").lower()).strip("_") or "root"
    slug = slug[:80]
    return RAW_DIR / f"{slug}__{h}.html"


def fetch_cached(url: str, *, force: bool = False) -> str:
    p = cache_path_for(url)
    if p.exists() and not force:
        return p.read_text()
    log.info("FETCH %s", url)
    body = http_get(url)
    p.write_text(body)
    return body


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------


def inventory() -> dict[str, Any]:
    """Build the master inventory:
    - categories (groups + subcategories)
    - tools (from rankings, all groups)
    - prompts (from /prompts index)
    - matches index entries (from /matches)
    """
    log.info("Inventory: fetching /rankings")
    html = fetch_cached(f"{BASE}/rankings")
    chunks = parse_rsc_data(html)

    # Sidebar tree: groups[].subcategories[]
    sidebar = find_in_json(
        chunks,
        lambda o: isinstance(o, dict) and isinstance(o.get("groups"), list)
                  and o["groups"] and isinstance(o["groups"][0], dict)
                  and "subcategories" in o["groups"][0],
    )
    # Ranking data: initialGroups[].ranking.items[]
    rank_node = find_in_json(
        chunks,
        lambda o: isinstance(o, dict) and isinstance(o.get("initialGroups"), list)
                  and o["initialGroups"] and isinstance(o["initialGroups"][0], dict)
                  and "ranking" in o["initialGroups"][0],
    )
    if sidebar is None or rank_node is None:
        raise RuntimeError("Could not locate groups/initialGroups in /rankings RSC")

    categories: list[dict[str, Any]] = []
    for g in sidebar["groups"]:
        categories.append({
            "slug": g["slug"],
            "name": g["name"],
            "subcategories": [
                {"slug": s["slug"], "name": s["name"]} for s in g.get("subcategories", [])
            ],
        })

    initial_tools: dict[str, dict[str, Any]] = {}
    rankings: list[dict[str, Any]] = []
    for g in rank_node["initialGroups"]:
        ranking = g.get("ranking") or {}
        for item in ranking.get("items", []):
            slug = item.get("toolSlug")
            if not slug:
                continue
            initial_tools.setdefault(slug, {
                "id": item.get("toolId"),
                "slug": slug,
                "name": item.get("toolName"),
                "logoUrl": item.get("toolLogoUrl"),
            })
            rankings.append({
                "groupSlug": g["slug"],
                "subSlug": None,
                "toolSlug": slug,
                **{k: item.get(k) for k in (
                    "weightedSupport", "weightedEligible", "weightedSupportRate",
                    "rawSupportCount", "rawEligibleCount", "rawSupportRate",
                    "modelCoverage", "promptCoverage",
                    "ciLow", "ciHigh", "trend",
                )},
            })

    log.info("Inventory: fetching /prompts")
    prompts_html = fetch_cached(f"{BASE}/prompts")
    prompts_chunks = parse_rsc_data(prompts_html)
    prompts_node = find_in_json(
        prompts_chunks,
        lambda o: isinstance(o, dict) and "initialItems" in o and isinstance(o["initialItems"], list)
                  and o["initialItems"] and isinstance(o["initialItems"][0], dict)
                  and "expectedCategories" in o["initialItems"][0],
    )
    prompts = prompts_node["initialItems"] if prompts_node else []
    log.info("Inventory: %d prompts", len(prompts))

    log.info("Inventory: fetching /matches")
    matches_html = fetch_cached(f"{BASE}/matches")
    matches_chunks = parse_rsc_data(matches_html)
    matches_node = find_in_json(
        matches_chunks,
        lambda o: isinstance(o, dict) and "initialItems" in o and isinstance(o["initialItems"], list)
                  and o["initialItems"] and isinstance(o["initialItems"][0], dict)
                  and "toolA" in o["initialItems"][0],
    )
    matches_index = matches_node["initialItems"] if matches_node else []
    log.info("Inventory: %d featured matches", len(matches_index))

    inv = {
        "categories": categories,
        "tools": list(initial_tools.values()),
        "rankings_group_level": rankings,
        "prompts": prompts,
        "matches_featured": matches_index,
    }
    (JSON_DIR / "inventory.json").write_text(json.dumps(inv, indent=2))
    log.info("Inventory: %d categories, %d tools, %d rankings, %d prompts, %d matches",
             len(categories), len(initial_tools), len(rankings), len(prompts), len(matches_index))
    return inv


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------


def plan(top_n: int = 10) -> dict[str, Any]:
    inv_path = JSON_DIR / "inventory.json"
    if not inv_path.exists():
        inventory()
    inv = json.loads(inv_path.read_text())

    urls: list[dict[str, Any]] = []

    # 1. Per-subcategory rankings (gives full per-sub leaderboard)
    for cat in inv["categories"]:
        for sub in cat["subcategories"]:
            urls.append({
                "kind": "ranking_sub",
                "url": f"{BASE}/rankings?group={cat['slug']}&sub={sub['slug']}",
                "groupSlug": cat["slug"],
                "subSlug": sub["slug"],
            })

    # 2. Tool detail pages
    for tool in inv["tools"]:
        urls.append({
            "kind": "tool",
            "url": f"{BASE}/tools/{tool['slug']}",
            "toolSlug": tool["slug"],
        })

    # 3. Prompt detail pages (one per (level, slug) — many prompts share slug across levels)
    for p in inv["prompts"]:
        urls.append({
            "kind": "prompt",
            "url": f"{BASE}/prompts/{p['level']}/{p['slug']}",
            "promptId": p["id"],
            "level": p["level"],
            "slug": p["slug"],
        })
    # Also per-subcategory prompt list pages (have detailed top-recommendations)
    for cat in inv["categories"]:
        for sub in cat["subcategories"]:
            urls.append({
                "kind": "prompts_sub",
                "url": f"{BASE}/prompts?group={cat['slug']}&sub={sub['slug']}",
                "groupSlug": cat["slug"],
                "subSlug": sub["slug"],
            })

    # 4. Matches: full pairwise per subcategory.
    # We pair each tool against the top-N within its real per-category
    # leaderboard (extracted from /tools/{slug} pages into tool_rankings.json).
    # That leaderboard is the only real per-category membership signal — the
    # /rankings?sub= URL is a UI-only filter that returns the global numbers
    # for every tool, so we can't trust it for this.
    pairs_seen: set[tuple[str, str, str]] = set()
    sub_to_tools: dict[tuple[str, str], list[str]] = {}
    tool_rank_path = JSON_DIR / "tool_rankings.json"
    if tool_rank_path.exists():
        tr = json.loads(tool_rank_path.read_text())
        # Sort each (groupSlug, subSlug) leaderboard by rankInSub ascending
        from collections import defaultdict
        leaderboard: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for r in tr:
            leaderboard[(r["groupSlug"], r["subSlug"])].append(r)
        for k, items in leaderboard.items():
            items.sort(key=lambda x: x.get("rankInSub") or 9999)
            sub_to_tools[k] = [it["toolSlug"] for it in items if it.get("toolSlug")]
    else:
        log.warning(
            "tool_rankings.json missing; pairwise plan will be empty until "
            "tool pages are extracted."
        )

    # Full within-sub pairwise. The match URL slug uses the sub slug
    # (e.g. auth, database, orm, storage). top_n caps the pairing to the
    # top N within each leaderboard — pass a large value (or 0) to expand
    # exhaustively.
    for (group_slug, sub_slug), tools in sub_to_tools.items():
        scoped = tools[:top_n] if top_n and top_n > 0 else tools
        for a, b in itertools.combinations(sorted(scoped), 2):
            key = (sub_slug, a, b)
            if key in pairs_seen:
                continue
            pairs_seen.add(key)
            urls.append({
                "kind": "match",
                "url": f"{BASE}/matches/{sub_slug}--{a}-vs-{b}",
                "subSlug": sub_slug,
                "groupSlug": group_slug,
                "toolA": a,
                "toolB": b,
            })

    # Always include featured matches even if we missed them above
    for fm in inv.get("matches_featured", []):
        sub = fm.get("category", {}).get("slug")
        a = fm.get("toolA", {}).get("slug")
        b = fm.get("toolB", {}).get("slug")
        if not (sub and a and b):
            continue
        a, b = sorted([a, b])
        if (sub, a, b) in pairs_seen:
            continue
        pairs_seen.add((sub, a, b))
        urls.append({
            "kind": "match",
            "url": f"{BASE}/matches/{sub}--{a}-vs-{b}",
            "subSlug": sub,
            "toolA": a,
            "toolB": b,
        })

    out = {"top_n": top_n, "urls": urls}
    (JSON_DIR / "scrape_plan.json").write_text(json.dumps(out, indent=2))
    log.info("Plan: %d URLs (%s)", len(urls),
             ", ".join(f"{k}={sum(1 for u in urls if u['kind']==k)}"
                       for k in sorted({u['kind'] for u in urls})))
    return out


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------


def scrape(force: bool = False, workers: int = 2) -> None:
    plan_path = JSON_DIR / "scrape_plan.json"
    if not plan_path.exists():
        plan()
    p = json.loads(plan_path.read_text())
    urls = p["urls"]

    # Two-pass: we need per-subcategory rankings cached before we can derive
    # top-N pairwise match URLs. If any ranking_sub URL is uncached, fetch
    # those first, then re-run the planner so pairwise matches appear.
    sub_urls = [u for u in urls if u["kind"] == "ranking_sub"]
    sub_uncached = [u for u in sub_urls if not cache_path_for(u["url"]).exists()]
    needs_replan = bool(sub_uncached)
    if sub_uncached:
        log.info("First pass: fetching %d per-sub rankings", len(sub_uncached))
        _scrape_urls(sub_uncached, force, workers)
    # Re-plan so pairwise match URLs are populated
    if needs_replan or not any(u["kind"] == "match" and "subSlug" in u for u in urls):
        log.info("Re-planning with cached per-sub rankings")
        plan(top_n=p.get("top_n", 10))
        urls = json.loads(plan_path.read_text())["urls"]

    _scrape_urls(urls, force, workers)


def _scrape_urls(urls: list[dict[str, Any]], force: bool, workers: int) -> None:
    todo = [u for u in urls if force or not cache_path_for(u["url"]).exists()]
    log.info("Scraping %d / %d URLs (skipping %d already cached)",
             len(todo), len(urls), len(urls) - len(todo))
    failures: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_scrape_one, u, force): u for u in todo}
        done = 0
        for fut in as_completed(futures):
            u = futures[fut]
            done += 1
            try:
                fut.result()
            except Exception as e:  # noqa: BLE001
                log.error("FAIL %s: %s", u["url"], e)
                failures.append({"url": u["url"], "error": str(e)})
            if done % 25 == 0:
                log.info("Progress %d/%d", done, len(todo))
    if failures:
        (LOG_DIR / "failures.json").write_text(json.dumps(failures, indent=2))
        log.warning("%d failures (see logs/failures.json)", len(failures))


def _scrape_one(u: dict[str, Any], force: bool) -> None:
    fetch_cached(u["url"], force=force)


# ---------------------------------------------------------------------------
# Extract: parse cached HTML -> normalized JSON
# ---------------------------------------------------------------------------


def _parse_ranking_sub(html: str, group_slug: str, sub_slug: str) -> list[dict[str, Any]]:
    data = parse_rsc_data(html)
    node = find_in_json(data, lambda o: isinstance(o, dict) and "initialGroups" in o)
    if not node:
        return []
    out: list[dict[str, Any]] = []
    for g in node["initialGroups"]:
        if g.get("slug") != group_slug:
            continue
        for it in (g.get("ranking") or {}).get("items", []):
            out.append({
                "groupSlug": group_slug,
                "subSlug": sub_slug,
                **{k: it.get(k) for k in (
                    "toolId", "toolSlug", "toolName", "toolLogoUrl",
                    "weightedSupport", "weightedEligible", "weightedSupportRate",
                    "rawSupportCount", "rawEligibleCount", "rawSupportRate",
                    "modelCoverage", "promptCoverage",
                    "ciLow", "ciHigh", "trend",
                )},
            })
    return out


def _parse_match(html: str, expected: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Parse a match detail page.

    Match detail pages render the breakdowns as JSX tables, not as a single
    JSON node. We extract:
      - title (h1) → tool A and B labels
      - "Summary" table → aWins/bWins/abstains/decisive cases/A win rate/95% CI
      - "Per-model breakdown" table
      - "Per-prompt breakdown" table

    The matches *index* exposes a fully structured `{toolA, toolB, result}`
    blob for featured items — caller can substitute that when available.
    """
    chunks = parse_rsc_chunks_resolved(html)
    nodes = list(chunks.values())

    # Title: e.g. "PostgreSQL vs Supabase | Preseason"
    title_a, title_b = None, None
    for node in nodes:
        h1 = jsx_find_tag(node, "h1")
        if h1 and isinstance(h1[3], dict):
            t = jsx_text(h1[3].get("children"))
            if isinstance(t, str) and " vs " in t:
                a, b = t.split(" vs ", 1)
                title_a, title_b = a.strip(), b.strip()
                break

    out: dict[str, Any] = {
        "toolALabel": title_a,
        "toolBLabel": title_b,
        "summary": None,
        "perModel": [],
        "perPrompt": [],
    }
    if expected:
        out.update({
            "subSlug": expected.get("subSlug"),
            "groupSlug": expected.get("groupSlug"),
            "toolASlug": expected.get("toolA"),
            "toolBSlug": expected.get("toolB"),
        })

    summary_tbl = find_table_after_heading(chunks, "Statistics")
    if summary_tbl is not None:
        _, rows = parse_jsx_table(summary_tbl)
        s: dict[str, Any] = {}
        for row in rows:
            if len(row) < 2:
                continue
            label, value = row[0], row[1]
            if isinstance(label, list):
                # e.g. ["PostgreSQL", " wins"] → "PostgreSQL wins"
                label = "".join(str(x) for x in label if isinstance(x, str))
            if isinstance(label, str):
                s[label.strip()] = value
        out["summary"] = s

    pm_tbl = find_table_after_heading(chunks, "Per-model breakdown")
    if pm_tbl is not None:
        headers, rows = parse_jsx_table(pm_tbl)
        out["perModel"] = [_zip_row(headers, r) for r in rows]

    pp_tbl = find_table_after_heading(chunks, "Per-prompt breakdown")
    if pp_tbl is not None:
        headers, rows = parse_jsx_table(pp_tbl)
        out["perPrompt"] = [_zip_row(headers, r) for r in rows]

    return out


def _zip_row(headers: list[Any], row: list[Any]) -> dict[str, Any]:
    out = {}
    for h, v in zip(headers, row):
        out[str(h) if h is not None else "_"] = v
    return out


def _parse_tool(html: str) -> dict[str, Any] | None:
    """Tool detail: name, description, category memberships, ranking rows."""
    data = parse_rsc_data(html)
    # The tool details are spread across React elements. Pull what we can:
    title = find_in_json(
        data,
        lambda o: isinstance(o, list) and len(o) >= 4 and o[0] == "$" and o[1] == "h1",
    )
    name = None
    if title and isinstance(title[3], dict):
        name = title[3].get("children")

    # description follows the h1 in a <p class="mb-3 text-muted-foreground">.
    # A separate <p class="mb-4 max-w-sm text-sm text-muted-foreground"> with
    # text "Verified critics can leave comments here." sits in the Comments
    # empty-state — it is NOT a description and must be excluded. Tools with
    # no description (e.g. MongoDB) only have that empty-state paragraph.
    desc = None
    for p in find_all_in_json(
        data,
        lambda o: isinstance(o, list) and len(o) >= 4 and o[0] == "$" and o[1] == "p",
    ):
        props = p[3] if isinstance(p[3], dict) else {}
        cls = props.get("className", "")
        if (
            "text-muted-foreground" in cls
            and "max-w-sm" not in cls
            and isinstance(props.get("children"), str)
        ):
            desc = props["children"]
            break

    return {"name": name, "description": desc}


_RATE_RE = re.compile(r"([\d.]+)%\((\d+)/(\d+)\)")


def _parse_tool_rankings(
    html: str,
    tool_slug: str,
    sub_name_index: dict[str, tuple[str, str]],
) -> list[dict[str, Any]]:
    """Extract the "Rankings" table from a /tools/{slug} page.

    The table reports the tool's actual rank within each subcategory it
    participates in, e.g. "Database #8/44 0.9%(167/17853)". This is the
    only place on the site where per-category membership is exposed.
    """
    chunks = parse_rsc_chunks_resolved(html)
    table = find_table_after_heading(chunks, "Rankings")
    if table is None:
        return []
    _, rows = parse_jsx_table(table)
    out: list[dict[str, Any]] = []
    for r in rows:
        if len(r) < 3:
            continue
        cat_name = r[0]
        rank_str = str(r[1] or "")
        rate_str = str(r[2] or "").replace(" ", "")
        m = re.match(r"#(\d+)/(\d+)", rank_str)
        if not m:
            continue
        rate_m = _RATE_RE.match(rate_str)
        sub_meta = sub_name_index.get(cat_name)
        if not sub_meta:
            continue
        group_slug, sub_slug = sub_meta
        out.append({
            "toolSlug": tool_slug,
            "groupSlug": group_slug,
            "subSlug": sub_slug,
            "categoryName": cat_name,
            "rankInSub": int(m.group(1)),
            "totalInSub": int(m.group(2)),
            "supportRate": float(rate_m.group(1)) / 100 if rate_m else None,
            "support": int(rate_m.group(2)) if rate_m else None,
            "eligible": int(rate_m.group(3)) if rate_m else None,
        })
    return out


def _parse_prompt_detail(html: str) -> dict[str, Any] | None:
    """Prompt detail page: extract the prompt text from the <pre> block."""
    data = parse_rsc_data(html)
    pre = find_in_json(
        data,
        lambda o: isinstance(o, list) and len(o) >= 4 and o[0] == "$" and o[1] == "pre"
                  and isinstance(o[3], dict) and isinstance(o[3].get("children"), str),
    )
    text = pre[3]["children"] if pre else None

    title = find_in_json(
        data,
        lambda o: isinstance(o, list) and len(o) >= 4 and o[0] == "$" and o[1] == "h1"
                  and isinstance(o[3], dict),
    )
    title_text = title[3].get("children") if title else None
    return {"title": title_text if isinstance(title_text, str) else None, "promptText": text}


def extract() -> None:
    plan_path = JSON_DIR / "scrape_plan.json"
    plan_data = json.loads(plan_path.read_text())
    urls = plan_data["urls"]

    inv = json.loads((JSON_DIR / "inventory.json").read_text())

    rankings_sub: list[dict[str, Any]] = []
    matches: list[dict[str, Any]] = []
    tools: dict[str, dict[str, Any]] = {}
    tool_rankings: list[dict[str, Any]] = []
    prompts_detail: dict[str, dict[str, Any]] = {}

    # Map "Category Name" → (groupSlug, subSlug) for tool-page parsing
    sub_name_index: dict[str, tuple[str, str]] = {}
    for cat in inv["categories"]:
        for sub in cat["subcategories"]:
            sub_name_index[sub["name"]] = (cat["slug"], sub["slug"])

    # Featured matches from /matches index already have full structured data
    featured_by_pair: dict[tuple[str, str, str], dict[str, Any]] = {}
    for fm in inv.get("matches_featured", []):
        sub = fm.get("category", {}).get("slug")
        a = fm.get("toolA", {}).get("slug")
        b = fm.get("toolB", {}).get("slug")
        if sub and a and b:
            key = (sub, *sorted([a, b]))
            featured_by_pair[key] = fm

    for u in urls:
        cp = cache_path_for(u["url"])
        if not cp.exists():
            continue
        try:
            html = cp.read_text()
        except Exception as e:  # noqa: BLE001
            log.warning("Read fail %s: %s", cp, e)
            continue

        kind = u["kind"]
        try:
            if kind == "ranking_sub":
                rankings_sub.extend(_parse_ranking_sub(html, u["groupSlug"], u["subSlug"]))
            elif kind == "match":
                m = _parse_match(html, expected=u)
                if m:
                    m["_url"] = u["url"]
                    key = (u["subSlug"], *sorted([u["toolA"], u["toolB"]]))
                    if key in featured_by_pair:
                        m["featuredJson"] = featured_by_pair[key]
                    matches.append(m)
            elif kind == "tool":
                t = _parse_tool(html)
                if t:
                    tools[u["toolSlug"]] = {"slug": u["toolSlug"], **t}
                tool_rankings.extend(
                    _parse_tool_rankings(html, u["toolSlug"], sub_name_index)
                )
            elif kind == "prompt":
                pd = _parse_prompt_detail(html)
                if pd:
                    prompts_detail[u["promptId"]] = {
                        "id": u["promptId"], "level": u["level"], "slug": u["slug"], **pd,
                    }
        except Exception as e:  # noqa: BLE001
            log.warning("Parse fail %s: %s", u["url"], e)

    # Models: source-of-truth is featured matches' modelBreakdown (has id/tier)
    models: dict[str, dict[str, Any]] = {}
    for fm in inv.get("matches_featured", []):
        for mb in fm.get("result", {}).get("modelBreakdown", []):
            mid = mb.get("id")
            if mid and mid not in models:
                models[mid] = {"id": mid, "label": mb.get("label"), "tier": mb.get("tier")}
    # Augment with model labels seen in non-featured per-model rows (no id)
    for m in matches:
        for row in m.get("perModel", []):
            label = row.get("Model")
            tier = row.get("Tier")
            if not label:
                continue
            existing = next((v for v in models.values() if v["label"] == label), None)
            if not existing:
                models[label] = {"id": None, "label": label, "tier": tier}

    # Per-subcategory rankings deduped by (sub, tool)
    seen = set()
    rankings_sub_dedup = []
    for r in rankings_sub:
        k = (r["subSlug"], r["toolSlug"])
        if k in seen:
            continue
        seen.add(k)
        rankings_sub_dedup.append(r)

    # Write outputs
    (JSON_DIR / "categories.json").write_text(json.dumps(inv["categories"], indent=2))
    (JSON_DIR / "tools.json").write_text(json.dumps(inv["tools"], indent=2))
    (JSON_DIR / "rankings.json").write_text(json.dumps(inv.get("rankings_group_level", []), indent=2))
    (JSON_DIR / "rankings_sub.json").write_text(json.dumps(rankings_sub_dedup, indent=2))
    (JSON_DIR / "prompts.json").write_text(json.dumps(inv["prompts"], indent=2))
    (JSON_DIR / "prompts_detail.json").write_text(json.dumps(list(prompts_detail.values()), indent=2))
    (JSON_DIR / "matches_featured.json").write_text(json.dumps(inv.get("matches_featured", []), indent=2))
    (JSON_DIR / "matches.json").write_text(json.dumps(matches, indent=2))
    (JSON_DIR / "tools_detail.json").write_text(json.dumps(list(tools.values()), indent=2))
    (JSON_DIR / "tool_rankings.json").write_text(json.dumps(tool_rankings, indent=2))
    (JSON_DIR / "models.json").write_text(json.dumps(list(models.values()), indent=2))

    log.info(
        "Extract: %d sub-rankings, %d tool-rankings, %d matches, %d tools, %d prompt details, %d models",
        len(rankings_sub_dedup), len(tool_rankings), len(matches), len(tools),
        len(prompts_detail), len(models),
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("inventory")
    p_plan = sub.add_parser("plan")
    p_plan.add_argument("--top-n", type=int, default=10)
    p_scrape = sub.add_parser("scrape")
    p_scrape.add_argument("--force", action="store_true")
    p_scrape.add_argument("--workers", type=int, default=2)
    sub.add_parser("extract")
    p_all = sub.add_parser("all")
    p_all.add_argument("--top-n", type=int, default=10)
    p_all.add_argument("--workers", type=int, default=2)

    args = ap.parse_args()
    if args.cmd == "inventory":
        inventory()
    elif args.cmd == "plan":
        plan(top_n=args.top_n)
    elif args.cmd == "scrape":
        scrape(force=args.force, workers=args.workers)
    elif args.cmd == "extract":
        extract()
    elif args.cmd == "all":
        inventory()
        plan(top_n=args.top_n)
        scrape(workers=args.workers)
        extract()


if __name__ == "__main__":
    main()
