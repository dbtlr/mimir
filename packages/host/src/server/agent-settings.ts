import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ServeConfig } from '@mimir/core';

import type { AgentMisconfiguration, AgentState } from './agent-states';

/** The agent runtime's one enabling setting: a file holding a `claude setup-token` token. */
export const AGENT_TOKEN_SETTING = 'MIMIR_AGENT_TOKEN_FILE';

/** The run limits and model a run uses when its setting is unset or unusable (MMR-632). */
export const AGENT_DEFAULTS = {
  dailyTokens: 10_000_000,
  maxTurns: 50,
  model: 'claude-opus-5-5',
  runTokens: 4_000_000,
  timezone: 'UTC',
} as const;

/** A tuning setting: a bad value warns and falls back to its default. */
export type AgentTuningSetting =
  | 'MIMIR_AGENT_BUDGET_TIMEZONE'
  | 'MIMIR_AGENT_DAILY_TOKENS'
  | 'MIMIR_AGENT_MAX_TURNS'
  | 'MIMIR_AGENT_MODEL'
  | 'MIMIR_AGENT_RUN_TOKENS';

/** A tuning value the host replaced, and the value it uses instead. */
export type AgentFallback =
  | { setting: AgentTuningSetting; problem: 'invalid'; fallback: string }
  | { setting: 'MIMIR_AGENT_RUN_TOKENS'; problem: 'above the daily budget'; fallback: string };

/** The token budget: a day's tokens processed, one run's ceiling, and the zone a day resets in. */
export type AgentBudget = {
  dailyTokens: number;
  runTokens: number;
  maxTurns: number;
  timezone: string;
};

/**
 * The agent runtime's settings (ADR 0041). Disabled without
 * `MIMIR_AGENT_TOKEN_FILE`. Enabled, it carries every problem found at boot;
 * none of them refuses startup, and the runtime reads `misconfigured` until
 * each is fixed.
 */
export type AgentSettings =
  | { enabled: false }
  | {
      enabled: true;
      /** The token file, resolved against the host's directory. */
      tokenFile: string;
      /** The Claude Code executable; absent uses the SDK's own platform package. */
      claudePath: string | undefined;
      dataDirectory: string;
      /** Whether Host filtering (`MIMIR_HOSTS`) is set; agents require it. */
      hostFiltering: boolean;
      budget: AgentBudget;
      model: string;
      fallbacks: AgentFallback[];
      problems: AgentMisconfiguration[];
    };

/** The enabled settings. */
export type EnabledAgentSettings = Extract<AgentSettings, { enabled: true }>;

/** Whether a path is usable as a file name at all. */
function usablePath(path: string): boolean {
  return path.trim() !== '' && !path.includes('\0');
}

/** A positive whole number of the decimal digits only, or undefined. */
function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Whether `zone` names a time zone this runtime knows. */
function validTimeZone(zone: string): boolean {
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return format.resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}

