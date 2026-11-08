import { describe, expect, test } from 'bun:test';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { createUsageMeter, settledUsage, usageTotal } from './agent-usage';

/*
 * In-flight accounting (ADR 0041): the main agent's streamed usage, once per
 * message id, plus a per-turn output allowance and the spawn allowances; and
 * settlement from the result's modelUsage.
 */

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

const usage = (input: number, output = 1, read = 0, write = 0): Usage => ({
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  input_tokens: input,
  output_tokens: output,
});

/** A streamed assistant message; `from` marks a subagent's. */
function assistant(id: string, used: Usage, from?: { parent: string; agent: string }): SDKMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    message: { content: [], id, model: 'claude-opus-5-5', role: 'assistant', usage: used },
    parent_tool_use_id: from?.parent ?? null,
    session_id: 's',
    type: 'assistant',
    uuid: `${id}-${Math.random()}`,
    ...(from === undefined ? {} : { agent_id: from.agent }),
  } as unknown as SDKMessage;
}

const meter = (ceiling = 1_000_000) =>
  createUsageMeter({ ceiling, perTurnOutputAllowance: 100, spawnAllowance: 1_000 });

describe('the usage meter', () => {
  test('counts each main-loop message id once, plus one output allowance per id', () => {
    const tracked = meter();
    // One API turn arrives as several messages sharing its id, each with the turn's usage.
    tracked.observe(assistant('msg_1', usage(10, 1, 200, 30)));
    tracked.observe(assistant('msg_1', usage(10, 1, 200, 30)));
    tracked.observe(assistant('msg_2', usage(5, 2, 300)));
    expect(tracked.streamed()).toEqual({
      cacheReadTokens: 500,
      cacheWriteTokens: 30,
      inputTokens: 15,
      outputTokens: 3,
    });
    expect(tracked.total()).toBe(548 + 200);
    expect(tracked.usage()).toEqual({
      cacheReadTokens: 500,
      cacheWriteTokens: 30,
      inputTokens: 15,
      outputTokens: 203,
    });
  });

  test('keeps the larger count when a later message of one id reports more', () => {
    const tracked = meter();
    tracked.observe(assistant('msg_1', usage(10, 1)));
    tracked.observe(assistant('msg_1', usage(10, 40)));
    tracked.observe(assistant('msg_1', usage(10, 5)));
    expect(tracked.streamed().outputTokens).toBe(40);
  });

  test("ignores a subagent's streamed messages, which its spawn allowance covers", () => {
    const tracked = meter();
    tracked.observe(assistant('msg_sub', usage(9_000), { agent: 'a1', parent: 'toolu_1' }));
    tracked.observe(assistant('msg_sub2', usage(9_000), { agent: 'a1', parent: '' }));
    expect(tracked.total()).toBe(0);
  });

  test('ignores messages that are not assistant turns', () => {
    const tracked = meter();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    tracked.observe({ subtype: 'init', type: 'system' } as unknown as SDKMessage);
    expect(tracked.total()).toBe(0);
  });

  test('charges a spawn allowance only while it fits the ceiling', () => {
    const tracked = meter(2_500);
    expect(tracked.chargeSpawn()).toBe(true);
    expect(tracked.chargeSpawn()).toBe(true);
    expect(tracked.total()).toBe(2_000);
    expect(tracked.chargeSpawn()).toBe(false);
    expect(tracked.total()).toBe(2_000);
    expect(tracked.spawns()).toBe(2);
    expect(tracked.usage().outputTokens).toBe(2_000);
  });

  test('reaches its ceiling once the running total is at or past it', () => {
    const tracked = meter(1_000);
    tracked.observe(assistant('msg_1', usage(800)));
    expect(tracked.reachedCeiling()).toBe(false);
    tracked.observe(assistant('msg_2', usage(100)));
    expect(tracked.reachedCeiling()).toBe(true);
  });
});

const model = (input: number, output: number, read: number, write: number) => ({
  cacheCreationInputTokens: write,
  cacheReadInputTokens: read,
  contextWindow: 200_000,
  costUSD: 0.5,
  inputTokens: input,
  maxOutputTokens: 32_000,
  outputTokens: output,
  webSearchRequests: 0,
});

describe('settledUsage', () => {
  test('sums every model in modelUsage, including one the run never named', () => {
    const settled = settledUsage(
      {
        'claude-haiku-5-5': model(1_200, 300, 0, 0),
        'claude-opus-5-5': model(100, 2_000, 50_000, 4_000),
      },
      { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    );
    expect(settled).toEqual({
      cacheReadTokens: 50_000,
      cacheWriteTokens: 4_000,
      inputTokens: 1_300,
      outputTokens: 2_300,
    });
    expect(settled === undefined ? 0 : usageTotal(settled)).toBe(57_600);
  });

  test('is no valid total when a count is not a non-negative whole number', () => {
    const streamed = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };
    expect(settledUsage({ m: model(-1, 0, 0, 0) }, streamed)).toBeUndefined();
    expect(settledUsage({ m: model(1.5, 0, 0, 0) }, streamed)).toBeUndefined();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(settledUsage({ m: { inputTokens: 1 } } as never, streamed)).toBeUndefined();
    expect(settledUsage(undefined, streamed)).toBeUndefined();
  });

  test('is no valid total when it is below what the main loop already streamed', () => {
    // modelUsage covers the main loop, so a zeroed crash result cannot be the run's total.
    const streamed = {
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      inputTokens: 10,
      outputTokens: 1,
    };
    expect(settledUsage({}, streamed)).toBeUndefined();
    expect(settledUsage({ m: model(0, 0, 0, 0) }, streamed)).toBeUndefined();
    expect(settledUsage({ m: model(10, 1, 900, 0) }, streamed)).toEqual(streamed);
  });
});
