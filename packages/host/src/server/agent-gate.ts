import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import type { HookCallback, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/** What the gate is built from for one run. */
export type AgentGateOptions = {
  /** The clone's work tree, as the real path `syncClone` returns. */
  cloneRoot: string;
  /** `MIMIR_DATA_DIR`; nothing under its `git` directory is ever readable. */
  dataDirectory: string;
  /** The run grant's tools, by their full `mcp__<server>__<tool>` names. */
  grantToolNames: readonly string[];
  /** The runner's own read-only agent, the only one a run may spawn. */
  readerAgentName: string;
  /** Charge one subagent's allowance against the run; false denies the spawn. */
  chargeSpawn: () => boolean;
};

type Decision = { allow: true; reason: string } | { allow: false; reason: string };

const deny = (reason: string): Decision => ({ allow: false, reason });
const allow = (reason: string): Decision => ({ allow: true, reason });

/*
 * Each read tool's input keys, from the SDK 0.3.318 tool input types
 * (sdk-tools.d.ts: FileReadInput, GlobInput, GrepInput). A key outside its
 * list denies the call, so a field a later CLI adds cannot widen a read
 * before the gate knows it.
 */
const READ_KEYS = new Set(['file_path', 'offset', 'limit', 'pages', 'allow_large']);
const GLOB_KEYS = new Set(['pattern', 'path']);
const GREP_KEYS = new Set([
  'pattern',
  'path',
  'glob',
  'output_mode',
  '-B',
  '-A',
  '-C',
  'context',
  '-n',
  '-i',
  '-o',
  'type',
  'head_limit',
  'offset',
  'multiline',
]);
const INPUT_KEYS = { Glob: GLOB_KEYS, Grep: GREP_KEYS, Read: READ_KEYS } as const;

/*
 * The spawn keys a run may use, a subset of AgentInput: model, effort,
 * isolation, mode, and team overrides are denied, so a spawn runs as the
 * runner defined its reader and costs what its allowance assumes.
 */
const SPAWN_KEYS = new Set(['description', 'prompt', 'subagent_type', 'run_in_background', 'name']);

/** The subagent tool reaches the hook as `Agent`; `Task` is its former name. */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

/** Whether the input is a plain record, not null, an array, or a primitive. */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/** The input as a plain record, or undefined for anything else. */
function recordOf(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined;
}

/** The first key of `input` outside `allowed`. */
function unknownKey(input: Record<string, unknown>, allowed: ReadonlySet<string>) {
  return Reflect.ownKeys(input).find((key) => typeof key !== 'string' || !allowed.has(key));
}

/** Whether `path` is `directory` or inside it. */
function within(path: string, directory: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
  );
}

/*
 * Control characters (Unicode Cc: C0, DEL, and C1). No path a run needs holds
 * one, and a name that does could print as another name in a transcript.
 */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Why a path or pattern is not in the one spelling the tools act on, or
 * undefined when it is. Claude Code (2.1.318, its path expansion) trims a Glob
 * or Grep path and NFC-normalizes it after this hook decides, so the gate
 * would resolve `escape-dir ` (a real directory) while the tool searched the
 * symlink `escape-dir`. Read's file_path arrives already expanded. Requiring
 * the canonical spelling makes the gate and the tool name the same file.
 */
function notCanonical(value: string): string | undefined {
  if (CONTROL_CHARACTER.test(value)) {
    return 'holds a control character';
  }
  if (value !== value.trim()) {
    return 'starts or ends with white space';
  }
  if (value !== value.normalize('NFC')) {
    return 'is not in Unicode composed form (NFC)';
  }
  return undefined;
}

/** Whether a glob could name a file outside its search root: absolute, home-relative, or climbing. */
function escapingGlob(pattern: string): boolean {
  if (isAbsolute(pattern) || pattern.startsWith('~') || pattern.startsWith('\\')) {
    return true;
  }
  // Brace and list syntax can hide a `..` segment, as `{..,src}/*` does.
  return pattern.split(/[/\\{},]/).some((segment) => segment === '..');
}

/** The roots a run may read inside, and the git directories it never may. */
type Roots = { clone: string; forbidden: string[] };

/**
 * Resolve one path argument through every symlink and decide it. Relative
 * paths resolve against the clone, as the tools resolve them against `cwd`.
 */
