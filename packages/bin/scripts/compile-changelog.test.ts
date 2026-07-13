import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { insertSection, parseFragment, renderSection } from './compile-changelog';

const FRAGMENT = `### Added

- **Thing one** (MMR-1). A bullet with a
  continuation line.
- **Thing two** (MMR-2). Single line.

### Fixed

- **A fix** (MMR-3). Done.
`;

describe('parseFragment', () => {
  test('parses categories and keeps bullet blocks verbatim', () => {
    const sections = parseFragment('f.md', FRAGMENT);
    expect(sections.Added).toEqual([
      '- **Thing one** (MMR-1). A bullet with a\n  continuation line.',
      '- **Thing two** (MMR-2). Single line.',
    ]);
    expect(sections.Fixed).toEqual(['- **A fix** (MMR-3). Done.']);
  });

  test('rejects an unknown category heading', () => {
    expect(() => parseFragment('f.md', '### Improved\n\n- x\n')).toThrow(
      'f.md:1: unknown category "Improved"',
    );
  });

  test('rejects non-H3 headings', () => {
    expect(() => parseFragment('f.md', '## Added\n\n- x\n')).toThrow('only H3 category headings');
  });

  test('rejects a bullet outside a category', () => {
    expect(() => parseFragment('f.md', '- stray\n')).toThrow('bullet outside a category heading');
  });

  test('rejects prose outside a bullet', () => {
    expect(() => parseFragment('f.md', '### Added\n\nsome prose\n')).toThrow(
      'prose outside a bullet',
    );
  });

  test('rejects an empty fragment', () => {
    expect(() => parseFragment('f.md', '### Added\n')).toThrow('fragment has no entries');
  });
});

describe('renderSection', () => {
  test('renders categories in canonical order, fragments in given order', () => {
    const first = parseFragment('a.md', '### Fixed\n\n- fix from a.\n');
    const second = parseFragment(
      'b.md',
      '### Added\n\n- add from b.\n\n### Fixed\n\n- fix from b.\n',
    );
    expect(renderSection('0.14.0', '2026-07-13', [first, second])).toBe(
      [
        '## v0.14.0 - 2026-07-13',
        '',
        '### Added',
        '',
        '- add from b.',
        '',
        '### Fixed',
        '',
        '- fix from a.',
        '- fix from b.',
        '',
      ].join('\n'),
    );
  });
});

describe('insertSection', () => {
  test('inserts above the first release heading, after header prose', () => {
    const changelog = '# Changelog\n\nHeader prose.\n\n## v0.13.0 - 2026-07-12\n\n- old.\n';
    const result = insertSection(changelog, '## v0.14.0 - 2026-07-13\n\n- new.\n');
    expect(result).toBe(
      '# Changelog\n\nHeader prose.\n\n## v0.14.0 - 2026-07-13\n\n- new.\n\n## v0.13.0 - 2026-07-12\n\n- old.\n',
    );
  });

  test('appends when no release section exists yet', () => {
    expect(insertSection('# Changelog\n\nProse.\n', '## v0.1.0 - 2026-01-01\n\n- first.\n')).toBe(
      '# Changelog\n\nProse.\n\n## v0.1.0 - 2026-01-01\n\n- first.\n',
    );
  });
});

// CLI integration — the parts the pure functions can't pin: git landing order,
// README exclusion, fragment deletion, and flag validation.
const SCRIPT = new URL('compile-changelog.ts', import.meta.url).pathname;

const run = (cwd: string, args: string[]) => {
  const result = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const commit = (cwd: string, message: string, date: string) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-qm', message], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
};

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-cut-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    '# Changelog\n\nProse.\n\n## v0.1.0 - 2026-01-01\n\n### Added\n\n- old.\n',
  );
  mkdirSync(join(dir, '.changes'));
  writeFileSync(join(dir, '.changes', 'README.md'), '# fragments\n');
  return dir;
};

describe('cli', () => {
  test('--write compiles in landing order, deletes fragments, keeps README', () => {
    const dir = makeRepo();
    // zz-* lands FIRST, aa-* lands SECOND — compiled order must follow git
    // history, not the alphabet.
    writeFileSync(join(dir, '.changes', 'zz-first.md'), '### Fixed\n\n- landed first.\n');
    commit(dir, 'one', '2026-01-02T00:00:00Z');
    writeFileSync(join(dir, '.changes', 'aa-second.md'), '### Fixed\n\n- landed second.\n');
    commit(dir, 'two', '2026-02-02T00:00:00Z');

    const result = run(dir, ['--write', '--version', '0.2.0']);
    expect(result.exitCode).toBe(0);

    const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog.indexOf('## v0.2.0 - ')).toBeGreaterThan(-1);
    expect(changelog.indexOf('## v0.2.0 - ')).toBeLessThan(changelog.indexOf('## v0.1.0'));
    expect(changelog.indexOf('landed first.')).toBeLessThan(changelog.indexOf('landed second.'));
    expect(existsSync(join(dir, '.changes', 'zz-first.md'))).toBe(false);
    expect(existsSync(join(dir, '.changes', 'aa-second.md'))).toBe(false);
    expect(existsSync(join(dir, '.changes', 'README.md'))).toBe(true);
  });

  test('--write refuses a missing or malformed --version', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, '.changes', 'mmr-1.md'), '### Added\n\n- a thing.\n');
    commit(dir, 'one', '2026-01-02T00:00:00Z');

    expect(run(dir, ['--write']).exitCode).toBe(1);
    expect(run(dir, ['--write', '--version', 'v0.2.0']).stderr).toContain('--version X.Y.Z');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).not.toContain('a thing.');
  });

  test('--check passes a valid fragment and fails a malformed one with its location', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, '.changes', 'good.md'), '### Added\n\n- fine.\n');
    writeFileSync(join(dir, '.changes', 'bad.md'), '### Added\n\nprose, not a bullet\n');

    const good = run(dir, ['--check', '.changes/good.md']);
    expect(good.exitCode).toBe(0);
    expect(good.stdout).toContain('ok: 1 fragment(s) parse');

    const bad = run(dir, ['--check', '.changes/good.md', '.changes/bad.md']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('.changes/bad.md:3: prose outside a bullet');
  });
});
