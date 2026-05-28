import { useEffect, useMemo, useRef, useState } from "react";
import type { Tool } from "../types";

export function ToolCombobox({
  tools,
  value,
  onChange,
  placeholder = "Type to search...",
}: {
  tools: Tool[];
  value: string;
  onChange: (slug: string) => void;
  placeholder?: string;
}) {
  const selected = tools.find((t) => t.slug === value);
  const [query, setQuery] = useState<string>(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync display when the externally-bound value changes (e.g. category swap).
  useEffect(() => {
    if (!open) setQuery(selected?.name ?? "");
  }, [selected, open]);

  // Close when clicking outside.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || (selected && q === selected.name.toLowerCase())) return tools;
    return tools.filter((t) => t.name.toLowerCase().includes(q));
  }, [tools, query, selected]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  const choose = (t: Tool) => {
    onChange(t.slug);
    setQuery(t.name);
    setOpen(false);
  };

  return (
    <div className="combobox" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          inputRef.current?.select();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const t = filtered[highlight];
            if (t) choose(t);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery(selected?.name ?? "");
          }
        }}
      />
      {open && filtered.length > 0 && (
        <ul className="combobox-list" role="listbox">
          {filtered.map((t, i) => (
            <li
              key={t.slug}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(t);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {t.name}
            </li>
          ))}
        </ul>
      )}
      {open && filtered.length === 0 && (
        <ul className="combobox-list">
          <li className="empty">No matches</li>
        </ul>
      )}
    </div>
  );
}
