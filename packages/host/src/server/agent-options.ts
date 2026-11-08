import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentDefinition,
  CanUseTool,
  HookCallback,
  McpSdkServerConfigWithInstance,
  Options,
} from '@anthropic-ai/claude-agent-sdk';

import { errorCode } from './error-code';

/** The runner's own read-only agent, the only subagent a run may start. */
export const READER_AGENT = 'reader';

/** The built-in tools a run has. The subagent tool is `Agent`; the gate also knows it as `Task`. */
export const RUN_TOOLS = ['Read', 'Grep', 'Glob', 'Agent'] as const;

/** The subprocess's search path: system directories only. Runs have no shell. */
export const RUN_PATH = '/usr/local/bin:/usr/bin:/bin';

/** A run id usable as one directory name. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The per-run directory under `MIMIR_DATA_DIR`, holding the run's config, temp, and home. */
export function runDirectoryFor(dataDirectory: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('a run id must be letters, digits, dashes, or underscores');
  }
  return join(dataDirectory, 'agent', 'runs', runId);
}

/**
 * The directories inside a run directory. The runner creates them before the
 * run; the CLI dies with EROFS when `TMPDIR` is on the image's read-only root.
 */
export function runPaths(runDirectory: string) {
  return {
    configDirectory: join(runDirectory, 'config'),
    home: join(runDirectory, 'home'),
    tmpDirectory: join(runDirectory, 'tmp'),
  };
}

/**
 * The run's whole subprocess environment. The SDK's `env` replaces the
 * environment rather than merging it, so no host variable (the database URL,
 * the secret key, git credentials) reaches the CLI unless it is listed here.
 */
export function runEnvironment(token: string, runDirectory: string): Record<string, string> {
  const paths = runPaths(runDirectory);
  return {
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_FORK_SUBAGENT: '0',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CONFIG_DIR: paths.configDirectory,
    HOME: paths.home,
    PATH: RUN_PATH,
    TMPDIR: paths.tmpDirectory,
  };
}

/** The reader: survey code with Read, Grep, and Glob, and nothing else. */
const READER_DEFINITION: AgentDefinition = {
  description:
    "Reads the project's code to answer one question: finds files, searches them, and reports what it found with file paths.",
  // Subagents inherit MCP tools by default; this removes every MCP tool, the run grant's too.
  disallowedTools: ['mcp__*'],
  omitClaudeMd: true,
  prompt:
    "You survey the project's code to answer the question you are given. Use Read, Grep, and Glob. Report what you found and the file paths that show it. You cannot change files or the board.",
  tools: ['Read', 'Grep', 'Glob'],
};

/** The backstop behind the gate: no call reaches a permission prompt and passes. */
export const denyEveryTool: CanUseTool = async () => ({
  behavior: 'deny',
  message: 'agent runs allow only what the gate allows',
});

/** What one run's options are built from. */
export type RunOptionsInput = {
  /** The clone's work tree, as the real path `syncClone` returns; the run's `cwd`. */
  cloneRoot: string;
  /** From {@link runDirectoryFor}. */
  runDirectory: string;
  token: string;
  model: string;
  maxTurns: number;
  /** The run's system prompt: its kind's brief. */
  systemPrompt: string;
  /** The PreToolUse gate from `createAgentGate`. */
  gate: HookCallback;
  /** The run grant's in-process MCP server; the run's only MCP server. */
  grant: McpSdkServerConfigWithInstance;
  /** `MIMIR_AGENT_CLAUDE_PATH`; absent uses the SDK's own platform package. */
  claudePath: string | undefined;
  abortController: AbortController;
};

/**
 * The SDK `query` options for one run (ADR 0041, "A run's configuration is
 * code, never discovery"). Every option the SDK would otherwise discover is
 * given: no settings sources, no MCP configuration but the grant, an explicit
 * tool list, the gate registered fail-closed, and a replaced environment.
 */
export function buildRunOptions(input: RunOptionsInput): Options {
  return {
    abortController: input.abortController,
    agents: { [READER_AGENT]: READER_DEFINITION },
    canUseTool: denyEveryTool,
    cwd: input.cloneRoot,
    env: runEnvironment(input.token, input.runDirectory),
    // No matcher: the gate sees every tool call. 'block' makes a hook that
    // throws, returns nothing, or returns invalid output block the call.
    hooks: { PreToolUse: [{ hooks: [input.gate], onFailure: 'block' }] },
    maxTurns: input.maxTurns,
    mcpServers: { [input.grant.name]: input.grant },
    model: input.model,
    permissionMode: 'dontAsk',
    settingSources: [],
    strictMcpConfig: true,
    systemPrompt: input.systemPrompt,
    tools: [...RUN_TOOLS],
    ...(input.claudePath === undefined ? {} : { pathToClaudeCodeExecutable: input.claudePath }),
  };
}

/*
 * Where Claude Code reads managed policy, which applies whatever
 * `settingSources` says (ADR 0041; the spike ran a planted SessionStart hook
 * from /etc/claude-code/managed-settings.json under `settingSources: []`).
 * The file-based tier is `managed-settings.json`, its `managed-settings.d/`
 * drop-in directory, and `managed-mcp.json`, in /etc/claude-code on Linux
 * and /Library/Application Support/ClaudeCode on macOS; macOS MDM delivers
 * the `com.anthropic.claudecode` managed-preferences domain
 * (code.claude.com/docs/en/settings, "Settings files"; .../managed-mcp).
 * Server-managed settings are a separate tier these paths do not cover: the
 * CLI fetches them from api.anthropic.com when the run authenticates with a
 * Team or Enterprise organization's credential, a `CLAUDE_CODE_OAUTH_TOKEN`
 * included, and `settingSources` does not control them
 * (.../server-managed-settings; .../agent-sdk/claude-code-features). The
 * fresh config directory only means no copy is cached from an earlier run.
 */
const POLICY_DIRECTORIES = ['etc/claude-code', 'Library/Application Support/ClaudeCode'];
const POLICY_FILES = ['managed-settings.json', 'managed-settings.d', 'managed-mcp.json'];
export const MANAGED_POLICY_PATHS: readonly string[] = [
  ...POLICY_DIRECTORIES.flatMap((directory) => POLICY_FILES.map((file) => `/${directory}/${file}`)),
  '/Library/Managed Preferences/com.anthropic.claudecode.plist',
];

/**
 * The managed policy paths that exist, relative to `root` (the filesystem
 * root outside tests). The runner refuses a run while any exists. A path the
 * host cannot inspect counts as present.
 */
export async function presentManagedPolicy(root = '/'): Promise<string[]> {
  const present: string[] = [];
  for (const path of MANAGED_POLICY_PATHS) {
    try {
      await lstat(join(root, path));
      present.push(path);
    } catch (error) {
      const code = errorCode(error);
      // ENOTDIR: a file stands where a policy directory would be, so no policy is there.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        present.push(path);
      }
    }
  }
  return present;
}
