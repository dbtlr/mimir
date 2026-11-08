import { describe, expect, test } from 'bun:test';

import { budgetDay, remainingTokens } from './agent-budget';

/*
 * The budget day (ADR 0041): it starts at midnight in
 * MIMIR_AGENT_BUDGET_TIMEZONE and resets at the next one.
 */

const at = (iso: string) => new Date(iso);

describe('budgetDay', () => {
  test('a UTC day runs from midnight to midnight', () => {
    expect(budgetDay(at('2026-11-08T15:30:00Z'), 'UTC')).toEqual({
      resetsAt: at('2026-11-09T00:00:00Z'),
      startedAt: at('2026-11-08T00:00:00Z'),
    });
  });

  test('a zone behind UTC takes its own date, which may be the previous UTC day', () => {
    // 03:00 UTC on the 8th is 22:00 on the 7th in New York (EST, UTC-5).
    expect(budgetDay(at('2026-11-08T03:00:00Z'), 'America/New_York')).toEqual({
      resetsAt: at('2026-11-08T05:00:00Z'),
      startedAt: at('2026-11-07T05:00:00Z'),
    });
  });

  test('a zone ahead of UTC resets before UTC midnight', () => {
    // 20:00 UTC on the 8th is 05:00 on the 9th in Tokyo (UTC+9).
    expect(budgetDay(at('2026-11-08T20:00:00Z'), 'Asia/Tokyo')).toEqual({
      resetsAt: at('2026-11-09T15:00:00Z'),
      startedAt: at('2026-11-08T15:00:00Z'),
    });
  });

  test('a day that crosses a daylight-saving change is 23 or 25 hours long', () => {
    // New York leaves daylight saving on 2026-11-01: that day starts at UTC-4 and ends at UTC-5.
    expect(budgetDay(at('2026-11-01T12:00:00Z'), 'America/New_York')).toEqual({
      resetsAt: at('2026-11-02T05:00:00Z'),
      startedAt: at('2026-11-01T04:00:00Z'),
    });
    // It enters daylight saving on 2026-03-08.
    expect(budgetDay(at('2026-03-08T12:00:00Z'), 'America/New_York')).toEqual({
      resetsAt: at('2026-03-09T04:00:00Z'),
      startedAt: at('2026-03-08T05:00:00Z'),
    });
  });

  test('a day whose midnight is skipped starts at its first local instant', () => {
    // Havana enters daylight saving at midnight on 2026-03-08: 00:00 becomes 01:00 (UTC-4).
    expect(budgetDay(at('2026-03-08T12:00:00Z'), 'America/Havana').startedAt).toEqual(
      at('2026-03-08T05:00:00Z'),
    );
  });

  test('the instant at midnight belongs to the day it starts', () => {
    expect(budgetDay(at('2026-11-08T00:00:00Z'), 'UTC').startedAt).toEqual(
      at('2026-11-08T00:00:00Z'),
    );
    expect(budgetDay(at('2026-11-07T23:59:59.999Z'), 'UTC').resetsAt).toEqual(
      at('2026-11-08T00:00:00Z'),
    );
  });

  test('the end of a month and a year roll over', () => {
    expect(budgetDay(at('2026-12-31T23:00:00Z'), 'UTC').resetsAt).toEqual(
      at('2027-01-01T00:00:00Z'),
    );
  });
});

describe('remainingTokens', () => {
  test('is the budget less the day so far, and never below zero', () => {
    expect(remainingTokens({ dailyTokens: 10, usedTokens: 3 })).toBe(7);
    expect(remainingTokens({ dailyTokens: 10, usedTokens: 12 })).toBe(0);
  });
});
