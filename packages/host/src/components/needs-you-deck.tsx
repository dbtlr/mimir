import { useMemo } from 'react';
import type { ComponentProps } from 'react';

import { useDeliveryUnblock } from '../api/delivery-mutations';
import { GroomingAnswerDialog } from './grooming-answer-dialog';
import { NeedsYouDeckView } from './needs-you-deck-view';
import type { NeedsYouWrites } from './needs-you-deck-view';

/**
 * The Needs you deck with the console's writes (ADR 0019, MMR-721
 * refinement): Clear stop is the delivery page's waking write, so it wakes
 * the delivery's thread as the page does, and Answer… opens the answer dialog
 * the work pages use.
 */
export function NeedsYouDeck(props: Omit<ComponentProps<typeof NeedsYouDeckView>, 'writes'>) {
  const { mutateAsync: unblock } = useDeliveryUnblock();
  const writes = useMemo<NeedsYouWrites>(
    () => ({
      AnswerDialog: GroomingAnswerDialog,
      clearStop: (id) => unblock({ id }),
    }),
    [unblock],
  );
  return <NeedsYouDeckView {...props} writes={writes} />;
}