/** A model id: letters, digits, dots, dashes, underscores, and a bracketed variant. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9]+\])?$/;

/** Read the budget and model, recording each fallback. */
function readTuning(env: NodeJS.ProcessEnv) {
  const fallbacks: AgentFallback[] = [];
  const integer = (setting: AgentTuningSetting, fallback: number) => {
    const raw = env[setting];
    const value = positiveInteger(raw);
    if (raw !== undefined && value === undefined) {
      fallbacks.push({ fallback: String(fallback), problem: 'invalid', setting });
    }
    return value ?? fallback;
  };
  const dailyTokens = integer('MIMIR_AGENT_DAILY_TOKENS', AGENT_DEFAULTS.dailyTokens);
  let runTokens = integer('MIMIR_AGENT_RUN_TOKENS', AGENT_DEFAULTS.runTokens);
  if (runTokens > dailyTokens) {
    // A run larger than the day could never be admitted.
    runTokens = dailyTokens;
    fallbacks.push({
      fallback: String(dailyTokens),
      problem: 'above the daily budget',
      setting: 'MIMIR_AGENT_RUN_TOKENS',
    });
  }
  const maxTurns = integer('MIMIR_AGENT_MAX_TURNS', AGENT_DEFAULTS.maxTurns);
  let timezone: string = AGENT_DEFAULTS.timezone;
  const zone = env.MIMIR_AGENT_BUDGET_TIMEZONE;
  if (zone !== undefined) {
    if (validTimeZone(zone)) {
      timezone = zone;
    } else {
      fallbacks.push({
        fallback: AGENT_DEFAULTS.timezone,
        problem: 'invalid',
        setting: 'MIMIR_AGENT_BUDGET_TIMEZONE',
      });
    }
  }
  let model: string = AGENT_DEFAULTS.model;
  if (env.MIMIR_AGENT_MODEL !== undefined) {
    if (MODEL_PATTERN.test(env.MIMIR_AGENT_MODEL)) {
      model = env.MIMIR_AGENT_MODEL;
    } else {
      fallbacks.push({
        fallback: AGENT_DEFAULTS.model,
        problem: 'invalid',
        setting: 'MIMIR_AGENT_MODEL',
      });
    }
  }
  return { budget: { dailyTokens, maxTurns, runTokens, timezone }, fallbacks, model };
}

/** The error code of a failed filesystem call. */
function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/**
 * Whether the host can write `directory`: an existing directory it may write,
 * or, when it does not exist yet, one its nearest existing ancestor lets it create.
 */
async function writableDirectory(directory: string): Promise<boolean> {
  let candidate = resolve(directory);
  for (;;) {
    try {
      if (!(await stat(candidate)).isDirectory()) {
        return false;
      }
      await access(candidate, constants.W_OK);
      return true;
    } catch (error) {
      const parent = dirname(candidate);
      if (errorCode(error) !== 'ENOENT' || parent === candidate) {
        return false;
      }
      candidate = parent;
    }
  }
}

/** Whether `file` is a regular file this process may run. */
async function executableFile(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The token file's contents and identity, or why it cannot be used. */
type TokenRead =
  | { token: string; modifiedAt: Date; identity: string }
  | { problem: AgentMisconfiguration };

/**
 * Read the token file now. The file is mounted and rotated by replacing it,
 * so every use reads it again. Its identity (device, inode, size, and
 * modification time) tells a replaced file from the one the API refused.
 */
export async function readAgentToken(tokenFile: string): Promise<TokenRead> {
  const unreadable = { problem: { problem: 'unreadable', setting: AGENT_TOKEN_SETTING } } as const;
  if (!usablePath(tokenFile)) {
    return unreadable;
  }
  try {
    const info = await stat(tokenFile);
    if (!info.isFile()) {
      return unreadable;
    }
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token === '') {
      return { problem: { problem: 'empty', setting: AGENT_TOKEN_SETTING } };
    }
    return {
      identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
      modifiedAt: info.mtime,
      token,
    };
  } catch {
    return unreadable;
  }
}

/** Check every prerequisite that can change after boot, in a stable order. */
async function prerequisiteProblems(settings: {
  tokenFile: string;
  claudePath: string | undefined;
  dataDirectory: string;
  hostFiltering: boolean;
}): Promise<AgentMisconfiguration[]> {
  const problems: AgentMisconfiguration[] = [];
  const token = await readAgentToken(settings.tokenFile);
  if ('problem' in token) {
    problems.push(token.problem);
  }
  if (!settings.hostFiltering) {
    problems.push({ problem: 'unset', setting: 'MIMIR_HOSTS' });
  }
  if (!(await writableDirectory(settings.dataDirectory))) {
    problems.push({ problem: 'not writable', setting: 'MIMIR_DATA_DIR' });
  }
  if (settings.claudePath !== undefined && !(await executableFile(settings.claudePath))) {
    problems.push({ problem: 'not executable', setting: 'MIMIR_AGENT_CLAUDE_PATH' });
  }
  return problems;
}

