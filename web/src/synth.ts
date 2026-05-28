import type { BreakdownRow, Match } from "./types";

/**
 * Wilson score interval for a proportion p with n trials at 95% CI (z=1.96).
 * Returns [low, high]. n=0 returns [0, 0].
 */
export function wilson95(picks: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];
  const z = 1.96;
  const p = picks / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export const fmtPct = (x: number, digits = 1): string =>
  `${(x * 100).toFixed(digits)}%`;

export const fmtInt = (x: number): string => x.toLocaleString();

/** A breakdown row reoriented so column "a" matches the caller's A side. */
export type OrientedRow = {
  key: string;
  tier: string;
  aPicks: number;
  bPicks: number;
  none: number;
  other: number;
  /** A's win rate among decisive (A or B) cases. 0 when no decisive cases. */
  aRateConditional: number;
};

export function orient(rows: BreakdownRow[], swap: boolean): OrientedRow[] {
  return rows.map((r) => {
    const a = swap ? r.bPicks : r.aPicks;
    const b = swap ? r.aPicks : r.bPicks;
    const decisive = a + b;
    return {
      key: r.key,
      tier: r.tier,
      aPicks: a,
      bPicks: b,
      none: r.none,
      other: r.other,
      aRateConditional: decisive > 0 ? a / decisive : 0,
    };
  });
}

export type MatchupSummary = {
  aWins: number;
  bWins: number;
  decisiveCases: number;
  abstains: number; // None across all rows
  otherChosen: number; // Other across all rows
  aWinRateConditional: number;
  conditionalCI: [number, number];
};

/** Roll up a list of oriented per-model rows into a single summary. */
export function rollup(rows: OrientedRow[]): MatchupSummary {
  let aWins = 0;
  let bWins = 0;
  let abstains = 0;
  let other = 0;
  for (const r of rows) {
    aWins += r.aPicks;
    bWins += r.bPicks;
    abstains += r.none;
    other += r.other;
  }
  const decisive = aWins + bWins;
  const cond = decisive > 0 ? aWins / decisive : 0;
  const ci = wilson95(aWins, decisive);
  return {
    aWins,
    bWins,
    decisiveCases: decisive,
    abstains,
    otherChosen: other,
    aWinRateConditional: cond,
    conditionalCI: ci,
  };
}

/**
 * Resolve a match for a chosen (aSlug, bSlug) pair, normalized so column A
 * aligns with `aSlug`. Returns `null` when no scraped match exists.
 */
export function resolveMatch(
  match: Match,
  aSlug: string,
): {
  match: Match;
  perModel: OrientedRow[];
  perPrompt: OrientedRow[];
  summary: MatchupSummary;
} {
  const swap = match.toolASlug !== aSlug;
  const perModel = orient(match.perModel, swap);
  const perPrompt = orient(match.perPrompt, swap);
  // We deliberately recompute the summary from per-model rows rather than
  // trusting the scraped `summary` block, so the numbers stay consistent
  // across views and survive any column-swap orientation.
  const summary = rollup(perModel);
  return { match, perModel, perPrompt, summary };
}
