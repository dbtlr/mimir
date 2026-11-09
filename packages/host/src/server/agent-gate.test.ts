import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { createAgentGate } from './agent-gate';
import type { AgentGateOptions } from './agent-gate';

/*
 * The gate is the run's whole tool policy (ADR 0041). Each test states an
 * attack a model steered by repository content could try, and the decision
 * the gate must give.
 */

let root: string;
let clone: string;
let dataDirectory: string;
let outside: string;

const GRANT_TOOLS = ['mcp__mimir__get', 'mcp__mimir__annotate'];

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-agent-gate-')));
  dataDirectory = join(root, 'data');
  clone = join(dataDirectory, 'clones', 'ENG');
  outside = join(root, 'outside');
  await mkdir(join(clone, 'src'), { recursive: true });
  await mkdir(join(dataDirectory, 'git', 'ENG'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(clone, 'README.md'), 'readme');
  await writeFile(join(clone, 'src', 'main.ts'), 'code');
  await writeFile(join(outside, 'canary'), 'secret');
  await writeFile(join(dataDirectory, 'git', 'ENG', 'config'), '[core]');
  await writeFile(join(dataDirectory, 'mimir.sqlite'), 'store');
  await symlink(join(clone, 'src', 'main.ts'), join(clone, 'inner-link'));
  await symlink(join(outside, 'canary'), join(clone, 'escape-link'));
  await symlink(outside, join(clone, 'escape-dir'));
  await symlink(join(dataDirectory, 'git', 'ENG', 'config'), join(clone, 'git-link'));
  // Real directories a commit can hold beside `escape-dir`: names the tools trim or
  // normalize to `escape-dir`, so the gate would check the decoy while the tool searches the link.
  for (const decoy of DECOYS) {
    await mkdir(join(clone, decoy));
  }
  await mkdir(join(clone, NFD_NAME));
  // Linux keeps the composed name apart; macOS already finds the decomposed one under it.
  await mkdir(join(clone, 'caf\u00e9'), { recursive: true });
  await mkdir(join(clone, 'bell\u0007dir'));
  // A directory literally named `~`, which the tools would read as the run's home.
  await mkdir(join(clone, '~'));
  await writeFile(join(clone, '~', 'notes.txt'), 'notes');
  // A sibling clone whose key extends this one's: clones/ENG must not reach clones/ENGX.
  await mkdir(join(dataDirectory, 'clones', 'ENGX'));
  await writeFile(join(dataDirectory, 'clones', 'ENGX', 'secret.txt'), 'other project');
});

/** Names the tools turn into `escape-dir` by trimming whitespace. */
const DECOYS = ['escape-dir ', ' escape-dir', 'escape-dir\t', 'escape-dir\u00a0'];

/** `café` in decomposed form; the tools search its composed (NFC) spelling. */
const NFD_NAME = 'cafe\u0301';

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

/** A gate over the fixture clone; `spawns` counts the allowance charged. */
function gate(overrides: Partial<AgentGateOptions> = {}) {
  const spawns = { charged: 0 };
  const hook = createAgentGate({
    cancelled: () => false,
    chargeSpawn: () => {
      spawns.charged += 1;
      return true;
    },
    cloneRoot: clone,
    dataDirectory,
    grantToolNames: GRANT_TOOLS,
    readerAgentName: 'reader',
    ...overrides,
  });
  return { hook, spawns };
}

/** Ask the gate about one call; `agentId` marks a call made by a subagent. */
async function decide(
  hook: ReturnType<typeof gate>['hook'],
  toolName: string,
  toolInput: unknown,
  agentId?: string,
) {
  const input: PreToolUseHookInput = {
    cwd: clone,
    hook_event_name: 'PreToolUse',
    session_id: 'session',
    tool_input: toolInput,
    tool_name: toolName,
    tool_use_id: 'tool-use',
    transcript_path: join(root, 'transcript.jsonl'),
    ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'reader' }),
  };
  const output = (await hook(input, 'tool-use', {
    signal: new AbortController().signal,
  })) as SyncHookJSONOutput;
  const specific = output.hookSpecificOutput;
  if (specific?.hookEventName !== 'PreToolUse') {
    throw new Error('the gate must answer with PreToolUse output');
  }
  expect(specific.permissionDecisionReason).toBeString();
  return specific.permissionDecision;
}