async function checkPath(value: unknown, roots: Roots, name: string): Promise<Decision> {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    return deny(`${name} must be a path inside the clone`);
  }
  const spelling = notCanonical(value);
  if (spelling !== undefined) {
    return deny(`${name} ${spelling}`);
  }
  if (value.startsWith('~')) {
    return deny(`${name} must not name a home directory`);
  }
  const absolute = isAbsolute(value) ? value : resolve(roots.clone, value);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return deny(`${name} does not resolve to a file in the clone`);
  }
  if (roots.forbidden.some((directory) => within(real, directory))) {
    return deny(`${name} is inside the host's git directories`);
  }
  return within(real, roots.clone)
    ? allow(`${name} is inside the clone`)
    : deny(`${name} resolves outside the clone`);
}

/** Decide Read, Glob, or Grep: known keys, safe patterns, and every path inside the clone. */
async function decideRead(
  tool: keyof typeof INPUT_KEYS,
  input: unknown,
  roots: Roots,
): Promise<Decision> {
  const args = recordOf(input);
  if (args === undefined) {
    return deny(`${tool} input must be an object`);
  }
  const stray = unknownKey(args, INPUT_KEYS[tool]);
  if (stray !== undefined) {
    return deny(`${tool} does not take ${String(stray)}`);
  }
  if (tool === 'Read') {
    return checkPath(args.file_path, roots, 'file_path');
  }
  const pattern = tool === 'Glob' ? args.pattern : args.glob;
  if (tool === 'Glob' || pattern !== undefined) {
    const name = tool === 'Glob' ? 'pattern' : 'glob';
    if (typeof pattern !== 'string' || escapingGlob(pattern)) {
      return deny(`${name} must be a relative pattern that stays in its path`);
    }
    const spelling = notCanonical(pattern);
    if (spelling !== undefined) {
      return deny(`${name} ${spelling}`);
    }
  }
  // An omitted path searches the clone itself.
  return checkPath(args.path ?? roots.clone, roots, 'path');
}

/** Decide a subagent spawn: the main agent only, the reader only, within its allowance. */
function decideSpawn(input: unknown, fromSubagent: boolean, options: AgentGateOptions): Decision {
  if (fromSubagent) {
    return deny('subagents cannot start subagents');
  }
  const args = recordOf(input);
  if (args === undefined) {
    return deny('Agent input must be an object');
  }
  const stray = unknownKey(args, SPAWN_KEYS);
  if (stray !== undefined) {
    return deny(`Agent does not take ${String(stray)} in an agent run`);
  }
  if (args.subagent_type !== options.readerAgentName) {
    return deny(`only the ${options.readerAgentName} agent may be started`);
  }
  // Charged last, so a spawn denied for any other reason costs nothing.
  return options.chargeSpawn()
    ? allow('a reader subagent within the run budget')
    : deny("the run's budget does not cover another subagent");
}

/** The whole policy for one call. Anything not allowed here is denied. */
async function decide(
  input: HookInput,
  options: AgentGateOptions,
  roots: Roots,
  grantTools: ReadonlySet<string>,
): Promise<Decision> {
  if (input.hook_event_name !== 'PreToolUse') {
    return deny('the gate answers only PreToolUse');
  }
  const tool = input.tool_name;
  // A call from a subagent carries agent_id; any value at all, even empty, marks one.
  const fromSubagent = input.agent_id !== undefined;
  if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
    return decideRead(tool, input.tool_input, roots);
  }
  if (SPAWN_TOOLS.has(tool)) {
    return decideSpawn(input.tool_input, fromSubagent, options);
  }
  if (grantTools.has(tool)) {
    return fromSubagent
      ? deny('subagents cannot use the run grant')
      : allow("a tool of the run's grant");
  }
  return deny(`${tool === '' ? 'an unnamed tool' : tool} is not available in an agent run`);
}

/** The SDK's PreToolUse answer for a decision. */
function output(decision: Decision): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allow ? 'allow' : 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
}

/**
 * The run's one gate (ADR 0041): a PreToolUse hook, deny by default. It allows
 * Read, Grep, and Glob on real paths inside the clone, spawns of the reader
 * agent from the main agent, and the run grant's tools from the main agent.
 * The options builder registers it with `onFailure: 'block'`; an exception
 * inside it also denies.
 */
export function createAgentGate(options: AgentGateOptions): HookCallback {
  const gitDirectory = resolve(options.dataDirectory, 'git');
  const grantTools = new Set(options.grantToolNames);
  return async (input) => {
    try {
      // Resolved per call: a clone root that does not resolve throws, and so denies.
      const realGit = await realpath(gitDirectory).catch(() => gitDirectory);
      const roots: Roots = {
        clone: await realpath(options.cloneRoot),
        forbidden: [...new Set([gitDirectory, realGit])],
      };
      return output(await decide(input, options, roots, grantTools));
    } catch {
      return output(deny('the gate could not decide this call'));
    }
  };
}
