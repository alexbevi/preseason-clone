import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Dataset } from "../data";
import {
  fmtInt,
  fmtPct,
  orient,
  rollup,
  wilson95,
  MIN_DECISIVE_CASES,
  promptHref,
} from "../synth";
import type { OrientedRow } from "../synth";
import type { BreakdownRow, Match, Tool } from "../types";
import { ToolLogo } from "../components/ToolLogo";
import { SortableTable, type Column } from "../components/SortableTable";

/**
 * Build aggregated per-row stats for the focal tool by walking every match
 * it appears in. Each row's `aPicks` is the focal tool's picks, `bPicks`
 * is the sum of opponent picks across all of those matches.
 */
function aggregateBreakdown(
  matches: Match[],
  toolSlug: string,
  field: "perModel" | "perPrompt",
  filterSub?: string,
): { rows: OrientedRow[]; matchesUsed: number } {
  type Acc = { key: string; tier: string; aPicks: number; bPicks: number; none: number; other: number };
  // For perPrompt the same slug appears at three difficulty tiers, so we
  // accumulate by (key, tier) to keep each prompt-level its own row. Per-model
  // rows have no tier dimension, so their tier is empty and the composite
  // collapses to just the model name.
  const acc = new Map<string, Acc>();
  let used = 0;
  for (const m of matches) {
    if (filterSub && m.subSlug !== filterSub) continue;
    const swap = m.toolASlug !== toolSlug;
    used += 1;
    const oriented = orient(m[field] as BreakdownRow[], swap);
    for (const r of oriented) {
      const accKey = field === "perPrompt" ? `${r.key}|${r.tier}` : r.key;
      const cur = acc.get(accKey) ?? {
        key: r.key,
        tier: r.tier,
        aPicks: 0,
        bPicks: 0,
        none: 0,
        other: 0,
      };
      cur.aPicks += r.aPicks;
      cur.bPicks += r.bPicks;
      cur.none += r.none;
      cur.other += r.other;
      cur.tier = cur.tier || r.tier;
      acc.set(accKey, cur);
    }
  }
  const rows: OrientedRow[] = Array.from(acc.values()).map((v) => ({
    key: v.key,
    tier: v.tier,
    aPicks: v.aPicks,
    bPicks: v.bPicks,
    none: v.none,
    other: v.other,
    aRateConditional:
      v.aPicks + v.bPicks > 0 ? v.aPicks / (v.aPicks + v.bPicks) : 0,
  }));
  rows.sort((x, y) => y.aPicks + y.bPicks - (x.aPicks + x.bPicks));
  return { rows, matchesUsed: used };
}

/** Aggregate per-opponent record so users can see who this tool beats. */
function opponentRecord(
  matches: Match[],
  toolSlug: string,
  toolBySlug: Map<string, Tool>,
  filterSub?: string,
): {
  opponentSlug: string;
  opponentName: string;
  subSlug: string;
  aWins: number;
  bWins: number;
  aRate: number;
  decisive: number;
}[] {
  const out: ReturnType<typeof opponentRecord> = [];
  for (const m of matches) {
    if (filterSub && m.subSlug !== filterSub) continue;
    const swap = m.toolASlug !== toolSlug;
    const oriented = orient(m.perModel, swap);
    const sum = rollup(oriented);
    const opponentSlug = swap ? m.toolASlug : m.toolBSlug;
    out.push({
      opponentSlug,
      opponentName:
        toolBySlug.get(opponentSlug)?.name ??
        (swap ? m.toolALabel : m.toolBLabel),
      subSlug: m.subSlug,
      aWins: sum.aWins,
      bWins: sum.bWins,
      aRate: sum.aWinRateConditional,
      decisive: sum.decisiveCases,
    });
  }
  out.sort((x, y) => y.aRate - x.aRate);
  return out;
}