test('reads of real files inside the clone are allowed, from the main agent or a subagent', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'Read', { file_path: join(clone, 'README.md') })).toBe('allow');
  expect(await decide(hook, 'Read', { file_path: 'src/main.ts', limit: 10, offset: 1 })).toBe(
    'allow',
  );
  expect(await decide(hook, 'Read', { file_path: join(clone, 'README.md') }, 'agent-1')).toBe(
    'allow',
  );
  expect(await decide(hook, 'Read', { file_path: join(clone, 'inner-link') })).toBe('allow');
  expect(await decide(hook, 'Glob', { pattern: '**/*.ts' })).toBe('allow');
  expect(await decide(hook, 'Glob', { path: 'src', pattern: '*.ts' })).toBe('allow');
  expect(await decide(hook, 'Grep', { pattern: 'code' })).toBe('allow');
  expect(
    await decide(hook, 'Grep', {
      '-i': true,
      '-n': true,
      glob: '*.{ts,tsx}',
      output_mode: 'content',
      path: clone,
      pattern: 'co.e',
    }),
  ).toBe('allow');
});

test('a relative path that climbs out of the clone is denied', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'Read', { file_path: '../../../outside/canary' })).toBe('deny');
  expect(await decide(hook, 'Read', { file_path: 'src/../../../../outside/canary' })).toBe('deny');
  expect(await decide(hook, 'Grep', { path: '..', pattern: 'secret' })).toBe('deny');
  expect(await decide(hook, 'Glob', { path: '../..', pattern: '*' })).toBe('deny');
});

test('an absolute path outside the clone is denied, the store included', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'Read', { file_path: join(outside, 'canary') })).toBe('deny');
  expect(await decide(hook, 'Read', { file_path: join(dataDirectory, 'mimir.sqlite') })).toBe(
    'deny',
  );
  expect(await decide(hook, 'Read', { file_path: '/etc/passwd' })).toBe('deny');
  expect(await decide(hook, 'Grep', { path: '/', pattern: 'secret' })).toBe('deny');
});

test('a symlink inside the clone that points outside it is denied', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'Read', { file_path: join(clone, 'escape-link') })).toBe('deny');
  expect(await decide(hook, 'Read', { file_path: 'escape-dir/canary' })).toBe('deny');
  expect(await decide(hook, 'Grep', { path: 'escape-dir', pattern: 'secret' })).toBe('deny');
  expect(await decide(hook, 'Glob', { path: 'escape-dir', pattern: '*' })).toBe('deny');
});

test('nothing under the git directories is readable, through a symlink or directly', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'Read', { file_path: join(clone, 'git-link') })).toBe('deny');
  expect(
    await decide(hook, 'Read', { file_path: join(dataDirectory, 'git', 'ENG', 'config') }),
  ).toBe('deny');
  // Even a clone root that were somehow inside the git directories reads nothing there.
  const { hook: nested } = gate({ cloneRoot: join(dataDirectory, 'git') });
  expect(
    await decide(nested, 'Read', { file_path: join(dataDirectory, 'git', 'ENG', 'config') }),
  ).toBe('deny');
  expect(await decide(nested, 'Glob', { pattern: '**/*' })).toBe('deny');
});

test('a path that does not resolve is denied', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'Read', { file_path: join(clone, 'missing.ts') })).toBe('deny');
  expect(await decide(hook, 'Glob', { path: 'missing', pattern: '*' })).toBe('deny');
  expect(await decide(hook, 'Read', { file_path: '~/.ssh/id_ed25519' })).toBe('deny');
  expect(await decide(hook, 'Read', { file_path: '' })).toBe('deny');
  expect(await decide(hook, 'Read', { file_path: 'README.md\0' })).toBe('deny');
  expect(await decide(hook, 'Read', { file_path: 42 })).toBe('deny');
  expect(await decide(hook, 'Read', {})).toBe('deny');
  expect(await decide(hook, 'Read', null)).toBe('deny');
  expect(await decide(hook, 'Read', [join(clone, 'README.md')])).toBe('deny');
});

