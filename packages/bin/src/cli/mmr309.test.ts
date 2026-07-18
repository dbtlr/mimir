/**
 * MMR-309 — golden pins for `synthesizeParseError`'s regex/branch matching
 * against REAL `node:util` `parseArgs` failures.
 *
 * `synthesizeParseError` (run.ts) re-voices Node/Bun's `parseArgs` errors by
 * pattern-matching the runtime's own message text — text the function's own
 * doc comment says was "empirically enumerated" against one runtime. If a
 * future runtime reword breaks a regex, every case here fails LOUDLY with a
 * name that states exactly which shape broke, instead of quietly degrading
 * every flag-error hint to the generic fallback.
 *
 * `synthesizeParseError` isn't exported, so each case drives the real thing
 * through `runCli` — the same seam `cli.test.ts` already uses for flag
 * errors. `runCli` calls the actual `parseArgs` with the CLI's real OPTIONS
 * table and feeds whatever it throws straight into `synthesizeParseError`;
 * nothing here hand-builds an Error. This exercises the production path
 * more faithfully than calling `synthesizeParseError` directly ever could,
 * and needs no export.
 */
import { describe, expect, test } from 'bun:test';

import { runCli } from './run';
import { fakeIo } from './testing';

const neverStore = (): never => {
  throw new Error('store acquired on a flag-error path');
};

/** Run argv through the real CLI parse and return the rendered stderr. */
async function parseErr(argv: string[]): Promise<string> {
  const io = fakeIo(true);
  const code = await runCli(argv, neverStore, io);
  expect(code).toBe(2);
  return io.err.join('');
}

describe('synthesizeParseError golden pins (MMR-309)', () => {
  describe(String.raw`ERR_PARSE_ARGS_UNKNOWN_OPTION — /^Unknown option '(.+?)'\./`, () => {
    test('unknown long flag: the raw --flag is extracted, not swallowed by the fallback', async () => {
      const err = await parseErr(['list', '--nonexistent-flag']);
      expect(err).toContain("unknown flag '--nonexistent-flag'");
      expect(err).not.toContain('invalid arguments'); // would mean the regex stopped matching
      expect(err).not.toContain('Unknown option'); // library text never ships
    });

    test('unknown short flag: the -x spelling itself is extracted (not canonicalized away)', async () => {
      // -z is not a short alias for any OPTIONS entry.
      const err = await parseErr(['list', '-z']);
      expect(err).toContain("unknown flag '-z'");
      expect(err).not.toContain('invalid arguments');
      expect(err).not.toContain('Unknown option');
    });
  });

  describe(
    String.raw`ERR_PARSE_ARGS_INVALID_OPTION_VALUE — /^Option '(?:-\w, )?(-{1,2}[\w-]+)' does not take an argument/`,
    () => {
      test('boolean flag with no short alias given a value (--ascii=x)', async () => {
        const err = await parseErr(['list', '--ascii=x']);
        expect(err).toContain("'--ascii' doesn't take a value");
        expect(err).not.toContain('invalid arguments');
        expect(err).not.toContain('does not take an argument');
      });

      test(
        'boolean flag WITH a short alias given a value (--yes=true) — Node\'s "-y, --yes" ' +
          'prefix must still resolve to the long flag',
        async () => {
          const err = await parseErr(['list', '--yes=true']);
          expect(err).toContain("'--yes' doesn't take a value");
          expect(err).not.toContain('invalid arguments');
          expect(err).not.toContain('does not take an argument');
        },
      );
    },
  );

  describe(
    String.raw`ERR_PARSE_ARGS_INVALID_OPTION_VALUE — /^Option '(?:-\w, )?(--[\w-]+)(?: <value>)?' argument missing/`,
    () => {
      test('long flag with no short alias, value missing at end of argv (--to)', async () => {
        const err = await parseErr(['list', '--to']);
        expect(err).toContain("'--to' expects a value");
        expect(err).not.toContain('invalid arguments');
        expect(err).not.toContain('argument missing');
      });

      test(
        "flag invoked by its SHORT spelling, value missing at end of argv (-s) — Node's " +
          '"-s, --scope <value>" prefix must resolve to the long flag',
        async () => {
          const err = await parseErr(['list', '-s']);
          expect(err).toContain("'--scope' expects a value");
          expect(err).not.toContain('invalid arguments');
          expect(err).not.toContain('argument missing');
        },
      );
    },
  );

  describe(
    String.raw`ERR_PARSE_ARGS_INVALID_OPTION_VALUE — /^Option '(-{1,2}[\w-]+)' argument is ambiguous/`,
    () => {
      test('long flag followed by a token that looks like a flag (--to --ascii)', async () => {
        const err = await parseErr(['list', '--to', '--ascii']);
        expect(err).toContain("'--to' expects a value");
        expect(err).not.toContain('invalid arguments');
        expect(err).not.toContain('ambiguous');
        expect(err).not.toContain('Did you forget');
      });

      test(
        'short flag followed by a token that looks like a flag (-s --format) — the bare ' +
          '"-s" capture must resolve through canonicalFlag to the long spelling',
        async () => {
          const err = await parseErr(['list', '-s', '--format']);
          expect(err).toContain("'--scope' expects a value");
          expect(err).not.toContain('invalid arguments');
          expect(err).not.toContain('ambiguous');
        },
      );

      test('short flag followed by another short flag (-s -f)', async () => {
        const err = await parseErr(['list', '-s', '-f']);
        expect(err).toContain("'--scope' expects a value");
        expect(err).not.toContain('invalid arguments');
        expect(err).not.toContain('ambiguous');
      });
    },
  );
});
