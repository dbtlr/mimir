import { useState } from 'react';
import type { ReactNode } from 'react';

import type { EngineSeed } from '../api/browse-queries';
import { useParkSeed, useRejectSeed, useResolveSeed, useUnparkSeed } from '../api/seed-mutations';
import { cn } from '../lib/cn';
import { laneOf } from '../lib/seed-lanes';
import type { SeedStanding } from '../lib/seed-lanes';
import { PHONE_TOUCH_TARGET } from '../lib/touch-target';
import { Reason } from './patterns/reason';

type PendingVerb = 'park' | 'reject' | 'resolve' | null;

/** What the verbs read of a seed: its id, its lane's inputs, and the work it spawned. */
type VerbSeed = Pick<EngineSeed, 'id' | 'spawned'> & SeedStanding;

/** A surface whose seed stays put when acted on (the seed page) hands nothing on. */

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
        PHONE_TOUCH_TARGET,
        primary
          ? PRIMARY_INK[attention === true ? 'attention' : 'accent']
          : 'font-medium text-ink-dim inset-ring inset-ring-line hover:bg-well-800 hover:text-ink-bright',
      )}
    >
      {children}
    </button>
  );
}

/**
 * The spawned-work reference line, e.g. "spawned MMR-118 · done" (ready) or bare
 * (promoted). Only a ready seed waits on the operator, so only it takes the
 * attention hue (ADR 0019, MMR-617 refinement).
 */
export function SpawnedRef({ seed }: { seed: VerbSeed }) {
  if (seed.spawned.length === 0) {
    return null;
  }
  return (
    <span
      className={cn('text-tag', seed.readyToResolve ? 'text-attention-foreground' : 'text-ink-dim')}
    >
      spawned <span className="font-mono">{seed.spawned.join(', ')}</span>
      {seed.readyToResolve && ' · done'}
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
 * The chips stay off while a verb is pending.
 *
 * Seam (MMR-248): one primary per lane. Promote leads (primary) on untriaged and
 * promoted; on the ready lane Resolve keeps the lead and Promote falls in behind
 * it as a secondary chip.
 */
export function SeedVerbs<S extends VerbSeed>({
  seed,
  onPromote,
  offline,
  withSpawned = true,
  className,
}: {
  seed: S;
  /** MMR-248: opens the promote sheet for this seed (the lead verb while live). */
  onPromote?: (seed: S) => void;
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
  const verbs = [reject, resolve, park, unpark];
  const busy = verbs.some((verb) => verb.isPending);
  const off = offline === true || busy;

  const lane = laneOf(seed);
  // A settled seed is frozen — no verbs (its rows render read-only).
  if (lane === 'settled') {
    return null;
  }

  const chips: ReactNode[] = [];
  if (lane === 'ready') {
    chips.push(
      <VerbChip
        key="resolve"
        primary
        attention
        disabled={off}
        onClick={() => setPending('resolve')}
      >
        Resolve…
      </VerbChip>,
    );
    // On the ready lane Resolve is the lead primary, so Promote falls in behind
    // it as a secondary chip — one primary per lane.
    if (onPromote !== undefined) {
      chips.push(
        <VerbChip key="promote" disabled={off} onClick={() => onPromote(seed)}>
          Promote again…
        </VerbChip>,
      );
    }
  }
  if (lane === 'parked') {
    chips.push(
      <VerbChip key="unpark" disabled={off} onClick={() => unpark.mutate()}>
        Unpark
      </VerbChip>,
    );
  }
  chips.push(
    <VerbChip key="reject" disabled={off} onClick={() => setPending('reject')}>
      Reject…
    </VerbChip>,
  );
  if (lane === 'untriaged') {
    chips.push(
      <VerbChip key="park" disabled={off} onClick={() => setPending('park')}>
        Park…
      </VerbChip>,
    );
  }
  // MMR-248 promote seam: the lead primary verb on untriaged/promoted (the ready
  // lane placed Promote as a secondary above). Promote is repeatable while the
  // seed is live — a further promote appends another spawned link.
  if (onPromote !== undefined && lane !== 'ready') {
    chips.unshift(
      <VerbChip key="promote" primary disabled={off} onClick={() => onPromote(seed)}>
        {lane === 'untriaged' || lane === 'parked' ? 'Promote to task…' : 'Promote again…'}
      </VerbChip>,
    );
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {chips}
      {withSpawned && <SpawnedRef seed={seed} />}
      <Reason
        title="Park seed"
        open={pending === 'park'}
        onClose={() => setPending(null)}
        commits={[{ label: 'Park', onCommit: (reason) => park.mutate(reason) }]}
      />
      <Reason
        title="Reject seed"
        required
        open={pending === 'reject'}
        onClose={() => setPending(null)}
        commits={[{ label: 'Reject', onCommit: (reason) => reject.mutate(reason) }]}
      />
      <Reason
        title="Resolve seed"
        required
        open={pending === 'resolve'}
        onClose={() => setPending(null)}
        commits={[{ label: 'Resolve', onCommit: (reason) => resolve.mutate(reason) }]}
      />
    </div>
  );
}