test('a path the tools would trim or normalize to another name is denied', async () => {
  const { hook } = gate();
  for (const decoy of DECOYS) {
    expect(await decide(hook, 'Grep', { path: decoy, pattern: 'secret' })).toBe('deny');
    expect(await decide(hook, 'Glob', { path: decoy, pattern: '*' })).toBe('deny');
    expect(await decide(hook, 'Read', { file_path: `${decoy}/canary` })).toBe('deny');
  }
  expect(await decide(hook, 'Grep', { path: NFD_NAME, pattern: 'secret' })).toBe('deny');
  expect(await decide(hook, 'Glob', { path: join(clone, NFD_NAME), pattern: '*' })).toBe('deny');
  // The same directory under its composed name is an ordinary path in the clone.
  expect(await decide(hook, 'Grep', { path: 'caf\u00e9', pattern: 'secret' })).toBe('allow');
});

test('a path holding a control character is denied', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'Grep', { path: 'bell\u0007dir', pattern: 'x' })).toBe('deny');
  expect(await decide(hook, 'Glob', { path: 'src\n', pattern: '*' })).toBe('deny');
});

test('a path starting with ~ is denied even when the clone holds a directory named ~', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'Read', { file_path: '~/notes.txt' })).toBe('deny');
  expect(await decide(hook, 'Grep', { path: '~', pattern: 'notes' })).toBe('deny');
  expect(await decide(hook, 'Glob', { path: '~', pattern: '*' })).toBe('deny');
});

test('a clone does not reach a sibling clone whose name extends its own', async () => {
  const { hook } = gate();
  const sibling = join(dataDirectory, 'clones', 'ENGX', 'secret.txt');
  expect(await decide(hook, 'Read', { file_path: sibling })).toBe('deny');
  expect(await decide(hook, 'Grep', { path: '../ENGX', pattern: 'project' })).toBe('deny');
});

test('a glob pattern the tools would trim or normalize is denied', async () => {
  const { hook } = gate();
  for (const pattern of [` ${outside}/*`, '*.ts ', '\t**/*', `${NFD_NAME}/*`, 'src/\u0007*']) {
    expect(await decide(hook, 'Glob', { pattern })).toBe('deny');
    expect(await decide(hook, 'Grep', { glob: pattern, pattern: 'x' })).toBe('deny');
  }
});

test('glob patterns that are absolute or climb are denied', async () => {
  const { hook } = gate();
  for (const pattern of ['/etc/*', '../*', '**/../../*', 'src/../../x', '{..,src}/*', '~/*']) {
    expect(await decide(hook, 'Glob', { pattern })).toBe('deny');
    expect(await decide(hook, 'Grep', { glob: pattern, pattern: 'x' })).toBe('deny');
  }
  expect(await decide(hook, 'Glob', { pattern: 42 })).toBe('deny');
  expect(await decide(hook, 'Grep', { glob: 42, pattern: 'x' })).toBe('deny');
});

test('a call carrying an input key its tool does not define is denied', async () => {
  const { hook } = gate();
  expect(
    await decide(hook, 'Read', { dangerouslyDisableSandbox: true, file_path: 'README.md' }),
  ).toBe('deny');
  expect(await decide(hook, 'Glob', { pattern: '*', root: '/' })).toBe('deny');
  expect(await decide(hook, 'Grep', { paths: ['/etc'], pattern: 'x' })).toBe('deny');
  expect(
    await decide(hook, 'Agent', {
      dangerouslyDisableSandbox: true,
      description: 'survey',
      prompt: 'look',
      subagent_type: 'reader',
    }),
  ).toBe('deny');
});

