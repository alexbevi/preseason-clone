import { useMemo, useState, type ReactNode } from "react";

export type SortDir = "asc" | "desc";

export type Column<T> = {
  key: string;
  label: ReactNode;
  /** Right-aligned numeric column. */
  numeric?: boolean;
  /** Disable sorting for purely-decorative columns (e.g. bar cells). */
  sortable?: boolean;
  /** Value used for ordering. Numbers sort numerically; strings sort by
   *  localeCompare. Defaults to the rendered text content. */
  sortValue?: (row: T) => number | string | null | undefined;
  render: (row: T) => ReactNode;
  className?: string;
};

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  hideEmpty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Initial sort state. */
  defaultSort?: { key: string; dir: SortDir };
  /** When provided, renders a "Hide rows with no decisive results" checkbox
   *  that filters rows where this predicate is true. */
  hideEmpty?: { label?: string; isEmpty: (row: T) => boolean };
}) {
  const [sortKey, setSortKey] = useState<string | null>(
    defaultSort?.key ?? null,
  );
  const [sortDir, setSortDir] = useState<SortDir>(defaultSort?.dir ?? "desc");
  const [hidden, setHidden] = useState(false);

  const visibleRows = useMemo(() => {
    let r = rows;
    if (hidden && hideEmpty) r = r.filter((x) => !hideEmpty.isEmpty(x));
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col) {
        const get = col.sortValue ?? ((row: T) => String(col.render(row) ?? ""));
        r = r.slice().sort((a, b) => {
          const va = get(a);
          const vb = get(b);
          const na = va == null;
          const nb = vb == null;
          if (na && nb) return 0;
          if (na) return 1;
          if (nb) return -1;
          let cmp: number;
          if (typeof va === "number" && typeof vb === "number") {
            cmp = va - vb;
          } else {
            cmp = String(va).localeCompare(String(vb), undefined, {
              numeric: true,
            });
          }
          return sortDir === "asc" ? cmp : -cmp;
        });
      }
    }
    return r;
  }, [rows, sortKey, sortDir, hidden, hideEmpty, columns]);

  const onClickHeader = (col: Column<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(col.key);
      setSortDir(col.numeric ? "desc" : "asc");
    }
  };

  return (
    <>
      {hideEmpty && (
        <label className="hide-empty">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          {hideEmpty.label ?? "Hide rows with no decisive results"}
        </label>
      )}
      <table>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sortKey === c.key;
              const sortable = c.sortable !== false;
              return (
                <th
                  key={c.key}
                  className={
                    (c.numeric ? "num " : "") +
                    (sortable ? "sortable " : "") +
                    (active ? "sort-active" : "")
                  }
                  onClick={sortable ? () => onClickHeader(c) : undefined}
                >
                  <span className="th-inner">
                    {c.label}
                    {sortable && (
                      <span className="sort-indicator" aria-hidden>
                        {active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={(c.numeric ? "num " : "") + (c.className ?? "")}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
