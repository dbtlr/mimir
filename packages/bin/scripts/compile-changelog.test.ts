import { describe, expect, test } from 'bun:test';

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
