export type Tool = {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
};

export type ToolDetail = {
  slug: string;
  name: string;
  description: string;
};

export type Subcategory = { slug: string; name: string };

export type Category = {
  slug: string;
  name: string;
  subcategories: Subcategory[];
};

export type Ranking = {
  groupSlug: string;
  subSlug: string | null;
  toolId: string;
  toolSlug: string;
  toolName: string;
  toolLogoUrl: string;
  weightedSupport: number;
  weightedEligible: number;
  weightedSupportRate: number;
  rawSupportCount: number;
  rawEligibleCount: number;
  rawSupportRate: number;
  modelCoverage: number;
  promptCoverage: number;
  ciLow: number;
  ciHigh: number;
  trend: number;
};

export type ModelMeta = { id: string | null; label: string; tier: string };

/** A tool's actual rank within one subcategory, scraped from /tools/{slug}'s
 *  Rankings table. This is the only authoritative per-category membership
 *  signal — preseason.ai's `?sub=` filter on /rankings is UI-only and
 *  returns the global numbers for every tool. */
export type ToolRanking = {
  toolSlug: string;
  groupSlug: string;
  subSlug: string;
  categoryName: string;
  rankInSub: number;
  totalInSub: number;
  supportRate: number | null;
  support: number | null;
  eligible: number | null;
};

export type Prompt = {
  id: string;
  slug: string;
  title: string;
  level: string;
  description: string;
  expectedCategories: string[];
  isActive?: boolean;
};

export type PromptDetail = {
  id: string;
  slug: string;
  title: string;
  level: string;
  promptText: string;
};

/** "Top Recommendations" card on /prompts/{level}/{slug}: the four highest-
 *  support tools for that exact prompt-level, with full-precision support
 *  rate scraped from the rendered HTML. */
export type PromptTopTool = {
  promptSlug: string;
  level: string;
  toolSlug: string;
  toolName: string;
  supportRate: number;
  rank: number;
};

/** One row of a match's per-model or per-prompt breakdown table. */
export type BreakdownRow = {
  /** "Model" key for perModel rows, "Prompt" key for perPrompt rows. */
  key: string;
  tier: string;
  /** Picks for tool A. The scraped JSON labels this column with the
   *  tool's display name; we normalize it here. */
  aPicks: number;
  bPicks: number;
  none: number;
  other: number;
};

export type Match = {
  groupSlug: string;
  subSlug: string;
  toolASlug: string;
  toolBSlug: string;
  toolALabel: string;
  toolBLabel: string;
  perModel: BreakdownRow[];
  perPrompt: BreakdownRow[];
  url: string;
};