test('every tool outside the allowlist is denied, from the main agent and from subagents', async () => {
  const { hook } = gate();
  const calls: [string, unknown][] = [
    ['Bash', { command: 'cat /etc/passwd' }],
    ['Write', { content: 'x', file_path: join(clone, 'x') }],
    ['Edit', { file_path: join(clone, 'README.md'), new_string: 'b', old_string: 'a' }],
    ['MultiEdit', { edits: [], file_path: join(clone, 'README.md') }],
    ['NotebookEdit', { new_source: 'x', notebook_path: join(clone, 'n.ipynb') }],
    ['WebFetch', { prompt: 'x', url: 'https://example.com' }],
    ['WebSearch', { query: 'x' }],
    ['Skill', { skill: 'x' }],
    ['TodoWrite', { todos: [] }],
    ['SendMessage', { message: 'x', to: 'y' }],
    ['EnterWorktree', {}],
    ['mcp__other__read_secrets', {}],
    ['mcp__mimir__create', { title: 'x' }],
    ['mcp__mimir', {}],
    ['read', { file_path: join(clone, 'README.md') }],
    ['SomeFutureTool', {}],
    ['', {}],
  ];
  for (const [name, input] of calls) {
    expect(await decide(hook, name, input)).toBe('deny');
    expect(await decide(hook, name, input, 'agent-1')).toBe('deny');
  }
});

test('the grant tools are allowed from the main agent and denied to subagents', async () => {
  const { hook } = gate();
  expect(await decide(hook, 'mcp__mimir__get', { id: 'ENG-1' })).toBe('allow');
  expect(await decide(hook, 'mcp__mimir__annotate', { content: 'note' })).toBe('allow');
  expect(await decide(hook, 'mcp__mimir__get', { id: 'ENG-1' }, 'agent-1')).toBe('deny');
  expect(await decide(hook, 'mcp__mimir__annotate', { content: 'note' }, 'agent-1')).toBe('deny');
  expect(await decide(hook, 'mcp__mimir__annotate', { content: 'note' }, '')).toBe('deny');
});

test('the main agent may spawn the reader, charging the allowance once per spawn', async () => {
  const { hook, spawns } = gate();
  const spawn = { description: 'survey', prompt: 'read src', subagent_type: 'reader' };
  // An omitted flag is foreground: the run environment disables background
  // tasks, so the CLI offers no run_in_background and strips one the model sends.
  expect(await decide(hook, 'Agent', spawn)).toBe('allow');
  expect(await decide(hook, 'Task', { ...spawn, run_in_background: false })).toBe('allow');
  expect(spawns.charged).toBe(2);
});

test('a spawn from a subagent, of another agent type, or with overrides is denied uncharged', async () => {
  const { hook, spawns } = gate();
  const spawn = { description: 'survey', prompt: 'read src', subagent_type: 'reader' };
  expect(await decide(hook, 'Agent', spawn, 'agent-1')).toBe('deny');
  expect(await decide(hook, 'Agent', { ...spawn, subagent_type: 'general-purpose' })).toBe('deny');
  expect(await decide(hook, 'Agent', { ...spawn, subagent_type: 'fork' })).toBe('deny');
  expect(await decide(hook, 'Agent', { description: 'survey', prompt: 'x' })).toBe('deny');
  expect(await decide(hook, 'Agent', { ...spawn, isolation: 'remote' })).toBe('deny');
  expect(await decide(hook, 'Agent', { ...spawn, mode: 'bypassPermissions' })).toBe('deny');
  expect(await decide(hook, 'Agent', { ...spawn, model: 'fable' })).toBe('deny');
  // A background subagent can outlive the result message and escape settlement.
  expect(await decide(hook, 'Agent', { ...spawn, run_in_background: true })).toBe('deny');
  expect(await decide(hook, 'Agent', { ...spawn, run_in_background: 'true' })).toBe('deny');
  expect(spawns.charged).toBe(0);
});

test('a spawn the allowance does not cover is denied', async () => {
  const { hook } = gate({ chargeSpawn: () => false });
  expect(
    await decide(hook, 'Agent', { description: 'survey', prompt: 'x', subagent_type: 'reader' }),
  ).toBe('deny');
});

