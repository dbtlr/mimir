import { describe, expect } from 'vitest';

import { availableTransitions, transitionLabel } from '../lib/transitions';

const inProgressNeedsReason = (v: string): boolean | undefined =>
  availableTransitions('in_progress').find((s) => s.verb === v)?.needsReason;

describe('availableTransitions', () => {
  it('ready offers start + holds + abandon', () => {
    expect(availableTransitions('ready').map((v) => v.verb)).toStrictEqual([
      'start',
      'park',
      'block',
      'abandon',
    ]);
  });

  it('awaiting matches ready (start is legal on a dep-gated todo)', () => {
    expect(availableTransitions('awaiting').map((v) => v.verb)).toStrictEqual(
      availableTransitions('ready').map((v) => v.verb),
    );
  });

  it('in_progress offers submit + done instead of start', () => {
    expect(availableTransitions('in_progress').map((v) => v.verb)).toStrictEqual([
      'submit',
      'done',
      'park',
      'block',
      'abandon',
    ]);
  });

  it('under_review offers approve (done) + request-changes (return) + holds (MMR-84)', () => {
    const specs = availableTransitions('under_review');
    expect(specs.map((v) => v.verb)).toStrictEqual(['done', 'return', 'park', 'block', 'abandon']);
    expect(specs.find((s) => s.verb === 'return')?.needsReason).toBe(true);
    expect(specs.find((s) => s.verb === 'done')?.needsReason).toBe(false);
  });

  it('held columns offer only their release + abandon', () => {
    expect(availableTransitions('parked').map((v) => v.verb)).toStrictEqual(['unpark', 'abandon']);
    expect(availableTransitions('blocked').map((v) => v.verb)).toStrictEqual([
      'unblock',
      'abandon',
    ]);
  });

  it('terminal statuses offer reopen; new offers nothing (MMR-104)', () => {
    expect(availableTransitions('done').map((v) => v.verb)).toStrictEqual(['reopen']);
    expect(availableTransitions('abandoned').map((v) => v.verb)).toStrictEqual(['reopen']);
    expect(availableTransitions('done').find((s) => s.verb === 'reopen')?.needsReason).toBe(true);
    expect(availableTransitions('abandoned').find((s) => s.verb === 'reopen')?.needsReason).toBe(
      true,
    );
    expect(availableTransitions('new')).toStrictEqual([]);
  });

  it('only park/block/abandon need a reason', () => {
    expect(inProgressNeedsReason('park')).toBe(true);
    expect(inProgressNeedsReason('block')).toBe(true);
    expect(inProgressNeedsReason('abandon')).toBe(true);
    expect(inProgressNeedsReason('done')).toBe(false);
  });
});

describe('transition labels', () => {
  it('name what the action does in plain words', () => {
    expect(transitionLabel('done')).toBe('Mark done');
    expect(transitionLabel('park')).toBe('Park for later');
    expect(transitionLabel('unpark')).toBe('Resume');
    expect(transitionLabel('block')).toBe('Mark blocked');
    expect(transitionLabel('return')).toBe('Request changes');
  });

  it('availableTransitions carries the same labels', () => {
    const labels = availableTransitions('parked').map((s) => s.label);
    expect(labels).toStrictEqual(['Resume', 'Abandon']);
  });
});
