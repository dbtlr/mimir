import { useMemo } from 'react';
import type { ComponentProps } from 'react';

import { useDeliveryUnblock } from '../api/delivery-mutations';
import { GroomingAnswerDialog } from './grooming-answer-dialog';
import type { NeedsYouWrites } from './needs-you-cards';
import { NeedsYouDeckView } from './needs-you-deck-view';

/**
 * The needs-you cards' writes in the console (ADR 0019, MMR-721 refinement):
 * Clear stop is the delivery page's waking write, so it wakes the delivery's
 * thread as the page does, and Answer… opens the answer dialog the work pages
 * use. The deck and the Needs you page both act through them.
 */
export function useConsoleNeedsYouWrites(): NeedsYouWrites {
  const { mutateAsync: unblock } = useDeliveryUnblock();
  return useMemo<NeedsYouWrites>(
    () => ({
      AnswerDialog: GroomingAnswerDialog,
      clearStop: (id) => unblock({ id }),
    }),
    [unblock],
  );
}

/** The Needs you deck with the console's writes. */
export function NeedsYouDeck(props: Omit<ComponentProps<typeof NeedsYouDeckView>, 'writes'>) {
  return <NeedsYouDeckView {...props} writes={useConsoleNeedsYouWrites()} />;
}
