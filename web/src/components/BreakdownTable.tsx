import { Link } from "react-router-dom";
import { fmtInt, fmtPct, promptHref } from "../synth";
import type { OrientedRow } from "../synth";
import { SortableTable } from "./SortableTable";
import type { Column } from "./SortableTable";

export function BreakdownTable({
  title,
  rowLabel,
  aLabel,
  bLabel,
  rows,
}: {
  title: string;
  rowLabel: string;
  aLabel: string;
  bLabel: string;
  rows: OrientedRow[];
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
      label: aLabel,
      numeric: true,
      sortValue: (r) => r.aPicks,
      render: (r) => fmtInt(r.aPicks),
    },
    {
      key: "bPicks",
      label: bLabel,
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
        hideEmpty={{
          label: "Hide rows where neither tool was picked",
          isEmpty: (r) => r.aPicks === 0 && r.bPicks === 0,
        }}
      />
    </div>
  );
}
