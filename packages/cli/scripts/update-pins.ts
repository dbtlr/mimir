/**
 * Re-record parity pins. Runs the given test files (every parity test when none
 * are named) with `MIMIR_UPDATE_PINS=1`, which stages each file's pins as
 * `<pins>.staged`, then replaces the pin files only if the whole run exited 0:
 * every test and every cleanup hook passed. Otherwise the staged files are
 * deleted and no pin changes. Usage:
 *
 *   bun packages/cli/scripts/update-pins.ts [test files...]
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STAGED = '.staged';
const SOURCE = fileURLToPath(new URL('../src', import.meta.url));

/** Every `*.staged` file under `dir`. */
function stagedUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' ? [] : stagedUnder(path);
    }
    return name.endsWith(STAGED) ? [path] : [];
  });
}

/** The test files to run: those named, else every parity test and the MCP parity test. */
function targets(named: readonly string[]): string[] {
  if (named.length > 0) {
    return named.map((file) => (file.startsWith('/') ? file : join(process.cwd(), file)));
  }
  const commands = join(SOURCE, 'commands');
  return [
    ...readdirSync(commands)
      .filter((name) => name.endsWith('.parity.test.ts'))
      .map((name) => join(commands, name)),
    join(SOURCE, 'mcp-parity.test.ts'),
  ];
}

const files = targets(process.argv.slice(2));
const roots = new Set(files.map((file) => file.slice(0, file.lastIndexOf('/'))));
const run = Bun.spawnSync(['bun', 'test', ...files], {
  env: { ...process.env, MIMIR_UPDATE_PINS: '1' },
  stderr: 'inherit',
  stdout: 'inherit',
});
const staged = [...new Set([...roots].flatMap((root) => stagedUnder(root)))];
if (run.exitCode === 0) {
  for (const file of staged) {
    renameSync(file, file.slice(0, -STAGED.length));
  }
  console.log(`pins updated: ${String(staged.length)} file(s)`);
} else {
  for (const file of staged) {
    rmSync(file, { force: true });
  }
  console.error('pins not updated: the run did not pass, so nothing was written');
  process.exitCode = run.exitCode || 1;
}
