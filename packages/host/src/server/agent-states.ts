/*
 * The agent runtime's tagged states (ADR 0041), in the T3 integration's
 * pattern: a feature that is off, set up wrongly, refused by the API, or
 * ready. The console reads these, so this file imports nothing.
 */

/** A setting the agent runtime depends on. */
export type AgentSetting =
  | 'MIMIR_AGENT_CLAUDE_PATH'
  | 'MIMIR_AGENT_TOKEN_FILE'
  | 'MIMIR_DATA_DIR'
  | 'MIMIR_HOSTS';

/** What is wrong with that setting; never its value. */
export type AgentProblem = 'empty' | 'not executable' | 'not writable' | 'unreadable' | 'unset';

/** One configuration problem: the setting and the problem kind. */
export type AgentMisconfiguration = { setting: AgentSetting; problem: AgentProblem };

/** Why the configured token cannot be used: the API refused it. */
export type AgentDisconnection = 'rejected';

/**
 * The agent runtime's state. `ready` and `disconnected` carry the token
 * file's modification time, which the console shows as the token's age: a
 * refused token is replaced by replacing the file.
 */
export type AgentState =
  | { state: 'unconfigured' }
  | ({ state: 'misconfigured' } & AgentMisconfiguration)
  | { state: 'disconnected'; reason: AgentDisconnection; tokenModifiedAt: Date }
  | { state: 'ready'; tokenModifiedAt: Date };
