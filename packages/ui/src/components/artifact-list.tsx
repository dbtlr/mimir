import type { WireArtifactSummary } from '../api/types';
import { cn } from '../lib/cn';
import { ago } from '../lib/time';
import { Badge } from './ui/badge';

/** The artifact-search results column — title · project · tags · age; one row selects. */
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
    <ol className="flex flex-col gap-1 p-1.5">
      {items.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => {
              onSelect(a.id);
            }}
            className={cn(
              'flex w-full flex-col gap-1 rounded-sm border border-line p-2 text-left transition-colors',
              'hover:border-line-bright hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent',
              a.id === selectedId ? 'border-accent bg-well-800' : 'bg-well-850',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-micro text-ink-dim">{a.id}</span>
              <time className="font-mono text-micro text-ink-faint">{ago(a.created_at)}</time>
            </div>
            <p className="line-clamp-2 text-xs leading-snug text-ink">{a.title}</p>
            <div className="flex flex-wrap items-center gap-1">
              <Badge variant="outline">{a.project}</Badge>
              {a.tags.map((t) => (
                <Badge key={t} variant="outline" className="max-w-32 truncate">
                  {t}
                </Badge>
              ))}
            </div>
          </button>
        </li>
      ))}
    </ol>
  );
}
