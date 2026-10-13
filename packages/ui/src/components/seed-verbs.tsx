import { useState } from 'react';
import type { ReactNode } from 'react';

import { useParkSeed, useRejectSeed, useResolveSeed, useUnparkSeed } from '../api/mutations';
import type { WireSeed } from '../api/types';
import { cn } from '../lib/cn';
import { ReasonDialog } from './reason-dialog';

type PendingVerb = 'park' | 'reject' | 'resolve' | null;

/** A lead verb's wash: the accent, or the ready lane's violet. */
const PRIMARY_INK = {
  accent: 'bg-accent/14 text-accent-foreground inset-ring inset-ring-accent/30 hover:bg-accent/20',
  attention:
    'bg-attention/14 text-attention inset-ring inset-ring-attention/30 hover:bg-attention/20',
};

/** A quiet hairline verb chip. */
function VerbChip({
  children,
  onClick,
  disabled,
  primary,
  attention,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  /** The ready lane's violet, for its lead verb. */
  attention?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40',
        primary
          ? PRIMARY_INK[attention === true ? 'attention' : 'accent']
          : 'font-medium text-ink-dim inset-ring inset-ring-line hover:bg-well-800 hover:text-ink-bright',
      )}
    >
      {children}
    </button>
  );
}

/** The spawned-work reference line, e.g. "spawned MMR-118 · done" (ready) or bare (promoted). */
export function SpawnedRef({ seed }: { seed: WireSeed }) {
  if (seed.spawned.length === 0) {
    return null;
  }
  return (
    <span className="text-tag text-attention-foreground">
      spawned <span className="font-mono">{seed.spawned.join(', ')}</span>
      {seed.ready_to_resolve && ' · done'}
    </span>
  );
}

/**
 * The pinned triage verb row (MMR-247, ADR 0019 §5) — labeled chips scoped to
 * the seed's lane:
 *  - untriaged: Promote to task… (primary) · Reject… · Park…
 *  - parked: Promote to task… (primary) · Unpark · Reject…
 *  - ready (to resolve): Resolve… (primary) · Promote again… · Reject…, with the spawned link
 *  - promoted (in flight): Promote again… (primary) · Reject…, with the spawned reference
 * Park sets the seed aside so it stops counting as untriaged (MMR-473); it opens
 * the optional-reason dialog, and Unpark acts at once. Reject/Resolve open the
 * required-reason dialog. A surface that lists the spawned work itself (the seed
 * page) drops the reference.
 *
 * Seam (MMR-248): one primary per lane. Promote leads (primary) on untriaged and
 * promoted; on the ready lane Resolve keeps the lead and Promote falls in behind
 * it as a secondary chip.
 */
export function SeedVerbs({
  seed,
  onPromote,
  offline,
  withSpawned = true,
  className,
}: {
  seed: WireSeed;
  /** MMR-248: opens the promote sheet for this seed (the lead verb while live). */
  onPromote?: (seed: WireSeed) => void;
  offline?: boolean;
  /** Show the spawned-work reference after the chips. */
  withSpawned?: boolean;
  className?: string;
}) {
  const [pending, setPending] = useState<PendingVerb>(null);
  const reject = useRejectSeed(seed.id);
  const resolve = useResolveSeed(seed.id);
  const park = useParkSeed(seed.id);
  const unpark = useUnparkSeed(seed.id);

  // A settled seed is frozen — no verbs (its rows render read-only).
  if (seed.lane === 'settled') {
    return null;
  }

  const chips: ReactNode[] = [];
  if (seed.lane === 'ready') {
    chips.push(
      <VerbChip
        key="resolve"
        primary
        attention
        disabled={offline}
        onClick={() => setPending('resolve')}
      >
        Resolve…
      </VerbChip>,
    );
    // On the ready lane Resolve is the lead primary, so Promote falls in behind
    // it as a secondary chip — one primary per lane.
    if (onPromote !== undefined) {
      chips.push(
        <VerbChip key="promote" disabled={offline} onClick={() => onPromote(seed)}>
          Promote again…
        </VerbChip>,
      );
    }
  }
  if (seed.lane === 'parked') {
    chips.push(
      <VerbChip key="unpark" disabled={offline} onClick={() => unpark.mutate()}>
        Unpark
      </VerbChip>,
    );
  }
  chips.push(
    <VerbChip key="reject" disabled={offline} onClick={() => setPending('reject')}>
      Reject…
    </VerbChip>,
  );
  if (seed.lane === 'untriaged') {
    chips.push(
      <VerbChip key="park" disabled={offline} onClick={() => setPending('park')}>
        Park…
      </VerbChip>,
    );
  }
  // MMR-248 promote seam: the lead primary verb on untriaged/promoted (the ready
  // lane placed Promote as a secondary above). Promote is repeatable while the
  // seed is live — a further promote appends another spawned link.
  if (onPromote !== undefined && seed.lane !== 'ready') {
    chips.unshift(
      <VerbChip key="promote" primary disabled={offline} onClick={() => onPromote(seed)}>
        {seed.lane === 'untriaged' || seed.lane === 'parked'
          ? 'Promote to task…'
          : 'Promote again…'}
      </VerbChip>,
    );
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {chips}
      {withSpawned && <SpawnedRef seed={seed} />}
      <ReasonDialog
        title="Park seed"
        confirmLabel="Park"
        open={pending === 'park'}
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          park.mutate(reason);
          setPending(null);
        }}
      />
      <ReasonDialog
        title="Reject seed"
        confirmLabel="Reject"
        required
        open={pending === 'reject'}
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          reject.mutate(reason);
          setPending(null);
        }}
      />
      <ReasonDialog
        title="Resolve seed"
        confirmLabel="Resolve"
        required
        open={pending === 'resolve'}
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          resolve.mutate(reason);
          setPending(null);
        }}
      />
    </div>
  );
}
