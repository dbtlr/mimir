import { expect, test } from 'bun:test';

import { versionWindow } from '@mimir/wire/version-window';

import { developmentVersion, VERSION } from './version';

test.each([
  ['0.25.0', '0.26.0-next'],
  ['0.25.3', '0.26.0-next'],
  ['1.4.7', '1.5.0-next'],
])('a source build of release %s reports %s', (released, expected) => {
  expect(developmentVersion(released)).toBe(expected);
});

test.each(['0.26.0-next', '0.26.0-next.42'])(
  'a prerelease the release workflow stamped (%s) is reported unchanged',
  (stamped) => {
    expect(developmentVersion(stamped)).toBe(stamped);
  },
);

test('a package version that is not a version cannot name a development build', () => {
  expect(() => developmentVersion('soon')).toThrow('soon');
});

test('a source CLI is inside the version window of a source host', () => {
  expect(versionWindow(VERSION, VERSION)).toBe('inside');
});
