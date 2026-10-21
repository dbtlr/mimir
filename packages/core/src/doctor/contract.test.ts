import { expect, test } from 'bun:test';

import type { DoctorFinding } from './contract';
import { findingLine } from './contract';

const FINDING: DoctorFinding = {
  check: 'config-permissions',
  code: 'config-readable',
  evidence: { mode: '0644' },
  locator: '/config/mimir/config.toml',
  message: 'the config file is readable by group or others',
  node: 'config',
  scopeKey: 'store',
  severity: 'warn',
  stem: 'config',
  where: 'config · mode',
};

test('findingLine prints a remedy on an indented fix line', () => {
  expect(findingLine({ ...FINDING, remedy: "run 'chmod 600 /config/mimir/config.toml'" })).toBe(
    '[warn] config: the config file is readable by group or others (config · mode)\n' +
      "  fix: run 'chmod 600 /config/mimir/config.toml'",
  );
});

test('findingLine keeps a finding without a remedy on one line', () => {
  expect(findingLine({ ...FINDING, severity: 'error' })).toBe(
    '[err] config: the config file is readable by group or others (config · mode)',
  );
});
