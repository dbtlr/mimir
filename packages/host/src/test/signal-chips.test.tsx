import { PRIORITY_VALUES, SEED_KIND_VALUES } from '@mimir/contract';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SeedKindChip } from '../components/seed-kind-chip';
import { PriorityBadge } from '../components/signal-badges';

/**
 * ADR 0019 §1 (MMR-626 refinement): status hues mark status alone. Priority
 * and seed kind are signals read from their labels, so their chips draw in
 * ink. Priority is ordinal and steps down the ink ramp; kind is a category
 * and draws every kind alike.
 */
describe('priority and seed-kind chips stay off the status hues (ADR 0019 §1, MMR-626)', () => {
  it.each(PRIORITY_VALUES)('%s chip uses no status token', (priority) => {
    render(<PriorityBadge priority={priority} />);
    expect(screen.getByText(priority).className).not.toMatch(/status-/);
  });

  // p3 stops at ink-dim: ink-faint measures 3.11:1 (dark) and 2.84:1 (light) on the chip ground.
  it('priority steps down the ink ramp, p0 brightest, never below AA contrast', () => {
    const ink = { p0: 'text-ink-bright', p1: 'text-ink', p2: 'text-ink-dim', p3: 'text-ink-dim' };
    for (const priority of PRIORITY_VALUES) {
      render(<PriorityBadge priority={priority} />);
      expect(screen.getByText(priority).className.split(/\s+/)).toContain(ink[priority]);
    }
    expect(screen.getByText('p0').className).toContain('inset-ring-line-bright');
  });

  it.each(SEED_KIND_VALUES)('%s kind chip uses no status token', (kind) => {
    render(<SeedKindChip kind={kind} />);
    expect(screen.getByText(kind).className).not.toMatch(/status-/);
  });

  it('draws every seed kind alike', () => {
    for (const kind of SEED_KIND_VALUES) {
      render(<SeedKindChip kind={kind} />);
    }
    const classes = new Set(SEED_KIND_VALUES.map((kind) => screen.getByText(kind).className));
    expect(classes.size).toBe(1);
  });
});
