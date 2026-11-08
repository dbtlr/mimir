import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunUsage } from '@mimir/core';

/*
 * A run's token accounting (ADR 0041, "The budget is a token count Mimir
 * keeps"): the in-flight estimate the runner aborts on, and the settled total
 * from the result message.
 */

/**
 * Added once per main-loop turn. Streamed output counts fall short of what a
 * turn writes (the spike streamed 86 output tokens against a settled 290), so
 * the meter assumes each turn writes up to this many. 8k covers a turn that
 * writes the longest note the run grant takes (20k characters, about 5k
 * tokens) with room for thinking. A turn that writes more, such as an attach
 * of up to 100k characters (about 25k tokens), is not covered in flight; it
 * is caught at settlement, which counts it as an overrun against the day and
 * names it in the run's outcome. At the default 50 turns the allowance is
 * 400k, a tenth of the default run ceiling.
 */
export const PER_TURN_OUTPUT_ALLOWANCE = 8_000;

/**
 * Charged when the gate admits a reader subagent. Streamed subagent usage is
 * only a lower bound, so the meter counts this instead: the spike measured a
 * survey subagent at 0.33 to 0.35M tokens processed on Opus 5.5.
 */
export const SPAWN_ALLOWANCE = 400_000;

/** The tokens processed in a usage: input, cache reads, cache writes, and output. */
export function usageTotal(usage: RunUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

/** A usage of zero tokens. */
export const NO_USAGE: RunUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/** A count the meter can add: a non-negative whole number, or zero. */
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The four counts of one API message's usage, as the Messages API names them. */
function messageUsage(usage: unknown): RunUsage {
  if (typeof usage !== 'object' || usage === null) {
    return NO_USAGE;
  }
  const field = (name: string): number => count(Reflect.get(usage, name));
  return {
    cacheReadTokens: field('cache_read_input_tokens'),
    cacheWriteTokens: field('cache_creation_input_tokens'),
    inputTokens: field('input_tokens'),
    outputTokens: field('output_tokens'),
  };
}

/** Each count the larger of the two. */
const larger = (a: RunUsage, b: RunUsage): RunUsage => ({
  cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
  cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
  inputTokens: Math.max(a.inputTokens, b.inputTokens),
  outputTokens: Math.max(a.outputTokens, b.outputTokens),
});

const sum = (a: RunUsage, b: RunUsage): RunUsage => ({
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

export type UsageMeterOptions = {
  /** The run's ceiling, `MIMIR_AGENT_RUN_TOKENS`. */
  ceiling: number;
  perTurnOutputAllowance: number;
  spawnAllowance: number;
};

/** A run's in-flight usage estimate. */
export type UsageMeter = {
  /**
   * Count a streamed message: only the main loop's assistant turns, once per
   * message id. A message with no id counts as a turn of its own.
   */
  observe: (message: SDKMessage) => void;
  /** Charge one subagent's allowance; false, and nothing charged, when it does not fit the ceiling. */
  chargeSpawn: () => boolean;
  /** The main loop's streamed usage, without allowances: what the run's row records. */
  streamed: () => RunUsage;
  /** The estimate's tokens: streamed usage plus every allowance. */
  total: () => number;
  /** Whether the estimate has reached the ceiling. */
  reachedCeiling: () => boolean;
  /** The spawns charged. */
  spawns: () => number;
};

/** A fresh meter for one run. */
export function createUsageMeter(options: UsageMeterOptions): UsageMeter {
  // Keyed by message id; a message with no id gets a key of its own.
  const turns = new Map<string | symbol, RunUsage>();
  let spawns = 0;
  const streamed = () => [...turns.values()].reduce(sum, NO_USAGE);
  const allowances = () =>
    turns.size * options.perTurnOutputAllowance + spawns * options.spawnAllowance;
  const total = () => usageTotal(streamed()) + allowances();
  return {
    chargeSpawn() {
      if (total() + options.spawnAllowance > options.ceiling) {
        return false;
      }
      spawns += 1;
      return true;
    },
    observe(message) {
      // A subagent's messages carry the spawning tool call's id or its agent id.
      if (
        message.type !== 'assistant' ||
        message.parent_tool_use_id !== null ||
        message.agent_id !== undefined
      ) {
        return;
      }
      // Messages of one API turn share its id and repeat its usage. Merging
      // messages with no id could hide turns, so each counts on its own.
      const { id } = message.message as { id?: unknown };
      const key = typeof id === 'string' && id !== '' ? id : Symbol('no message id');
      const seen = turns.get(key);
      const used = messageUsage(message.message.usage);
      turns.set(key, seen === undefined ? used : larger(seen, used));
    },
    reachedCeiling: () => total() >= options.ceiling,
    spawns: () => spawns,
    streamed,
    total,
  };
}

const MODEL_USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
] as const;

/**
 * The run's settled usage: `modelUsage` summed over every model, the
 * subagents' and the CLI's own background calls included. Undefined when it
 * is no valid total: a count that is not a non-negative whole number, or a
 * total below the main loop's streamed usage, which `modelUsage` covers (a
 * crashed run's result may carry zeroed counts).
 */
export function settledUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
  streamed: RunUsage,
): RunUsage | undefined {
  if (typeof modelUsage !== 'object' || modelUsage === null) {
    return undefined;
  }
  let settled = NO_USAGE;
  for (const entry of Object.values(modelUsage)) {
    const valid = MODEL_USAGE_KEYS.every((key) => {
      const value: unknown = entry?.[key];
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    });
    if (!valid) {
      return undefined;
    }
    settled = sum(settled, {
      cacheReadTokens: entry.cacheReadInputTokens,
      cacheWriteTokens: entry.cacheCreationInputTokens,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    });
  }
  return usageTotal(settled) < usageTotal(streamed) ? undefined : settled;
}
