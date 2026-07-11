import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { seedQuery } from '../api/queries';
import type { WireSeed } from '../api/types';
import { AuthoringSheet } from './authoring-sheet';
import { SeedKindChip } from './seed-kind-chip';

/**
 * The promote sheet (Meridian 24a, MMR-248) — the authoring sheet arriving full
 * from a seed. A thin adapter: it reads the seed's body (list rows omit
 * `description`) and hands the {@link AuthoringSheet} its promote seam — the
 * prefill (title/description), the PROMOTE SEED header, and the promote context
 * that locks the type, suggests the home, and swaps the submit to the promote
 * endpoint. "Promote & open" routes to the spawned task's URL-addressable
 * dossier (`/?node=<id>`), the same `?node=` drawer the boards use.
 *
 * The sheet mounts on the click regardless of the body read — the list-row title
 * shows at once and the description folds in (pending until then) when the detail
 * lands — so a cold or slow read never dead-clicks the promote verb. A failed
 * read toasts and resets the parent's promoting state instead of hanging silent.
 */
export function SeedPromoteSheet({
  seed,
  open,
  onOpenChange,
  offline,
}: {
  seed: WireSeed;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offline?: boolean;
}) {
  const navigate = useNavigate();
  // Same key the row/reading-pane already fetched on select, so the body is
  // typically warm — but the sheet opens on the list row regardless of it.
  const detail = useQuery({ ...seedQuery(seed.id), enabled: open });
  const body = detail.data;
  // The body prose may already ride the row (the reading pane hands its detail
  // seed straight through); only a genuinely missing description is "pending".
  const descriptionPending = detail.isPending && seed.description == null;

  // A failed body read can't silently swallow the click: toast and reset the
  // parent's promoting state so the verb is live again.
  useEffect(() => {
    if (open && detail.isError) {
      toast.error(`Couldn't load ${seed.id} to promote — try again.`);
      onOpenChange(false);
    }
  }, [open, detail.isError, seed.id, onOpenChange]);

  return (
    <AuthoringSheet
      open={open}
      onOpenChange={onOpenChange}
      projectKey={seed.project}
      offline={offline}
      onOpenNode={(id) => void navigate({ search: { node: id }, to: '/' })}
      prefill={{
        description: body?.description ?? seed.description ?? undefined,
        title: body?.title ?? seed.title,
      }}
      descriptionPending={descriptionPending}
      promote={{ kind: seed.kind, seedId: seed.id }}
      headerSlot={
        <>
          <span className="microlabel text-accent-foreground">Promote seed</span>
          <span className="inline-flex items-center gap-2">
            <SeedKindChip kind={seed.kind} />
            <span className="font-mono text-mono-id text-ink-faint">{seed.id}</span>
          </span>
        </>
      }
    />
  );
}