/**
 * Read the agent settings. `serve` is the already-validated Host filtering,
 * and `dataDirectory` the host's working directory. Nothing here refuses
 * startup.
 */
export async function readAgentSettings(
  env: NodeJS.ProcessEnv,
  serve: ServeConfig,
  dataDirectory: string,
): Promise<AgentSettings> {
  const setting = env[AGENT_TOKEN_SETTING];
  if (setting === undefined) {
    return { enabled: false };
  }
  // Resolved once against the host's directory, as the git credentials file is.
  const tokenFile = usablePath(setting) ? resolve(setting) : setting;
  const claudeSetting = env.MIMIR_AGENT_CLAUDE_PATH;
  let claudePath: string | undefined;
  if (claudeSetting !== undefined) {
    // An unusable value stays as given, so the executable check names the setting.
    claudePath = usablePath(claudeSetting) ? resolve(claudeSetting) : claudeSetting;
  }
  const base = { claudePath, dataDirectory, hostFiltering: serve.hosts !== undefined, tokenFile };
  return {
    ...base,
    ...readTuning(env),
    enabled: true,
    problems: await prerequisiteProblems(base),
  };
}

/** The startup warnings: each setting and its problem or fallback, never a value it was given. */
export function agentStartupWarnings(settings: AgentSettings): string[] {
  if (!settings.enabled) {
    return [];
  }
  return [
    ...settings.problems.map(
      ({ problem, setting }) =>
        `⚠ host: agent runs are not set up: ${setting} is ${problem}; agent runs stay off until it is fixed`,
    ),
    ...settings.fallbacks.map(
      ({ fallback, problem, setting }) =>
        `⚠ host: ${setting} is ${problem}; agent runs use ${fallback}`,
    ),
  ];
}

/**
 * Whether the API has refused the token on file. The runner records a
 * refusal against the token file's identity, so replacing the file clears it.
 * In memory only: a restart tries the token again.
 */
export type AgentConnection = {
  /** Record that the API refused the token whose file had this identity. */
  reject: (identity: string) => void;
  /** Whether the token whose file has this identity was refused. */
  rejected: (identity: string) => boolean;
};

/** A fresh connection record: nothing refused yet. */
export function createAgentConnection(): AgentConnection {
  let refused: string | undefined;
  return {
    reject(identity) {
      refused = identity;
    },
    rejected(identity) {
      return refused === identity;
    },
  };
}

/** The runtime's state with the token a run uses, read at the point of use. */
export type CurrentAgent =
  | Exclude<AgentState, { state: 'ready' }>
  | { state: 'ready'; tokenModifiedAt: Date; token: string; tokenIdentity: string };

/**
 * Check the settings again where they are used and read the token: the token
 * file and the data directory can change after boot.
 */
export async function currentAgent(
  settings: AgentSettings,
  connection: AgentConnection,
): Promise<CurrentAgent> {
  if (!settings.enabled) {
    return { state: 'unconfigured' };
  }
  const [problem] = await prerequisiteProblems(settings);
  if (problem !== undefined) {
    return { state: 'misconfigured', ...problem };
  }
  const token = await readAgentToken(settings.tokenFile);
  if ('problem' in token) {
    return { state: 'misconfigured', ...token.problem };
  }
  if (connection.rejected(token.identity)) {
    return { reason: 'rejected', state: 'disconnected' };
  }
  return {
    state: 'ready',
    token: token.token,
    tokenIdentity: token.identity,
    tokenModifiedAt: token.modifiedAt,
  };
}

/** The runtime's state for the console: {@link currentAgent} without the token. */
export async function agentState(
  settings: AgentSettings,
  connection: AgentConnection,
): Promise<AgentState> {
  const current = await currentAgent(settings, connection);
  return current.state === 'ready'
    ? { state: 'ready', tokenModifiedAt: current.tokenModifiedAt }
    : current;
}
