import { useQuery } from '@tanstack/react-query';

import { seedQuery } from '../api/queries';
import type { WireSeed } from '../api/types';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/time';
import { SeedKindChip } from './seed-kind-chip';
import { SeedVerbs } from './seed-verbs';
import { Skeleton } from './ui/skeleton';

/** requester · age · id — the dense meta cluster on a seed row. */
function RowMeta({ seed }: { seed: WireSeed }) {
  return (
    <span className="shrink-0 text-tag text-ink-faint">
      {seed.requester ?? 'you'} · {relativeTime(seed.created_at)} ·{' '}
      <span className="font-mono">{seed.id}</span>
    </span>
  );
}

/**
 * The expanded body region (mock 13a) — its own scroll region with a fade-out
 * gradient. The list payload omits `description` by design (content isn't read
 * on the queue), so the body is fetched on expand from the detail read.
 */
function ExpandedBody({ id, seed, offline }: { id: string; seed: WireSeed; offline?: boolean }) {
  const detail = useQuery(seedQuery(id));
  const description = detail.data?.description ?? '';
  return (
    <>
      <div className="relative mx-4 mt-2.5">
        <div className="flex max-h-52 flex-col gap-2 overflow-y-auto pr-2 text-body leading-[1.7] text-ink">
          {detail.isPending && <Skeleton className="h-16 w-full" />}
          {!detail.isPending && description === '' && (
            <p className="text-meta text-ink-faint">No body — the title is the whole seed.</p>
          )}
          {!detail.isPending && description !== '' && (
            <p className="whitespace-pre-wrap">{description}</p>
          )}
        </div>
        {description !== '' && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-well-850 to-transparent" />
        )}
      </div>
      {seed.lane !== 'settled' && (
        <SeedVerbs
          seed={seed}
          offline={offline}
          className="mt-2.5 border-t border-line px-4 py-3"
        />
      )}
    </>
  );
}

/**
 * One seed in the queue (MMR-247). Renders two treatments from one selection
 * model (the URL `seed` param): a narrow stacked card that expands in place
 * (Meridian 13a) and a wide compact master row (14a) whose body/verbs live in
 * the reading pane. Settled rows render dimmed and carry no verbs.
 */
export function SeedRow({
  seed,
  active,
  onSelect,
  offline,
  dimmed = false,
}: {
  seed: WireSeed;
  active: boolean;
  onSelect: (id: string | undefined) => void;
  offline?: boolean;
  dimmed?: boolean;
}) {
  const toggle = () => onSelect(active ? undefined : seed.id);

  return (
    <>
      {/* ── narrow: stacked, expand-in-place (mock 13a) ─────────────────── */}
      <div
        className={cn(
          'overflow-hidden rounded-xl border bg-well-850 md:hidden',
          active ? 'border-accent/35' : 'border-line',
          dimmed && !active && 'opacity-60',
        )}
      >
        <button
          type="button"
          aria-expanded={active}
          onClick={toggle}
          className="flex w-full items-center gap-2.5 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <SeedKindChip kind={seed.kind} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-body font-medium',
              dimmed ? 'text-ink-dim' : 'text-ink-bright',
            )}
          >
            {seed.title}
          </span>
          <RowMeta seed={seed} />
        </button>
        {active && <ExpandedBody id={seed.id} seed={seed} offline={offline} />}
      </div>

      {/* ── wide: compact master row (mock 14a), body/verbs in the pane ──── */}
      <button
        type="button"
        aria-current={active}
        onClick={() => onSelect(seed.id)}
        className={cn(
          'hidden w-full flex-col gap-1.5 rounded-[10px] px-3 py-2.5 text-left transition-colors md:flex',
          active
            ? 'bg-accent/8 inset-ring inset-ring-accent/35'
            : 'hover:bg-well-850 focus-visible:outline-2 focus-visible:outline-accent',
          dimmed && !active && 'opacity-60',
        )}
      >
        <div className="flex items-center gap-2">
          <SeedKindChip kind={seed.kind} />
          <span className="ml-auto text-tag text-ink-faint">{relativeTime(seed.created_at)}</span>
        </div>
        <span
          className={cn(
            'text-meta leading-[1.4] font-medium',
            dimmed ? 'text-ink-dim' : 'text-ink-bright',
          )}
        >
          {seed.title}
        </span>
        {seed.spawned.length > 0 && (
          <span className="text-tag text-attention-foreground">
            spawned <span className="font-mono">{seed.spawned.join(', ')}</span>
            {seed.ready_to_resolve && ' · done'}
          </span>
        )}
      </button>
    </>
  );
}
