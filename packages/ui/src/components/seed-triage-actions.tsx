import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { promoteSeedKey } from '../api/mutations';
import { reviewQuery } from '../api/queries';
import type { WireReviewReport, WireSeed } from '../api/types';
import type { RowFocusHandoff } from '../lib/use-row-focus-handoff';
import { SeedPromoteSheet } from './seed-promote-sheet';
import { SeedVerbs } from './seed-verbs';

/** Whether a review read still lists a seed for triage. */
const listsSeed = (report: WireReviewReport | undefined, id: string): boolean =>
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
  seed: WireSeed;
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
        seed={seed}
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
          seed={seed}
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
