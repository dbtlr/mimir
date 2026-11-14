import { describe, expect } from 'vitest';

import { availableTransitions } from '../lib/transitions';

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

  it('queued can start, cancel the reservation, or settle, with a cancellation reason', () => {
    const specs = availableTransitions('queued');
    expect(specs.map((v) => v.verb)).toStrictEqual(['start', 'unqueue', 'done', 'abandon']);
    expect(specs.find((v) => v.verb === 'unqueue')?.needsReason).toBe(true);
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

  it('under_review offers stage + approve (done) + request-changes (return) + holds (MMR-84)', () => {
    const specs = availableTransitions('under_review');
    expect(specs.map((v) => v.verb)).toStrictEqual([
      'stage',
      'done',
      'return',
      'park',
      'block',
      'abandon',
    ]);
    expect(specs.find((s) => s.verb === 'return')?.needsReason).toBe(true);
    expect(specs.find((s) => s.verb === 'done')?.needsReason).toBe(false);
  });

  it('staged leaves by done, return, holds, or abandon, and cannot stage again', () => {
    const specs = availableTransitions('staged');
    expect(specs.map((v) => v.verb)).toStrictEqual(['done', 'return', 'park', 'block', 'abandon']);
    expect(specs.find((s) => s.verb === 'return')?.needsReason).toBe(true);
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
  it('availableTransitions names each action in plain words', () => {
    const labels = availableTransitions('parked').map((s) => s.label);
    expect(labels).toStrictEqual(['Resume', 'Abandon']);
    expect(availableTransitions('under_review').map((s) => s.label)).toStrictEqual([
      'Stage',
      'Mark done',
      'Send back',
      'Park for later',
      'Mark blocked',
      'Abandon',
    ]);
  });
});
