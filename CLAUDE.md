# CLAUDE.md

Notes for Claude (or any agent) maintaining this project. The README covers
*using* it; this file covers *understanding* it.

## What the codebase is

Two halves:

- **`scrape.py`** — stdlib-only Python scraper (`urllib.request`, `json`,
  `re`, `concurrent.futures`). Subcommands: `inventory → plan → scrape →
  extract` (or `all`). No external deps deliberately — keeps the script
  copy-pasteable and avoids version drift.
- **`web/`** — Vite + React 19 + TypeScript + react-router-dom 7. Loads JSON
  out of `web/public/data/` (synced from `data/json/` by
  `web/scripts/copy-data.sh`, run automatically by the `predev`/`prebuild`
  hooks). All matchup math is computed at runtime from raw scraped breakdown
  rows; no precomputation step.

## How preseason.ai actually works

The site is a Next.js app on Vercel. **It has no public API.** No
`sitemap.xml`, no `robots.txt`, no `/api/trpc/*` endpoints exposed. Every
data point shown on screen is embedded in the rendered HTML as RSC (React
Server Component) payload chunks:

```
<script>self.__next_f.push([1, "<chunk_id>:<json>\n"])</script>
```

Concatenate every push body, split on lines of the form `<hex_id>:<payload>`,
and you get a chunk dictionary. Each chunk's payload is one of:

- `I[...]` — module reference, ignore
- `"..."` — a string the rest of the tree can interpolate, mostly ignore
- `[...]` or `{...}` — JSON for either data or a JSX element tree

JSX elements look like `["$", "div", null, {"className": "...", "children": [...]}]`.
Children can recursively contain more JSX or strings starting with `$Lxx`,
which are **references to other chunks**. To walk a tree intact you must
resolve those references — `parse_rsc_chunks_resolved()` does this.

## The two data shapes

Some pages ship clean structured JSON props (the easy case):

- `/rankings` → `initialGroups[].ranking.items[]` (full ranking with UUIDs,
  `weightedSupportRate`, `ciLow/ciHigh`, `modelCoverage`, `promptCoverage`,
  `trend`)
- `/rankings` (separately) → `groups[].subcategories[]` for the sidebar tree
- `/prompts` → `initialItems[]` with prompt `id/slug/level/description/expectedCategories`
- `/matches` → `initialItems[]` of 12 featured matchups with full
  `result.modelBreakdown[]` and `result.promptBreakdown[]` (UUIDs for
  models, prompts, tools, categories)

Other pages ship the same data only as **JSX `<table>` rows** (the harder case):

- `/matches/{cat-slug}--{toolA}-vs-{toolB}` (non-featured) — the per-model and
  per-prompt breakdowns are rendered, not serialized as JSON props.
- `/tools/{slug}` — name and description in `<h1>` / `<p>` tags.

For the JSX case, use `parse_rsc_chunks_resolved()`, then `find_table_after_heading(chunks, "<h3 text>")`, then `parse_jsx_table()`.

## Gotchas

1. **`/rankings?group=X&sub=Y` is a UI-only filter.** The RSC payload is
   identical to bare `/rankings`. Don't expect different data per query
   string. The site filters client-side in JavaScript. (We still cache
   per-sub URLs in case the server behavior changes.)

2. **The summary card on a match page is titled `Statistics`, not `Summary`.**
   Cost me real time. If you change the section heading constants, double
   check the actual `<h3>` text by running `parse_rsc_chunks_resolved` and
   listing every `h3` text.

3. **The pairwise corpus is currently 3,132 matches** (up from an earlier
   1,090). The expansion was driven by switching from "top 10 per sub" to
   "every tool that appears in the per-sub leaderboard". Some matchups have
   empty `perModel`/`perPrompt` — that is *correct*, those are below the
   site's 30-decisive threshold and rendered as "Insufficient data". Don't
   treat empty breakdowns as a parse failure.

4. **Two-pass scrape required.** `plan` cannot generate pairwise match URLs
   without first having the per-subcategory rankings cached (to know top-N
   per sub). The `scrape` subcommand handles this: if any `ranking_sub` URL
   is uncached, it fetches them first, then re-plans, then continues.

5. **The disk cache is the source of truth for `extract`.** Never re-fetch
   from `extract`. If you change the parser, just re-run `extract` against
   the existing cache — it's much faster than re-scraping.

