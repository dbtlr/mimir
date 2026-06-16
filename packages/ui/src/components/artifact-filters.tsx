import type { ArtifactFilters as Filters } from "../api/queries";

/**
 * The artifact-browser filter bar. `onChange` carries the single changed field;
 * the page merges it into the search params (an empty string clears that filter)
 * via a history-replacing navigation, so each keystroke updates the URL in place.
 *
 * The Search input is uncontrolled (`defaultValue`): it hydrates `filters.q` once
 * at mount (so a deep-linked `?q=` populates it) and then owns its own DOM value
 * while typing. The known trade-off is that an externally-changed `q` (a future
 * "clear filters" button, or Back/Forward) won't re-sync the box — revisit with a
 * controlled+debounced input if that case starts to matter.
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
          defaultValue={filters.q ?? ""}
          onChange={(e) => {
            onChange({ q: e.target.value });
          }}
          placeholder="Search title and body…"
          className="min-w-40 rounded border border-line bg-well-850 px-2 py-1 text-[12px] text-ink outline-none focus-visible:border-accent"
        />
      </label>
    </div>
  );
}
