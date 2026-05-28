import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import type { Dataset } from "../data";
import { fmtInt, fmtPct, orient } from "../synth";
import { SortableTable, type Column } from "../components/SortableTable";

type PromptToolStat = {
  toolSlug: string;
  toolName: string;
  picks: number;
  total: number;
  rate: number;
};

/**
 * For a single prompt slug, figure out how each tool performs across every
 * scraped match by pulling that prompt's row out of each match's perPrompt
 * breakdown. Returns a per-tool aggregate of picks/total along with a
 * sorted leaderboard.
 */
function aggregatePromptStats(
  data: Dataset,
  promptSlug: string,
): {
  perTool: PromptToolStat[];
  totalDecisive: number;
  matchesUsed: number;
} {
  const acc = new Map<string, { picks: number; total: number }>();
  let totalDecisive = 0;
  let matchesUsed = 0;

  for (const m of data.matches) {
    const row = m.perPrompt.find((r) => r.key === promptSlug);
    if (!row) continue;
    matchesUsed += 1;
    // Treat tool A's perspective: a's picks for A on this prompt, b's for B
    const oriented = orient([row], false)[0];
    const decisive = oriented.aPicks + oriented.bPicks;
    totalDecisive += decisive;

    for (const [slug, picks] of [
      [m.toolASlug, oriented.aPicks],
      [m.toolBSlug, oriented.bPicks],
    ] as [string, number][]) {
      const cur = acc.get(slug) ?? { picks: 0, total: 0 };
      cur.picks += picks;
      // "Total" for this tool on this prompt = decisive cases this tool
      // participated in. Each match contributes its decisive count to both
      // tools (since both were eligible head-to-head).
      cur.total += decisive;
      acc.set(slug, cur);
    }
  }

  const perTool: PromptToolStat[] = Array.from(acc.entries()).map(([slug, v]) => ({
    toolSlug: slug,
    toolName: data.toolBySlug.get(slug)?.name ?? slug,
    picks: v.picks,
    total: v.total,
    rate: v.total > 0 ? v.picks / v.total : 0,
  }));
  perTool.sort((x, y) => y.picks - x.picks);
  return { perTool, totalDecisive, matchesUsed };
}

export function PromptDetail({ data }: { data: Dataset }) {
  const { slug = "" } = useParams();
  const prompt = data.promptBySlug.get(slug);
  const detail = data.promptDetailBySlug.get(slug);

  const stats = useMemo(() => aggregatePromptStats(data, slug), [data, slug]);

  if (!prompt) {
    return (
      <div className="card empty-state">
        <strong>Unknown prompt</strong>
        <Link to="/prompts">Back to prompts</Link>
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Link to="/prompts" className="muted" style={{ fontSize: 13 }}>
          ← All prompts
        </Link>
      </div>
      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h2 style={{ margin: 0 }}>{prompt.title}</h2>
          <span className="tier">{prompt.level}</span>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          {prompt.slug}
        </div>
        {prompt.description && (
          <p style={{ marginTop: 12 }}>{prompt.description}</p>
        )}
        {detail?.promptText && (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontFamily: "var(--mono)",
              fontSize: 13,
              background: "var(--bg-elev-2)",
              padding: 16,
              borderRadius: 8,
              border: "1px solid var(--border)",
              marginTop: 12,
            }}
          >
            {detail.promptText}
          </pre>
        )}
        {prompt.expectedCategories?.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="section-title">Expected categories</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {prompt.expectedCategories.map((c) => (
                <span key={c} className="tier" style={{ fontSize: 12 }}>
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {stats.perTool.length === 0 ? (
        <div className="card empty-state" style={{ marginTop: 16 }}>
          <strong>No scraped matchup data for this prompt yet</strong>
          This prompt didn't appear in any scraped per-prompt breakdown.
        </div>
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="section-title">
            Tool leaderboard for this prompt · {fmtInt(stats.matchesUsed)} matchups,
            {" "}
            {fmtInt(stats.totalDecisive)} decisive cases
          </p>
          <SortableTable
            columns={promptToolColumns}
            rows={stats.perTool}
            rowKey={(r) => r.toolSlug}
            defaultSort={{ key: "rate", dir: "desc" }}
            hideEmpty={{
              label: "Hide tools with zero picks",
              isEmpty: (r) => r.picks === 0,
            }}
          />
        </div>
      )}
    </>
  );
}

const promptToolColumns: Column<PromptToolStat>[] = [
  {
    key: "tool",
    label: "Tool",
    sortValue: (r) => r.toolName,
    render: (r) => <Link to={`/tool/${r.toolSlug}`}>{r.toolName}</Link>,
  },
  {
    key: "picks",
    label: "Picks",
    numeric: true,
    sortValue: (r) => r.picks,
    render: (r) => fmtInt(r.picks),
  },
  {
    key: "total",
    label: "Decisive (in matchups)",
    numeric: true,
    sortValue: (r) => r.total,
    render: (r) => fmtInt(r.total),
  },
  {
    key: "rate",
    label: "Pick rate",
    numeric: true,
    sortValue: (r) => r.rate,
    render: (r) => fmtPct(r.rate),
  },
  {
    key: "bar",
    label: "",
    sortable: false,
    render: (r) => (
      <span className="bar-cell">
        <span className="a-fill" style={{ width: `${r.rate * 100}%` }} />
      </span>
    ),
  },
];
