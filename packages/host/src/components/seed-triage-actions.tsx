import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { promoteSeedKey } from '../api/seed-mutations';
import type { WireSeed } from '../api/types';
import { reviewQuery } from '../api/view-queries';
import type { ReviewReport, TriageSeed } from '../api/view-queries';
import type { RowFocusHandoff } from '../lib/use-row-focus-handoff';
import { SeedPromoteSheet } from './seed-promote-sheet';
import { SeedVerbs } from './seed-verbs';

/**
 * A listed seed in the shape the seed verbs read. The review lists only
 * untriaged seeds, so the lane is known; the seed verbs move to the Engine's
 * shape with the seed pages.
 */
const asUntriaged = (seed: TriageSeed): WireSeed => ({
  created_at: seed.createdAt.toISOString(),
  description: seed.description,
  id: seed.id,
  kind: seed.kind,
  lane: 'untriaged',
  lede: seed.lede,
  lifecycle: seed.lifecycle,
  project: seed.project,
  ready_to_resolve: seed.readyToResolve,
  requester: seed.requester,
  spawned: seed.spawned,
  title: seed.title,
  updated_at: seed.updatedAt.toISOString(),
});

/** Whether a review read still lists a seed for triage. */
const listsSeed = (report: ReviewReport | undefined, id: string): boolean =>
  report?.triage.some((group) => group.seeds.some((seed) => seed.id === id)) ?? false;

/**
 * A listed seed's triage verbs: Promote to task…, Reject…, and Park…. Promote
 * arms the focus handoff as its sheet opens. The sheet closes itself after a
 * promote, one render before the refreshed rows (a promote stays pending until
 * the refetches land, but the query renders them on its next notify), so the
 * close reads the cached review: a seed it no longer lists is leaving, and the
 * handoff stays armed for it. A sheet closed while its promote is still in
 * flight leaves that call to the promote's end: one that fails with the seed
 * still listed disarms. A sheet closed without a promote disarms.
 */
export function SeedTriageActions({
  seed,
  offline,
  handoff,
}: {
  seed: TriageSeed;
  offline: boolean;
  handoff: RowFocusHandoff;
}) {
  const queryClient = useQueryClient();
  const [promoting, setPromoting] = useState(false);
  const inFlight = useIsMutating({ mutationKey: promoteSeedKey(seed.id) }) > 0;
  const closedMidWrite = useRef(false);
  /** Disarm unless the cached review has dropped the seed, which is leaving. */
  const disarmIfListed = () => {
    if (listsSeed(queryClient.getQueryData(reviewQuery().queryKey), seed.id)) {
      handoff.disarm(seed.id);
    }
  };
  useEffect(() => {
    if (closedMidWrite.current && !inFlight) {
      closedMidWrite.current = false;
      disarmIfListed();
    }
  });
  return (
    <>
      <SeedVerbs
        seed={asUntriaged(seed)}
        offline={offline}
        handoff={handoff}
        withSpawned={false}
        compact
        onPromote={() => {
          handoff.arm(seed.id);
          setPromoting(true);
        }}
      />
      {promoting && (
        <SeedPromoteSheet
          seed={asUntriaged(seed)}
          open
          offline={offline}
          onOpenChange={(next) => {
            if (next) {
              return;
            }
            setPromoting(false);
            if (queryClient.isMutating({ mutationKey: promoteSeedKey(seed.id) }) > 0) {
              closedMidWrite.current = true;
            } else {
              disarmIfListed();
            }
          }}
        />
      )}
    </>
  );
}
