import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Dataset } from "../data";
import { matchKey } from "../data";
import { fmtInt, fmtPct, resolveMatch } from "../synth";
import type { MatchupSummary } from "../synth";
import type { Ranking, Tool } from "../types";
import { ToolLogo } from "../components/ToolLogo";
import { BreakdownTable } from "../components/BreakdownTable";
import { ToolCombobox } from "../components/ToolCombobox";


export function Matchups({ data }: { data: Dataset }) {
  const subs = useMemo(() => {
    const all: { subSlug: string; name: string }[] = [
      { subSlug: "", name: "All Categories" },
    ];
    for (const c of data.categories) {
      for (const s of c.subcategories) {
        if (data.toolsBySub.has(s.slug))
          all.push({ subSlug: s.slug, name: s.name });
      }
    }
    return all;
  }, [data]);

  const [subSlug, setSubSlug] = useState<string>("");

  // Tools the user can pick from. With a category selected, restrict to
  // the tools the site actually lists in that subcategory's leaderboard
  // (sorted by rank). With "All Categories", show every ranked tool
  // alphabetical.
  const tools = useMemo<Tool[]>(() => {
    if (!subSlug) {
      return data.tools
        .filter((t) => data.rankingBySlug.has(t.slug))
        .slice()
        .sort((x, y) => x.name.localeCompare(y.name));
    }
    const ranked = data.toolsBySub.get(subSlug) ?? [];
    return ranked
      .map((tr) => data.toolBySlug.get(tr.toolSlug))
      .filter((t): t is Tool => Boolean(t))
      .slice()
      .sort((x, y) => x.name.localeCompare(y.name));
  }, [data, subSlug]);

  const [aSlug, setASlug] = useState<string>("");
  const [bSlug, setBSlug] = useState<string>("");

  useEffect(() => {
    // Default to the top two by ranking (per-sub leaderboard order, or
    // global support rate when "All Categories").
    if (tools.length >= 2) {
      setASlug(tools[0].slug);
      setBSlug(tools[1].slug);
    } else {
      setASlug(tools[0]?.slug ?? "");
      setBSlug("");
    }
  }, [subSlug, tools]);

  const a = data.toolBySlug.get(aSlug);
  const b = data.toolBySlug.get(bSlug);
  const rA = data.rankingBySlug.get(aSlug);
  const rB = data.rankingBySlug.get(bSlug);

  const resolved = useMemo(() => {
    if (!a || !b) return null;
    const candidates = subSlug
      ? data.matches.filter(
          (m) =>
            m.subSlug === subSlug &&
            ((m.toolASlug === a.slug && m.toolBSlug === b.slug) ||
              (m.toolASlug === b.slug && m.toolBSlug === a.slug)),
        )
      : (() => {
          const m = data.matchByPair.get(matchKey(a.slug, b.slug));
          return m ? [m] : [];
        })();
    if (candidates.length === 0) return null;
    return resolveMatch(candidates[0], a.slug);
  }, [a, b, subSlug, data]);

  return (
    <>
      <Controls
        subs={subs}
        subSlug={subSlug}
        setSubSlug={setSubSlug}
        tools={tools}
        aSlug={aSlug}
        bSlug={bSlug}
        setASlug={setASlug}
        setBSlug={setBSlug}
      />

      {!a || !b || !rA || !rB ? (
        <div className="card empty-state">
          <strong>Pick two tools</strong>
          Use the selectors above to compare any two tools head-to-head.
        </div>
      ) : !resolved ? (
        <>
          <div className="matchup">
            <ToolCard tool={a} ranking={rA} side="a" />
            <span className="versus">VS</span>
            <ToolCard tool={b} ranking={rB} side="b" />
          </div>
          <div className="card empty-state">
            <strong>No scraped matchup for this pair</strong>
            preseason.ai only generates pairwise matches for the top ~10 tools
            per category, so most long-tail pairs have no scraped data. Try
            picking two tools that both appear within the same category.
          </div>
        </>
      ) : (
        <>
          <div className="matchup">
            <ToolCard
              tool={a}
              ranking={rA}
              picks={resolved.summary.aWins}
              side="a"
            />
            <span className="versus">VS</span>
            <ToolCard
              tool={b}
              ranking={rB}
              picks={resolved.summary.bWins}
              side="b"
            />
          </div>

          <SummaryCard a={a} b={b} summary={resolved.summary} />

          <BreakdownTable
            title="Per-model breakdown (scraped)"
            rowLabel="Model"
            aLabel={a.name}
            bLabel={b.name}
            rows={resolved.perModel}
          />
          <BreakdownTable
            title="Per-prompt breakdown (scraped)"
            rowLabel="Prompt"
            aLabel={a.name}
            bLabel={b.name}
            rows={resolved.perPrompt}
          />
        </>
      )}
    </>
  );
}

