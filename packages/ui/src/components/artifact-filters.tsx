import { useEffect, useRef, useState } from "react";
import type { ArtifactFilters as Filters } from "../api/queries";

/** Delay before a paused search push reaches the URL/query (one round-trip per pause, not per keystroke). */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The artifact-browser filter bar. `onChange` carries the single changed field;
 * the page merges it into the search params (an empty string clears that filter)
 * via a history-replacing navigation, so each keystroke updates the URL in place.
 *
 * The Search input is controlled by local state and **debounced**: keystrokes
 * update the box immediately but only push `q` to the URL/query once typing
 * pauses, so there's no round-trip per character. Because it's controlled, an
 * externally-changed `q` (Back/Forward, a future "clear filters") re-syncs the
 * box — the local value follows `filters.q` whenever they diverge from outside.
 */
export function ArtifactFilters({
  filters,
  projects,
  onChange,
}: {
  filters: Filters;
  projects: string[];
  onChange: (partial: Partial<Filters>) => void;
}) {
  // Local, immediate value for the search box; the URL trails it by the debounce.
  const [q, setQ] = useState(filters.q ?? "");

  // Re-sync when `q` changes from outside (Back/Forward, clear-filters). When our
  // own debounced push lands, filters.q already equals q, so this is a no-op.
  useEffect(() => {
    setQ(filters.q ?? "");
  }, [filters.q]);

  // Keep the latest onChange without re-arming the timer on every parent render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Push the paused value up once, after the debounce window.
  useEffect(() => {
    if (q === (filters.q ?? "")) return;
    const t = setTimeout(() => onChangeRef.current({ q }), SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [q, filters.q]);

  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
      <label className="flex flex-col gap-0.5 text-[11px] text-ink-dim">
        Project
        <select
          value={filters.project ?? ""}
          onChange={(e) => {
            onChange({ project: e.target.value });
          }}
          className="rounded border border-line bg-well-850 px-2 py-1 text-[12px] text-ink outline-none focus-visible:border-accent"
        >
          <option value="">All</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5 text-[11px] text-ink-dim">
        Tag
        <input
          value={filters.tag ?? ""}
          onChange={(e) => {
            onChange({ tag: e.target.value });
          }}
          placeholder="kind:spec"
          className="rounded border border-line bg-well-850 px-2 py-1 text-[12px] text-ink outline-none focus-visible:border-accent"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-[11px] text-ink-dim">
        Since
        <input
          type="date"
          value={filters.since ?? ""}
          onChange={(e) => {
            onChange({ since: e.target.value });
          }}
          className="rounded border border-line bg-well-850 px-2 py-1 text-[12px] text-ink outline-none focus-visible:border-accent"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-[11px] text-ink-dim">
        Before
        <input
          type="date"
          value={filters.before ?? ""}
          onChange={(e) => {
            onChange({ before: e.target.value });
          }}
          className="rounded border border-line bg-well-850 px-2 py-1 text-[12px] text-ink outline-none focus-visible:border-accent"
        />
      </label>
      <label className="flex flex-1 flex-col gap-0.5 text-[11px] text-ink-dim">
        Search
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
          }}
          placeholder="Search title and body…"
          className="min-w-40 rounded border border-line bg-well-850 px-2 py-1 text-[12px] text-ink outline-none focus-visible:border-accent"
        />
      </label>
    </div>
  );
}
