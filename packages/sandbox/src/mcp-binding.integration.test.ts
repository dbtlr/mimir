import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '../../cli/package.json';
import { VERSION } from '../../cli/src/version';
import { command, isolatedEnvironment } from './process';

/**
 * `mimir mcp` resolves its Project Binding from the directory it is spawned in
 * (MMR-558). The candidate binary is copied into a temp dir, so it keeps its
 * store beside itself and never touches a live one. Release validation
 * supplies MIMIR_TEST_BINARY, the binary the workflow just built; the sandbox
 * lane defaults to dist/mimir, which `bun run build` produces.
 * The server speaks protocol revision 2026-07-28 only, which the MCP SDK's
 * client does not, so the test sends JSON-RPC lines itself.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const enabled = process.env.MIMIR_SANDBOX_LIFECYCLE_TEST === '1';

let root: string;
let binary: string;
let bound: string;
let unbound: string;

/** A CLI subprocess, bounded and fully drained by the shared sandbox helper. */
function run(args: string[], cwd: string): Promise<string> {
  return command(args, { cwd, timeout: 60_000 });
}

beforeAll(async () => {
  if (!enabled) {
    return;
  }
  root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-loom-mcp-binding-')));
  binary = join(root, 'bin', 'mimir');
  bound = join(root, 'clone');
  unbound = join(root, 'plain');
  await mkdir(join(root, 'bin'));
  await mkdir(bound);
  await mkdir(unbound);
  await copyFile(process.env.MIMIR_TEST_BINARY ?? join(repository, 'dist', 'mimir'), binary);
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

// Release validation's candidate is a release build, which reports the version
// the workflow stamped into package.json; the sandbox lane's dist/mimir is a
// development build, which reports the CLI's development version.
test.skipIf(!enabled)('the compiled candidate reports its build version', async () => {
  const expected = process.env.MIMIR_TEST_BINARY === undefined ? VERSION : pkg.version;
  expect(await run([binary, 'version'], root)).toBe(expected);
});

test.skipIf(!enabled)('the compiled candidate supports the installation protocol', async () => {
  expect(await run([binary, 'installation-protocol'], root)).toBe('{"installationProtocol":1}');
});

type ToolResult = {
  content: { text: string }[];
  isError: boolean;
  structuredContent?: unknown;
};

/** Call `tool` with no arguments on a `mimir mcp` server spawned in `cwd`. */
async function callFrom(
  tool: string,
  cwd: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; structured: unknown }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(isolatedEnvironment())) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const server = Bun.spawn([binary, 'mcp'], {
    cwd,
    env,
    stderr: 'pipe',
    stdin: 'pipe',
    stdout: 'pipe',
  });
  try {
    await server.stdin.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          _meta: {
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          },
          arguments: args,
          name: tool,
        },
      })}\n`,
    );
    await server.stdin.flush();
    // One request, one line back; the server answers a call before stdin ends.
    const reader = server.stdout.getReader();
    let buffered = '';
    while (!buffered.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += new TextDecoder().decode(value);
    }
    const { result } = JSON.parse(buffered.split('\n')[0] ?? '') as { result: ToolResult };
    return {
      isError: result.isError,
      structured: result.structuredContent,
      text: result.content.map((part) => part.text).join(''),
    };
  } finally {
    await server.stdin.end();
    server.kill();
    await server.exited;
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

// An explicit scope wins over the binding the spawn directory supplies.
test.skipIf(!enabled)(
  'an explicit scope from the bound clone reads that project instead',
  async () => {
    const result = await callFrom('next', bound, { scope: 'OTHR' });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('the other task');
    expect(result.text).not.toContain('the bound task');
  },
  30_000,
);

// A board read names one project (ADR 0037): from an unbound directory, the
// same scope-less calls are refused with the usage error that names both ways
// to supply one, where the old `next` widened to the portfolio.
test.skipIf(!enabled)(
  'the same overview and next from an unbound directory refuse with the needs-a-project error',
  async () => {
    for (const tool of ['overview', 'next']) {
      const result = await callFrom(tool, unbound);
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain(`${tool} needs a project`);
      expect(result.structured, tool).toMatchObject({ failure: { code: 'usage', exitCode: 2 } });
    }
  },
  30_000,
);
