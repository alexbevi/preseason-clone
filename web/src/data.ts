import type {
  Category,
  Match,
  ModelMeta,
  Prompt,
  PromptDetail,
  PromptTopTool,
  Ranking,
  Tool,
  ToolDetail,
  ToolRanking,
  BreakdownRow,
} from "./types";

async function loadJSON<T>(path: string): Promise<T> {
  // Resolve relative to Vite's BASE_URL so the same code works under
  // GitHub Pages (/preseason-clone/) and local dev (/).
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const url = path.startsWith("/") ? `${base}${path}` : path;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Raw shape of one match in matches.json. The scraped JSON keys each
 *  breakdown column with the tool's display name, so we don't know the
 *  schema statically. */
type RawMatchRow = Record<string, string | number>;
type RawMatch = {
  toolALabel: string;
  toolBLabel: string;
  toolASlug: string;
  toolBSlug: string;
  groupSlug: string;
  subSlug: string;
  perModel: RawMatchRow[];
  perPrompt: RawMatchRow[];
  _url: string;
};

const num = (v: unknown): number =>
  typeof v === "number" ? v : Number(v ?? 0) || 0;

function normalizeRow(
  row: RawMatchRow,
  keyField: "Model" | "Prompt",
  aLabel: string,
  bLabel: string,
): BreakdownRow {
  return {
    key: String(row[keyField] ?? ""),
    tier: String(row["Tier"] ?? ""),
    aPicks: num(row[aLabel]),
    bPicks: num(row[bLabel]),
    none: num(row["None"]),
    other: num(row["Other"]),
  };
}

export type MatchKey = string; // "aSlug|bSlug" with aSlug < bSlug

export const matchKey = (x: string, y: string): MatchKey =>
  x < y ? `${x}|${y}` : `${y}|${x}`;

export type Dataset = {
  categories: Category[];
  tools: Tool[];
  toolsDetail: ToolDetail[];
  rankings: Ranking[];
  toolRankings: ToolRanking[];
  prompts: Prompt[];
  promptsDetail: PromptDetail[];
  promptTopTools: PromptTopTool[];
  models: ModelMeta[];
  matches: Match[];
  // lookups
  toolBySlug: Map<string, Tool>;
  toolDetailBySlug: Map<string, ToolDetail>;
  rankingBySlug: Map<string, Ranking>;
  /** Keyed by `${slug}|${level}` since each prompt slug exists at three
   *  difficulty levels (beginner / intermediate / advanced). */
  promptByKey: Map<string, Prompt>;
  promptDetailByKey: Map<string, PromptDetail>;
  /** Top-recommendations rows grouped by `${slug}|${level}`, sorted by rank ASC. */
  promptTopToolsByKey: Map<string, PromptTopTool[]>;
  matchByPair: Map<MatchKey, Match>;
  matchesByTool: Map<string, Match[]>;
  subBySlug: Map<string, { groupSlug: string; subSlug: string; name: string }>;
  /** Tools listed in each subcategory's leaderboard, sorted by rank ASC. */
  toolsBySub: Map<string, ToolRanking[]>;
  /** Per-tool list of category memberships, sorted by rank ASC. */
  rankingsByTool: Map<string, ToolRanking[]>;
};

export async function loadDataset(): Promise<Dataset> {
  const [
    categories,
    tools,
    toolsDetail,
    rankings,
    toolRankings,
    prompts,
    promptsDetail,
    promptTopTools,
    models,
    rawMatches,
  ] = await Promise.all([
    loadJSON<Category[]>("/data/categories.json"),
    loadJSON<Tool[]>("/data/tools.json"),
    loadJSON<ToolDetail[]>("/data/tools_detail.json"),
    loadJSON<Ranking[]>("/data/rankings.json"),
    loadJSON<ToolRanking[]>("/data/tool_rankings.json"),
    loadJSON<Prompt[]>("/data/prompts.json"),
    loadJSON<PromptDetail[]>("/data/prompts_detail.json"),
    loadJSON<PromptTopTool[]>("/data/prompt_top_tools.json"),
    loadJSON<ModelMeta[]>("/data/models.json"),
    loadJSON<RawMatch[]>("/data/matches.json"),
  ]);

  const matches: Match[] = rawMatches.map((m) => ({
    groupSlug: m.groupSlug,
    subSlug: m.subSlug,
    toolASlug: m.toolASlug,
    toolBSlug: m.toolBSlug,
    toolALabel: m.toolALabel,
    toolBLabel: m.toolBLabel,
    perModel: m.perModel.map((r) =>
      normalizeRow(r, "Model", m.toolALabel, m.toolBLabel),
    ),
    perPrompt: m.perPrompt.map((r) =>
      normalizeRow(r, "Prompt", m.toolALabel, m.toolBLabel),
    ),
    url: m._url,
  }));

  const toolBySlug = new Map(tools.map((t) => [t.slug, t]));
  const toolDetailBySlug = new Map(toolsDetail.map((t) => [t.slug, t]));
  const rankingBySlug = new Map(rankings.map((r) => [r.toolSlug, r]));
  const promptKey = (slug: string, level: string) => `${slug}|${level}`;
  const promptByKey = new Map(
    prompts.map((p) => [promptKey(p.slug, p.level), p]),
  );
  const promptDetailByKey = new Map(
    promptsDetail.map((p) => [promptKey(p.slug, p.level), p]),
  );

  const promptTopToolsByKey = new Map<string, PromptTopTool[]>();
  for (const r of promptTopTools) {
    const k = promptKey(r.promptSlug, r.level);
    const arr = promptTopToolsByKey.get(k) ?? [];
    arr.push(r);
    promptTopToolsByKey.set(k, arr);
  }
  for (const arr of promptTopToolsByKey.values()) arr.sort((a, b) => a.rank - b.rank);

  const matchByPair = new Map<MatchKey, Match>();
  const matchesByTool = new Map<string, Match[]>();
  for (const m of matches) {
    matchByPair.set(matchKey(m.toolASlug, m.toolBSlug), m);
    for (const slug of [m.toolASlug, m.toolBSlug]) {
      const arr = matchesByTool.get(slug) ?? [];
      arr.push(m);
      matchesByTool.set(slug, arr);
    }
  }

  const subBySlug = new Map<
    string,
    { groupSlug: string; subSlug: string; name: string }
  >();
  for (const c of categories) {
    for (const s of c.subcategories) {
      subBySlug.set(s.slug, {
        groupSlug: c.slug,
        subSlug: s.slug,
        name: s.name,
      });
    }
  }

  const toolsBySub = new Map<string, ToolRanking[]>();
  const rankingsByTool = new Map<string, ToolRanking[]>();
  for (const tr of toolRankings) {
    {
      const arr = toolsBySub.get(tr.subSlug) ?? [];
      arr.push(tr);
      toolsBySub.set(tr.subSlug, arr);
    }
    {
      const arr = rankingsByTool.get(tr.toolSlug) ?? [];
      arr.push(tr);
      rankingsByTool.set(tr.toolSlug, arr);
    }
  }
  for (const arr of toolsBySub.values()) arr.sort((a, b) => a.rankInSub - b.rankInSub);
  for (const arr of rankingsByTool.values()) arr.sort((a, b) => a.rankInSub - b.rankInSub);

  return {
    categories,
    tools,
    toolsDetail,
    rankings,
    toolRankings,
    prompts,
    promptsDetail,
    promptTopTools,
    models,
    matches,
    toolBySlug,
    toolDetailBySlug,
    rankingBySlug,
    promptByKey,
    promptDetailByKey,
    promptTopToolsByKey,
    matchByPair,
    matchesByTool,
    subBySlug,
    toolsBySub,
    rankingsByTool,
  };
}
