import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Dataset } from "../data";
import { SortableTable, type Column } from "../components/SortableTable";
import type { Prompt } from "../types";

const LEVEL_ORDER = ["beginner", "intermediate", "advanced"];

export function PromptsList({ data }: { data: Dataset }) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("");

  const levels = useMemo(() => {
    const s = new Set<string>();
    for (const p of data.prompts) s.add(p.level);
    return Array.from(s).sort(
      (a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b),
    );
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.prompts.filter((p) => {
      if (level && p.level !== level) return false;
      if (!q) return true;
      return (
        p.slug.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [data, query, level]);

  return (
    <>
      <div className="controls">
        <div className="control" style={{ gridColumn: "span 2" }}>
          <label>Search</label>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, slug, or description"
          />
        </div>
        <div className="control">
          <label>Level</label>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">All levels</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <p className="section-title">{filtered.length} prompts</p>
        <SortableTable
          columns={promptColumns}
          rows={filtered}
          rowKey={(p) => `${p.slug}-${p.level}`}
        />
      </div>
    </>
  );
}

const promptColumns: Column<Prompt>[] = [
  {
    key: "title",
    label: "Title",
    sortValue: (p) => p.title,
    render: (p) => (
      <>
        <Link to={`/prompt/${p.slug}/${p.level}`}>{p.title}</Link>
        <div className="muted" style={{ fontSize: 12 }}>
          {p.description}
        </div>
      </>
    ),
  },
  {
    key: "slug",
    label: "Slug",
    sortValue: (p) => p.slug,
    render: (p) => p.slug,
    className: "tier",
  },
  {
    key: "level",
    label: "Level",
    sortValue: (p) => LEVEL_ORDER.indexOf(p.level),
    render: (p) => p.level,
    className: "tier",
  },
  {
    key: "categories",
    label: "Expected categories",
    sortValue: (p) => p.expectedCategories?.join(", ") ?? "",
    render: (p) => (
      <span className="muted" style={{ fontSize: 12 }}>
        {p.expectedCategories?.join(", ") ?? ""}
      </span>
    ),
  },
];
