# preseason-clone

A clone of [preseason.ai](https://www.preseason.ai) built from a snapshot of
their public data. Two parts:

- **`scrape.py`** — a stdlib-only Python scraper that walks preseason.ai's
  pages, decodes the embedded Next.js RSC payload, and writes structured JSON
  to `data/json/`.
- **`web/`** — a Vite + React + TypeScript single-page app that loads those
  JSON files and renders matchups, tool detail pages, prompt detail pages,
  and per-category rankings.

## Quick start

```bash
cd web
npm install
npm run dev   # http://localhost:5173
```

The `predev` and `prebuild` hooks copy `data/json/*.json` into
`web/public/data/` automatically. If you re-run the scraper, the next
`npm run dev` / `npm run build` picks up the fresh data.

## Re-scraping (optional)

```bash
python3 scrape.py inventory   # categories + tools + prompts + featured matches
python3 scrape.py plan        # build scrape_plan.json
python3 scrape.py scrape      # cache raw HTML to data/raw/ (resumable)
python3 scrape.py extract     # parse cached HTML → data/json/
python3 scrape.py all         # all four in sequence
```

`scrape` is two-pass: first per-subcategory ranking pages, then a re-plan to
generate pairwise match URLs from the real per-category leaderboards
extracted from `/tools/{slug}` pages.

Throttling: 2 concurrent requests, 500–800ms jitter, exponential backoff on
HTTP 429/503. The disk cache (`data/raw/`, ~600 MB, gitignored) makes the
pipeline resumable — re-running `scrape` skips files already cached.

## Data files (`data/json/`)

| File | Contents |
|---|---|
| `categories.json` | 8 top-level groups, each with subcategory list |
| `tools.json` | 323 tools (id, slug, name, logoUrl) |
| `tools_detail.json` | Per-tool name + description (94 with descriptions) |
| `rankings.json` | Group-level rankings (weighted/raw support, CI, trend, coverage) |
| `rankings_sub.json` | Per-subcategory rankings (UI-only filter on the site — same numbers as `rankings.json`; kept for completeness) |
| `tool_rankings.json` | 315 rows: each tool's actual rank within each subcategory it participates in (`#8/44`, support rate, etc.) — extracted from `/tools/{slug}` pages |
| `prompts.json` | 51 prompts (id, slug, level, description, expectedCategories) |
| `prompts_detail.json` | Per-prompt full text |
| `matches_featured.json` | 12 featured matchups with full structured `modelBreakdown` and `promptBreakdown` (UUIDs included) |
| `matches.json` | 3,132 pairwise matchups across all subcategories. Each has `perModel` (~19 rows) + `perPrompt` (~45 rows) breakdowns |
| `models.json` | 19 LLM models (id, label, tier) — derived from `matches_featured.json`'s `modelBreakdown` |

## MongoDB import

The JSON files are arrays of plain objects, suitable for direct import:

```bash
for f in categories tools rankings rankings_sub tool_rankings prompts \
         prompts_detail matches matches_featured models tools_detail; do
  mongoimport --db preseason --collection $f --jsonArray --file data/json/$f.json
done
```

## What the web app does

- **Matchups** (`/`): pick a category and any two tools from the dropdown
  (typeahead). Computes win rate, decisive cases, Wilson 95% CI, and
  per-model + per-prompt breakdowns from raw scraped data.
- **Tool detail** (`/tool/:slug`): per-category rankings, head-to-head record
  by opponent, aggregated per-model and per-prompt performance across every
  matchup the tool appears in.
- **Prompts** (`/prompts`, `/prompt/:slug`): prompt directory and per-prompt
  tool leaderboard computed across every matchup that includes the prompt.

All tables are sortable (click any header) and offer a "hide rows with no
results" filter.

## A note on the numbers

This project scrapes preseason.ai's public pages — it does not re-run the
benchmark. A few things our app does differently than the source site, called
out so the numbers don't surprise you:

- **"Win rate" is decisive-only.** We compute `aPicks / (aPicks + bPicks)`,
  ignoring None/Other. preseason.ai's "support rate" is `picks / eligible` —
  not the same number when models often abstain.
- **Aggregates are unweighted across model tiers.** The site applies
  model-tier weighting; our `/tool/:slug` rollups sum picks straight across
  tiers.
- **No insufficient-data threshold.** The site only publishes matchups with
  ≥30 decisive cases. We render whatever rows exist.

## Caveats

- preseason.ai has no public API. All data is parsed out of HTML/RSC
  payloads. Selectors will break if the site changes its rendering. See
  `CLAUDE.md` for parser internals.
- The site is on Vercel and starts throttling around 5+ concurrent
  connections. Don't increase scraper concurrency above 3.
- This is a research / personal project. It is not affiliated with or
  endorsed by preseason.ai.