function Controls(props: {
  subs: { subSlug: string; name: string }[];
  subSlug: string;
  setSubSlug: (s: string) => void;
  tools: Tool[];
  aSlug: string;
  bSlug: string;
  setASlug: (s: string) => void;
  setBSlug: (s: string) => void;
}) {
  const {
    subs,
    subSlug,
    setSubSlug,
    tools,
    aSlug,
    bSlug,
    setASlug,
    setBSlug,
  } = props;

  return (
    <div className="controls">
      <div className="control">
        <label>Category</label>
        <select value={subSlug} onChange={(e) => setSubSlug(e.target.value)}>
          {subs.map((s) => (
            <option key={s.subSlug || "all"} value={s.subSlug}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="control">
        <label>Tool A</label>
        <ToolCombobox
          tools={tools.filter((t) => t.slug !== bSlug)}
          value={aSlug}
          onChange={setASlug}
        />
      </div>
      <div className="control">
        <label>Tool B</label>
        <ToolCombobox
          tools={tools.filter((t) => t.slug !== aSlug)}
          value={bSlug}
          onChange={setBSlug}
        />
      </div>
    </div>
  );
}

function ToolCard({
  tool,
  ranking,
  picks,
  side,
}: {
  tool: Tool;
  ranking: Ranking;
  picks?: number;
  side: "a" | "b";
}) {
  return (
    <Link className="tool-card" to={`/tool/${tool.slug}`}>
      <ToolLogo tool={tool} />
      <div className="meta">
        <div className="name">{tool.name}</div>
        <div
          className="sub"
          style={{ color: side === "a" ? "var(--accent)" : "var(--accent-2)" }}
        >
          {picks !== undefined
            ? `${fmtInt(picks)} picks in this matchup`
            : `${fmtPct(ranking.weightedSupportRate)} support overall`}
        </div>
      </div>
    </Link>
  );
}

function SummaryCard({
  a,
  b,
  summary,
}: {
  a: Tool;
  b: Tool;
  summary: MatchupSummary;
}) {
  const aPct = summary.aWinRateConditional;
  const bPct = 1 - aPct;
  return (
    <>
      <div className="summary">
        <div>
          <div className="label">{a.name} win rate</div>
          <div className="value" style={{ color: "var(--accent)" }}>
            {fmtPct(aPct)}
          </div>
          <div className="sub">{fmtInt(summary.aWins)} picks</div>
        </div>
        <div>
          <div className="label">{b.name} win rate</div>
          <div className="value" style={{ color: "var(--accent-2)" }}>
            {fmtPct(bPct)}
          </div>
          <div className="sub">{fmtInt(summary.bWins)} picks</div>
        </div>
        <div>
          <div className="label">95% CI ({a.name})</div>
          <div className="value">
            {fmtPct(summary.conditionalCI[0])} – {fmtPct(summary.conditionalCI[1])}
          </div>
          <div className="sub">Wilson interval</div>
        </div>
        <div>
          <div className="label">Decisive cases</div>
          <div className="value">{fmtInt(summary.decisiveCases)}</div>
          <div className="sub">
            {fmtInt(summary.abstains)} abstains · {fmtInt(summary.otherChosen)} other
          </div>
        </div>
      </div>
      <div className="win-bar">
        <div className="a" style={{ width: `${aPct * 100}%` }} />
        <div className="b" style={{ width: `${bPct * 100}%` }} />
      </div>
      <div className="win-legend">
        <span className="a-label">{a.name}</span>
        <span className="b-label">{b.name}</span>
      </div>
    </>
  );
}

