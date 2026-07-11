import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

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
  // typically warm; gating `open` on it keeps the prefill from mounting empty.
  const detail = useQuery({ ...seedQuery(seed.id), enabled: open });
  const body = detail.data;

  return (
    <AuthoringSheet
      open={open && body !== undefined}
      onOpenChange={onOpenChange}
      projectKey={seed.project}
      offline={offline}
      onOpenNode={(id) => void navigate({ search: { node: id }, to: '/' })}
      prefill={{
        description: body?.description ?? undefined,
        title: body?.title ?? seed.title,
      }}
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