export function ToolDetail({ data }: { data: Dataset }) {
  const { slug = "" } = useParams();
  const tool = data.toolBySlug.get(slug);
  const detail = data.toolDetailBySlug.get(slug);
  const ranking = data.rankingBySlug.get(slug);
  const matches = data.matchesByTool.get(slug) ?? [];

  const subs = useMemo(() => {
    const present = new Set(matches.map((m) => m.subSlug));
    const out: { subSlug: string; name: string }[] = [
      { subSlug: "", name: "All Categories" },
    ];
    for (const c of data.categories) {
      for (const s of c.subcategories) {
        if (present.has(s.slug))
          out.push({ subSlug: s.slug, name: s.name });
      }
    }
    return out;
  }, [data, matches]);

  const [filterSub, setFilterSub] = useState<string>("");

  const perModel = useMemo(
    () => aggregateBreakdown(matches, slug, "perModel", filterSub || undefined),
    [matches, slug, filterSub],
  );
  const perPrompt = useMemo(
    () =>
      aggregateBreakdown(matches, slug, "perPrompt", filterSub || undefined),
    [matches, slug, filterSub],
  );
  const opponents = useMemo(
    () => opponentRecord(matches, slug, data.toolBySlug, filterSub || undefined),
    [matches, slug, data, filterSub],
  );

  const headlineSummary = useMemo(() => rollup(perModel.rows), [perModel]);

  if (!tool) {
    return (
      <div className="card empty-state">
        <strong>Unknown tool</strong>
        <Link to="/">Back to matchups</Link>
      </div>
    );
  }

  const ci =
    headlineSummary.decisiveCases > 0
      ? wilson95(headlineSummary.aWins, headlineSummary.decisiveCases)
      : ([0, 0] as [number, number]);

  return (
    <>
      <div className="tool-header">
        <ToolLogo tool={tool} size={56} />
        <div>
          <h2 style={{ margin: 0 }}>{tool.name}</h2>
          {ranking && (
            <div className="muted" style={{ fontSize: 13 }}>
              {fmtPct(ranking.weightedSupportRate)} overall support ·{" "}
              {fmtInt(ranking.weightedSupport)} picks ·{" "}
              {fmtInt(ranking.weightedEligible)} eligible
            </div>
          )}
        </div>
      </div>
      {detail?.description && (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="section-title">Description</p>
          <p style={{ margin: 0 }}>{detail.description}</p>
        </div>
      )}

      {ranking && <PublishedStats ranking={ranking} />}

      <CategoryRankings data={data} slug={slug} />


      {matches.length === 0 ? (
        <div className="card empty-state" style={{ marginTop: 16 }}>
          <strong>No scraped matchups</strong>
          preseason.ai didn't generate pairwise matches for {tool.name}.
        </div>
      ) : (
        <>
          <div className="controls" style={{ marginTop: 24 }}>
            <div className="control">
              <label>Filter by category</label>
              <select
                value={filterSub}
                onChange={(e) => setFilterSub(e.target.value)}
              >
                {subs.map((s) => (
                  <option key={s.subSlug || "all"} value={s.subSlug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="summary" style={{ marginTop: 16 }}>
            <div>
              <div className="label">Aggregate decisive win rate</div>
              <div className="value" style={{ color: "var(--accent)" }}>
                {fmtPct(headlineSummary.aWinRateConditional)}
              </div>
              <div className="sub">across all matchups</div>
            </div>
            <div>
              <div className="label">{tool.name} picks</div>
              <div className="value">{fmtInt(headlineSummary.aWins)}</div>
              <div className="sub">decisive: {fmtInt(headlineSummary.decisiveCases)}</div>
            </div>
            <div>
              <div className="label">Opponent picks</div>
              <div className="value">{fmtInt(headlineSummary.bWins)}</div>
              <div className="sub">in {fmtInt(perModel.matchesUsed)} matchups</div>
            </div>
            <div>
              <div className="label">95% CI</div>
              <div className="value">
                {fmtPct(ci[0])} – {fmtPct(ci[1])}
              </div>
              <div className="sub">Wilson interval</div>
            </div>
          </div>

          <OpponentsTable rows={opponents} />

          <AggregateTable
            title="Per-model breakdown (across all matchups)"
            rowLabel="Model"
            rows={perModel.rows}
            toolName={tool.name}
          />
          <AggregateTable
            title="Per-prompt breakdown (across all matchups)"
            rowLabel="Prompt"
            rows={perPrompt.rows}
            toolName={tool.name}
          />
        </>
      )}
    </>
  );
}

function PublishedStats({ ranking }: { ranking: import("../types").Ranking }) {
  const trendDir =
    ranking.trend > 0 ? "up" : ranking.trend < 0 ? "down" : "flat";
  const trendArrow = trendDir === "up" ? "▲" : trendDir === "down" ? "▼" : "·";
  const trendColor =
    trendDir === "up"
      ? "var(--good)"
      : trendDir === "down"
        ? "var(--bad)"
        : "var(--text-muted)";
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <p className="section-title">Published stats (from preseason.ai rankings)</p>
      <div className="summary">
        <div>
          <div className="label">Weighted support rate</div>
          <div className="value" style={{ color: "var(--accent)" }}>
            {fmtPct(ranking.weightedSupportRate)}
          </div>
          <div className="sub">picks / eligible (model-tier weighted)</div>
        </div>
        <div>
          <div className="label">Published 95% CI</div>
          <div className="value">
            {fmtPct(ranking.ciLow)} – {fmtPct(ranking.ciHigh)}
          </div>
          <div className="sub">on weighted support rate</div>
        </div>
        <div>
          <div className="label">Trend</div>
          <div className="value" style={{ color: trendColor }}>
            {ranking.trend === 0
              ? "—"
              : `${trendArrow} ${fmtPct(Math.abs(ranking.trend))}`}
          </div>
          <div className="sub">vs prior season</div>
        </div>
        <div>
          <div className="label">Coverage</div>
          <div className="value">
            {fmtPct(ranking.modelCoverage)} / {fmtPct(ranking.promptCoverage)}
          </div>
          <div className="sub">models / prompts</div>
        </div>
      </div>
    </div>
  );
}

function CategoryRankings({ data, slug }: { data: Dataset; slug: string }) {
  const rows = data.rankingsByTool.get(slug) ?? [];
  if (rows.length === 0) return null;
  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    {
      key: "category",
      label: "Category",
      sortValue: (r) => r.categoryName,
      render: (r) => r.categoryName,
    },
    {
      key: "rank",
      label: "Rank",
      numeric: true,
      sortValue: (r) => r.rankInSub,
      render: (r) => `#${r.rankInSub} / ${r.totalInSub}`,
    },
    {
      key: "rate",
      label: "Support rate",
      numeric: true,
      sortValue: (r) => r.supportRate,
      render: (r) => (r.supportRate != null ? fmtPct(r.supportRate) : "—"),
    },
    {
      key: "picks",
      label: "Picks",
      numeric: true,
      sortValue: (r) => r.support,
      render: (r) =>
        r.support != null && r.eligible != null
          ? `${fmtInt(r.support)} / ${fmtInt(r.eligible)}`
          : "—",
    },
  ];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <p className="section-title">Per-category rankings (scraped from /tools/{slug})</p>
      <SortableTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.subSlug}
        defaultSort={{ key: "rank", dir: "asc" }}
        hideEmpty={{
          label: "Hide categories with zero picks",
          isEmpty: (r) => (r.support ?? 0) === 0,
        }}
      />
    </div>
  );
}

