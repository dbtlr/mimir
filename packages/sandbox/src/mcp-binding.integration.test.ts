import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { command, isolatedEnvironment } from './process';

/**
 * `mimir mcp` resolves its Project Binding from the directory it is spawned in
 * (MMR-558). The shipping binary is copied into a temp dir, so it keeps its
 * store beside itself and never touches a live one; a clone whose config sets
 * `mimir.project` binds the server, and a bare directory does not. MMR-555's
 * cutover repoints this test at the Loom binary rather than deleting it.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const enabled = process.env.MIMIR_SANDBOX_LIFECYCLE_TEST === '1';

let root: string;
let binary: string;
let bound: string;
let unbound: string;

/** One setup command, bounded and fully drained by the shared sandbox helper. */
async function run(args: string[], cwd: string): Promise<void> {
  await command(args, { cwd, timeout: 60_000 });
}

beforeAll(async () => {
  if (!enabled) {
    return;
  }
  root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-mcp-binding-')));
  binary = join(root, 'bin', 'mimir');
  bound = join(root, 'clone');
  unbound = join(root, 'plain');
  await mkdir(join(root, 'bin'));
  await mkdir(bound);
  await mkdir(unbound);
  await copyFile(join(repository, 'dist', 'mimir'), binary);
  await chmod(binary, 0o755);
  await run(['git', 'init', '-q'], bound);
  await run(['git', 'config', 'mimir.project', 'DEMO'], bound);
  await run([binary, 'create', 'project', 'Demo', '--key', 'DEMO', '-y'], root);
  await run([binary, 'create', 'initiative', 'Work', '--parent', 'DEMO'], root);
  await run([binary, 'create', 'task', 'the bound task', '--parent', 'DEMO-1'], root);
  // A second board, so a portfolio-wide answer is told apart from the bound one.
  await run([binary, 'create', 'project', 'Other', '--key', 'OTHR', '-y'], root);
  await run([binary, 'create', 'initiative', 'Work', '--parent', 'OTHR'], root);
  await run([binary, 'create', 'task', 'the other task', '--parent', 'OTHR-1'], root);
}, 60_000);

afterAll(async () => {
  if (enabled) {
    await rm(root, { force: true, recursive: true });
  }
});

/** Call `tool` with no scope on a `mimir mcp` server spawned in `cwd`. */
async function callFrom(tool: string, cwd: string): Promise<{ isError: boolean; text: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(isolatedEnvironment())) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const transport = new StdioClientTransport({ args: ['mcp'], command: binary, cwd, env });
  const client = new Client({ name: 'mcp-binding-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ arguments: {}, name: tool });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((part: { text?: unknown }) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    return { isError: result.isError === true, text };
  } finally {
    await client.close();
  }
}

test.skipIf(!enabled)(
  'mimir mcp binds to the project its spawn directory names',
  async () => {
    const result = await callFrom('next', bound);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('the bound task');
    expect(result.text).not.toContain('the other task');
  },
  30_000,
);

// `overview` reads one board, so the same scope-less call reads the bound board
// from the clone and refuses outside it. (`next` widens to the portfolio when unbound.)
test.skipIf(!enabled)(
  'a scope-less overview from the bound clone reads that project',
  async () => {
    const result = await callFrom('overview', bound);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('the bound task');
    expect(result.text).not.toContain('the other task');
  },
  30_000,
);

test.skipIf(!enabled)(
  'the same overview from an unbound directory refuses with the needs-a-project error',
  async () => {
    const result = await callFrom('overview', unbound);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('overview needs a project');
  },
  30_000,
);
