/**
 * The CLI's real entry (`main.ts` -> `runMimir`) is wired to the store builder
 * that refuses Postgres. Driving the entry as a process is the only way to prove
 * the wiring: a unit test of `buildLocalStore` passes even when the entry calls
 * a builder that opens Postgres.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');

/** A local sandbox authority whose config.toml is `config`, so the entry reads that config. */
function sandboxWithConfig(config: string): { env: Record<string, string>; close: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mimir-entry-')));
  const paths = {
    cache: join(root, 'cache', 'mimir'),
    config: join(root, 'config', 'mimir'),
    data: join(root, 'data', 'mimir'),
  };
  for (const path of Object.values(paths)) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(paths.config, 'config.toml'), config);
  const authority = join(root, 'authority.json');
  writeFileSync(
    authority,
    JSON.stringify({
      id: '12345678-1234-4234-8234-123456789012',
      kind: 'local',
      paths,
      root,
      version: 1,
    }),
  );
  return {
    close: () => rmSync(root, { force: true, recursive: true }),
    env: { MIMIR_SANDBOX_AUTHORITY: authority },
  };
}

test('the CLI entry refuses a [store] that names Postgres instead of connecting', () => {
  // Port 1 refuses connections, so a builder that does connect fails differently.
  const sandbox = sandboxWithConfig(
    '[store]\nbackend = "postgres"\nurl = "postgres://u:p@127.0.0.1:1/db"\n',
  );
  try {
    const { MIMIR_TEST_POSTGRES_URL: _drop, ...inherited } = process.env;
    const run = Bun.spawnSync(['bun', join(REPO, 'packages/cli/src/main.ts'), 'list'], {
      cwd: REPO,
      env: { ...inherited, ...sandbox.env },
      timeout: 60_000,
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect(run.exitCode).not.toBe(0);
    expect(output).toContain('the CLI opens only a SQLite store');
    expect(output).toContain('docs/guides/move-to-a-host.md');
  } finally {
    sandbox.close();
  }
}, 90_000);
