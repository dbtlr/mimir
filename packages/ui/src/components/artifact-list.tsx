import type { WireArtifactSummary } from '../api/types';
import { groupByRecency, splitKindTags } from '../lib/artifacts';
import { cn } from '../lib/cn';
import { shortDate } from '../lib/time';

/**
 * The master-list column (Meridian 16a): date-grouped rows — THIS WEEK /
 * LAST WEEK / month buckets — each row title over a mono-project meta line.
 * The selected row carries the accent wash; rows older than last week render
 * with the title demoted (opacity in dark, an ink tier down in light — ADR
 * 0019 §7 rule 3); the meta line keeps full ink-faint contrast in both themes.
 */
export function ArtifactList({
  items,
  selectedId,
  onSelect,
}: {
  items: WireArtifactSummary[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-ink-faint">No artifacts match.</p>;
  }
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      {groupByRecency(items).map((group) => (
        <section key={group.label} aria-label={group.label}>
          {/* Mono microlabel spelled from raw utilities — `.microlabel` inlines
              font-sans unlayered, which would beat the layered font-mono utility. */}
          <h2 className="px-2 pt-2.5 pb-1 font-mono text-micro font-semibold tracking-[0.13em] text-ink-faint uppercase">
            {group.label}
          </h2>
          <ol className="flex flex-col gap-0.5">
            {group.items.map((a) => {
              const selected = a.id === selectedId;
              const { kind } = splitKindTags(a.tags);
              const date = shortDate(a.created_at);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => {
                      onSelect(a.id);
                    }}
                    className={cn(
                      'flex w-full flex-col gap-1 rounded-[10px] px-[13px] py-[11px] text-left transition-colors',
                      'hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent',
                      selected && 'bg-accent/8 inset-ring inset-ring-accent/35',
                    )}
                  >
                    <span
                      className={cn(
                        'text-meta leading-snug text-ink-bright',
                        selected ? 'font-semibold' : 'font-medium',
                        // Demotion scopes to the title only — the ink-faint meta
                        // line is already at the AA floor and must not dim further.
                        // Dark dims by opacity; light demotes by ink tier, not
                        // opacity (ADR 0019 §7 rule 3).
                        !selected && !group.recent && 'dark:opacity-75 light:text-ink',
                      )}
                    >
                      {a.title}
                    </span>
                    <span className="text-tag text-ink-faint">
                      <span className="font-mono">{a.project}</span>
                      {kind !== undefined && <> · {kind}</>}
                      {' · '}
                      {selected ? `frozen ${date}` : date}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
