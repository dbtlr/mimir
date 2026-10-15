import { describe, expect, test } from 'bun:test';

import { HOLD_VALUES, LIFECYCLE_VALUES } from '@mimir/contract';

import { interpret, tally, taskStatus } from './status';
import type { Distribution } from './status';

describe('taskStatus projection', () => {
  test('abandoned and done lifecycles win over any hold', () => {
    for (const hold of HOLD_VALUES) {
      expect(taskStatus({ awaiting: false, hold, lifecycle: 'abandoned' })).toBe('abandoned');
      expect(taskStatus({ awaiting: true, hold, lifecycle: 'done' })).toBe('done');
    }
  });

  test('a started-but-held task reads as the hold word, not in_progress', () => {
    expect(taskStatus({ awaiting: false, hold: 'blocked', lifecycle: 'in_progress' })).toBe(
      'blocked',
    );
    expect(taskStatus({ awaiting: false, hold: 'parked', lifecycle: 'in_progress' })).toBe(
      'parked',
    );
  });

  test('a held todo also reads as the hold word', () => {
    expect(taskStatus({ awaiting: true, hold: 'blocked', lifecycle: 'todo' })).toBe('blocked');
    expect(taskStatus({ awaiting: false, hold: 'parked', lifecycle: 'todo' })).toBe('parked');
  });

  test('in_progress + none is live work', () => {
    expect(taskStatus({ awaiting: false, hold: 'none', lifecycle: 'in_progress' })).toBe(
      'in_progress',
    );
    // awaiting is ignored outside todo+none
    expect(taskStatus({ awaiting: true, hold: 'none', lifecycle: 'in_progress' })).toBe(
      'in_progress',
    );
  });

  test('todo + none splits on readiness', () => {
    expect(taskStatus({ awaiting: true, hold: 'none', lifecycle: 'todo' })).toBe('awaiting');
    expect(taskStatus({ awaiting: false, hold: 'none', lifecycle: 'todo' })).toBe('ready');
  });

  test('under_review + none reads as under_review (MMR-84)', () => {
    expect(taskStatus({ awaiting: false, hold: 'none', lifecycle: 'under_review' })).toBe(
      'under_review',
    );
  });

  test('an under_review task that is held reads as the hold word', () => {
    expect(taskStatus({ awaiting: false, hold: 'blocked', lifecycle: 'under_review' })).toBe(
      'blocked',
    );
    expect(taskStatus({ awaiting: false, hold: 'parked', lifecycle: 'under_review' })).toBe(
      'parked',
    );
  });

  test('every axis combination projects to exactly one valid word', () => {
    for (const lifecycle of LIFECYCLE_VALUES) {
      for (const hold of HOLD_VALUES) {
        for (const awaiting of [true, false]) {
          const word = taskStatus({ awaiting, hold, lifecycle });
          expect(word).not.toBe('new'); // tasks never project to the non-leaf word
        }
      }
    }
  });
});

describe('interpret cascade', () => {
  test('empty distribution is new (never vacuously done)', () => {
    expect(interpret({})).toBe('new');
    expect(interpret({ ready: 0 })).toBe('new');
  });

  test('live work beats everything', () => {
    expect(interpret({ blocked: 2, done: 9, in_progress: 1, ready: 5 })).toBe('in_progress');
  });

  test('ready beats awaiting/blocked/parked', () => {
    expect(interpret({ awaiting: 3, blocked: 2, parked: 1, ready: 1 })).toBe('ready');
  });

  test('under_review ranks just under in_progress, above ready (MMR-84)', () => {
    // in_progress still wins
    expect(interpret({ in_progress: 1, under_review: 3 })).toBe('in_progress');
    // but under_review beats ready/awaiting/blocked/parked
    expect(interpret({ awaiting: 2, blocked: 1, parked: 1, ready: 5, under_review: 1 })).toBe(
      'under_review',
    );
    // a phase finishing through review reads as under_review, not done
    expect(interpret({ done: 3, under_review: 1 })).toBe('under_review');
  });

  test('the middle order is awaiting > blocked > parked', () => {
    expect(interpret({ awaiting: 1, blocked: 1, parked: 1 })).toBe('awaiting');
    expect(interpret({ blocked: 1, parked: 1 })).toBe('blocked');
    expect(interpret({ done: 4, parked: 1 })).toBe('parked');
  });

  test('new outranks terminal-only remainders', () => {
    expect(interpret({ abandoned: 1, done: 2, new: 1 })).toBe('new');
  });

  test('all-terminal is done if any done, else abandoned', () => {
    expect(interpret({ done: 3 })).toBe('done');
    expect(interpret({ abandoned: 5, done: 1 })).toBe('done');
    expect(interpret({ abandoned: 2 })).toBe('abandoned');
  });
});

describe('tally', () => {
  test('counts words into a distribution', () => {
    const dist: Distribution = tally(['ready', 'ready', 'done', 'blocked']);
    expect(dist).toEqual({ blocked: 1, done: 1, ready: 2 });
  });

  test('interpret(tally(...)) composes', () => {
    expect(interpret(tally(['done', 'done', 'ready']))).toBe('ready');
  });
});
