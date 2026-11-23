import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeckDemo } from '../kit/deck';
import { renderInRouter } from './router';
import { stubViewport } from './viewport';

/*
 * The /kit deck demo's held writes: Clear stop stays in flight until the
 * demo's Land or Refuse control settles it, per card, by the card's own key.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const deckCard = (key: string) => document.querySelector(`[data-deck-card="${key}"]`);
const clearStop = (id: string) => screen.getByRole('button', { name: `Clear stop on ${id}` });

describe('the kit deck demo', () => {
  it('lands a cloned card’s write against the clone, not the card it was cloned from', async () => {
    stubViewport('desktop');
    await renderInRouter(<DeckDemo initial={12} />);
    // The 11th card, FLT-d2#10, is on the third page.
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await userEvent.click(clearStop('FLT-d2'));
    await userEvent.click(screen.getByRole('button', { name: 'Land FLT-d2#10’s write' }));
    expect(deckCard('FLT-d2#10')).toBeNull();
    expect(deckCard('FLT-d2')).not.toBeNull();
  });
});