function OpponentsTable({
  rows,
}: {
  rows: ReturnType<typeof opponentRecord>;
}) {
  if (rows.length === 0) return null;
  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    {
      key: "opponent",
      label: "Opponent",
      sortValue: (r) => r.opponentName,
      render: (r) => (
        <>
          <Link to={`/tool/${r.opponentSlug}`}>{r.opponentName}</Link>
          {r.decisive < MIN_DECISIVE_CASES && (
            <span
              className="flag"
              title={`Below preseason.ai's ${MIN_DECISIVE_CASES}-decisive threshold`}
            >
              low n
            </span>
          )}
        </>
      ),
    },
    {
      key: "category",
      label: "Category",
      sortValue: (r) => r.subSlug,
      render: (r) => r.subSlug,
      className: "tier",
    },
    {
      key: "aWins",
      label: "Picks",
      numeric: true,
      sortValue: (r) => r.aWins,
      render: (r) => fmtInt(r.aWins),
    },
    {
      key: "bWins",
      label: "Opp picks",
      numeric: true,
      sortValue: (r) => r.bWins,
      render: (r) => fmtInt(r.bWins),
    },
    {
      key: "decisive",
      label: "Decisive",
      numeric: true,
      sortValue: (r) => r.decisive,
      render: (r) => fmtInt(r.decisive),
    },
    {
      key: "rate",
      label: "Decisive win rate",
      numeric: true,
      sortValue: (r) => r.aRate,
      render: (r) => fmtPct(r.aRate),
    },
    {
      key: "bar",
      label: "",
      sortable: false,
      render: (r) => (
        <span className="bar-cell">
          <span
            className="a-fill"
            style={{ width: `${r.aRate * 100}%` }}
          />
          <span
            className="b-fill"
            style={{ width: `${(1 - r.aRate) * 100}%` }}
          />
        </span>
      ),
    },
  ];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <p className="section-title">Head-to-head record by opponent</p>
      <SortableTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.opponentSlug}-${r.subSlug}`}
        defaultSort={{ key: "rate", dir: "desc" }}
        hideEmpty={{
          label: "Hide matchups with no decisive cases",
          isEmpty: (r) => r.decisive === 0,
        }}
      />
    </div>
  );
}

function AggregateTable({
  title,
  rowLabel,
  rows,
  toolName,
}: {
  title: string;
  rowLabel: string;
  rows: OrientedRow[];
  toolName: string;
}) {
  if (rows.length === 0) return null;
  const columns: Column<OrientedRow>[] = [
    {
      key: "key",
      label: rowLabel,
      sortValue: (r) => r.key,
      render: (r) =>
        rowLabel === "Prompt" ? (
          <Link to={promptHref(r.key, r.tier)}>{r.key}</Link>
        ) : (
          r.key
        ),
    },
    {
      key: "tier",
      label: "Tier",
      sortValue: (r) => r.tier,
      render: (r) => r.tier,
      className: "tier",
    },
    {
      key: "aPicks",
      label: toolName,
      numeric: true,
      sortValue: (r) => r.aPicks,
      render: (r) => fmtInt(r.aPicks),
    },
    {
      key: "bPicks",
      label: "Opponents",
      numeric: true,
      sortValue: (r) => r.bPicks,
      render: (r) => fmtInt(r.bPicks),
    },
    {
      key: "none",
      label: "None",
      numeric: true,
      sortValue: (r) => r.none,
      render: (r) => fmtInt(r.none),
    },
    {
      key: "other",
      label: "Other",
      numeric: true,
      sortValue: (r) => r.other,
      render: (r) => fmtInt(r.other),
    },
    {
      key: "rate",
      label: "Decisive win rate",
      numeric: true,
      sortValue: (r) => r.aRateConditional,
      render: (r) => fmtPct(r.aRateConditional),
    },
    {
      key: "bar",
      label: "",
      sortable: false,
      render: (r) => (
        <span className="bar-cell">
          <span
            className="a-fill"
            style={{ width: `${r.aRateConditional * 100}%` }}
          />
          <span
            className="b-fill"
            style={{ width: `${(1 - r.aRateConditional) * 100}%` }}
          />
        </span>
      ),
    },
  ];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <p className="section-title">{title}</p>
      <SortableTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.key}|${r.tier}`}
        defaultSort={{ key: "aPicks", dir: "desc" }}
        hideEmpty={{
          label: "Hide rows where neither side was picked",
          isEmpty: (r) => r.aPicks === 0 && r.bPicks === 0,
        }}
      />
    </div>
  );
}
