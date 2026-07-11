import { useState } from 'react';
import type { ReactNode } from 'react';

import { useRejectSeed, useResolveSeed } from '../api/mutations';
import type { WireSeed } from '../api/types';
import { cn } from '../lib/cn';
import { ReasonDialog } from './reason-dialog';

type PendingVerb = 'reject' | 'resolve' | null;

/** A quiet hairline verb chip (the node-dossier VerbChip idiom, seed-local). */
function VerbChip({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40',
        primary
          ? 'bg-accent/14 text-accent-foreground inset-ring inset-ring-accent/30 hover:bg-accent/20'
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
 *  - untriaged: Reject… · Later
 *  - ready (to resolve): Resolve — done (primary) · Reject…, with the spawned link
 *  - promoted (in flight): Reject… only, with the spawned reference
 * "Later" is purely local — it collapses/deselects the row, no lifecycle change,
 * no server call. Reject/Resolve open the required-reason dialog.
 *
 * Seam (MMR-248): the lead "Promote → task…" chip ships with the promote sheet.
 * The chip row is an array built left-to-right — the promote chip slots in ahead
 * of Reject on untriaged/promoted without reworking this component.
 */
export function SeedVerbs({
  seed,
  onLater,
  onPromote,
  offline,
  className,
}: {
  seed: WireSeed;
  onLater?: () => void;
  /** MMR-248: opens the promote sheet for this seed (the lead verb while live). */
  onPromote?: (seed: WireSeed) => void;
  offline?: boolean;
  className?: string;
}) {
  const [pending, setPending] = useState<PendingVerb>(null);
  const reject = useRejectSeed(seed.id);
  const resolve = useResolveSeed(seed.id);

  // A settled seed is frozen — no verbs (its rows render read-only).
  if (seed.lane === 'settled') {
    return null;
  }

  const chips: ReactNode[] = [];
  if (seed.lane === 'ready') {
    chips.push(
      <VerbChip key="resolve" primary disabled={offline} onClick={() => setPending('resolve')}>
        Resolve — done
      </VerbChip>,
    );
  }
  chips.push(
    <VerbChip key="reject" disabled={offline} onClick={() => setPending('reject')}>
      Reject…
    </VerbChip>,
  );
  if (seed.lane === 'untriaged' && onLater !== undefined) {
    chips.push(
      <VerbChip key="later" onClick={onLater}>
        Later
      </VerbChip>,
    );
  }
  // MMR-248 promote seam: the lead verb on every live lane (untriaged/promoted/
  // ready). Promote is repeatable while the seed is live — a further promote
  // appends another spawned link — so it isn't gated to the untriaged lane.
  if (onPromote !== undefined) {
    chips.unshift(
      <VerbChip key="promote" primary disabled={offline} onClick={() => onPromote(seed)}>
        Promote → task…
      </VerbChip>,
    );
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {chips}
      <SpawnedRef seed={seed} />
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
        title="Resolve — done"
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