test('a gate whose internals throw denies the call', async () => {
  const { hook } = gate({
    chargeSpawn: () => {
      throw new Error('budget store unavailable');
    },
  });
  expect(
    await decide(hook, 'Agent', { description: 'survey', prompt: 'x', subagent_type: 'reader' }),
  ).toBe('deny');
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('hostile input');
      },
    },
  );
  expect(await decide(gate().hook, 'Read', hostile)).toBe('deny');
  const throwingPath = {
    get file_path(): string {
      throw new Error('hostile getter');
    },
  };
  expect(await decide(gate().hook, 'Read', throwingPath)).toBe('deny');
});

test('a hook event other than PreToolUse is denied', async () => {
  const { hook } = gate();
  const output = (await hook(
    {
      cwd: clone,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'x',
      session_id: 'session',
      transcript_path: 'x',
    },
    undefined,
    { signal: new AbortController().signal },
  )) as SyncHookJSONOutput;
  expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
});

/** Ask the gate about one main-agent call and answer its whole output. */
async function answer(hook: ReturnType<typeof gate>['hook'], toolName: string, toolInput: unknown) {
  return (await hook(
    {
      cwd: clone,
      hook_event_name: 'PreToolUse',
      session_id: 'session',
      tool_input: toolInput,
      tool_name: toolName,
      tool_use_id: 'tool-use',
      transcript_path: join(root, 'transcript.jsonl'),
    },
    'tool-use',
    { signal: new AbortController().signal },
  )) as SyncHookJSONOutput;
}

test('after a cancel every call is denied and stops the run, and no spawn is charged', async () => {
  const cancel = { recorded: false };
  const { hook, spawns } = gate({ cancelled: () => cancel.recorded });
  const spawn = { description: 'survey', prompt: 'read src', subagent_type: 'reader' };
  // Before the cancel, the same calls are allowed and do not stop the run.
  expect(await answer(hook, 'Read', { file_path: join(clone, 'README.md') })).not.toHaveProperty(
    'continue',
  );
  cancel.recorded = true;
  for (const [tool, input] of [
    ['Read', { file_path: join(clone, 'README.md') }],
    ['Agent', spawn],
    ['mcp__mimir__annotate', { content: 'note' }],
    ['Bash', { command: 'ls' }],
  ] as const) {
    expect(await answer(hook, tool, input)).toEqual({
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('console'),
      },
      stopReason: expect.stringContaining('console'),
    });
  }
  expect(spawns.charged).toBe(0);
});

test('a cancel recorded while the gate decides stops the call it answers', async () => {
  const cancel = { recorded: false };
  const { hook } = gate({
    cancelled: () => cancel.recorded,
    chargeSpawn: () => {
      cancel.recorded = true;
      return true;
    },
  });
  expect(
    await answer(hook, 'Agent', { description: 'survey', prompt: 'x', subagent_type: 'reader' }),
  ).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: 'deny' } });
});

test('the error path stops the run once a cancel is recorded', async () => {
  const cancel = { recorded: false };
  const { hook } = gate({
    cancelled: () => cancel.recorded,
    chargeSpawn: () => {
      // The cancel lands while the gate decides, and the decision throws.
      cancel.recorded = true;
      throw new Error('budget store unavailable');
    },
  });
  expect(
    await answer(hook, 'Agent', { description: 'survey', prompt: 'x', subagent_type: 'reader' }),
  ).toMatchObject({
    continue: false,
    hookSpecificOutput: { permissionDecision: 'deny' },
    stopReason: expect.stringContaining('console'),
  });
  // Without a cancel, a throw denies but does not stop the run.
  const plain = gate({
    chargeSpawn: () => {
      throw new Error('budget store unavailable');
    },
  });
  expect(
    await answer(plain.hook, 'Agent', {
      description: 'survey',
      prompt: 'x',
      subagent_type: 'reader',
    }),
  ).not.toHaveProperty('continue');
});