6. **Throttle state is process-local.** No persistence. If you abort and
   restart, throttling resets. That's fine in practice — the cache means
   you only re-fetch what failed.

7. **Two `<p class="...text-muted-foreground...">` elements live on every
   `/tools/{slug}` page.** One is the tool description; the other is the
   Comments empty-state ("Verified critics can leave comments here."). The
   description has class `mb-3 text-muted-foreground`; the empty-state has
   `mb-4 max-w-sm text-sm text-muted-foreground`. Filter out `max-w-sm` or
   you'll mis-tag every description-less tool with the empty-state text.

8. **`/rankings?sub=` returns global numbers for every tool, not per-sub
   numbers.** Per-category rank/support comes from the "Rankings" table on
   `/tools/{slug}` only. `tool_rankings.json` is the authoritative source —
   `_parse_tool_rankings()` extracts it.

## Adding a new page type

1. Fetch one example URL with `curl -s ... -o /tmp/sample.html`.
2. Open a Python REPL: `from scrape import parse_rsc_chunks_resolved, jsx_find_tag, jsx_text`.
3. Inspect every `<h3>` text and every chunk that has `len > 1000` and
   "interesting" keys (filter out generic React props like `children`,
   `className`, etc.).
4. If the data is in clean JSON props (look for `initialItems`,
   `initialGroups`, etc.), use `parse_rsc_data()` + `find_in_json()`.
5. If the data is rendered as JSX, use `parse_rsc_chunks_resolved()` +
   `find_table_after_heading()` + `parse_jsx_table()`.
6. Add a new `kind` to `plan()`'s URL list and a new branch to `extract()`'s
   dispatch.

## Verifying changes

After parser changes:

```bash
python3 scrape.py extract   # ~1s on the existing cache
python3 -c "import json; m = json.load(open('data/json/matches.json')); \
            print('matches:', len(m), 'with perModel:', sum(1 for x in m if x.get('perModel')))"
```

If counts drop unexpectedly, your selector probably broke. Compare a
sample object against a freshly-fetched page in a browser.

## Web app (`web/`)

### Layout

- `src/data.ts` — single `loadDataset()` fetches every JSON file once,
  builds in-memory `Map`s for fast lookup (`toolBySlug`, `matchByPair`,
  `matchesByTool`, `toolsBySub`, `rankingsByTool`, etc.).
- `src/synth.ts` — pure functions for orientation/swap (`orient`), rollups
  (`rollup`), Wilson 95% intervals (`wilson95`), and the per-matchup
  resolver (`resolveMatch`). Used by every page that does math.
- `src/pages/` — `Matchups.tsx`, `ToolDetail.tsx`, `PromptsList.tsx`,
  `PromptDetail.tsx`. Each derives its tables from the raw scraped rows in
  `data.matches`; nothing is precomputed at build time.
- `src/components/` — `SortableTable` (used everywhere), `BreakdownTable`,
  `ToolLogo`, `ToolCombobox` (typeahead).

### Match orientation

Each scraped match has `toolASlug` / `toolBSlug` and breakdowns labelled by
display name (the column key matches `toolALabel` / `toolBLabel`). When the
viewer's "focal" tool isn't `toolASlug`, you must `swap=true` and `orient()`
the rows so picks align to the focal tool's perspective. Skipping this is
the most common bug; always orient before rolling up.

### Numbers vs the source site

The README's "A note on the numbers" section spells this out. Short version:
our "win rate" is decisive-only (`a / (a+b)`), not the site's `support rate`
(`a / eligible`). Don't conflate them when adding new visualizations.

## What NOT to do

- Don't add a third-party HTTP library (httpx, requests, etc.). The
  stdlib version works and keeps deps zero.
- Don't bypass the cache by changing `cache_path_for()` — older raw files
  on disk become orphaned and the next scrape pays full cost.
- Don't increase default concurrency above 3. The site is on Vercel and
  starts throttling around 5+ concurrent connections.
- Don't write per-record JSON files. Mongo imports are cheaper from one big
  array per collection, and the dataset is small enough that there's no
  point in sharding.
- Don't pre-compute matchup affinities into a separate file. We tried it;
  the resulting table only covered the top-N pairs and produced misleading
  zeros for long-tail tools (e.g. MongoDB at rank #8 in Database). Compute
  on demand from `data.matches`.
