import { expect, test } from 'bun:test';

import {
  addFrontmatter,
  appendToSection,
  createDocument,
  MIGRATION_PLAN_SCHEMA_VERSION,
  migrationPlan,
  replaceBody,
  removeFrontmatter,
  setFrontmatter,
} from './plan';

test('setFrontmatter nests {path, field, new_value} under fields, no CAS by default', () => {
  expect(setFrontmatter('MMR/MMR-1.md', 'lifecycle', 'in_progress')).toEqual({
    fields: { field: 'lifecycle', new_value: 'in_progress', path: 'MMR/MMR-1.md' },
    kind: 'set_frontmatter',
  });
});

test('setFrontmatter carries expected_old_value when a precondition is given', () => {
  expect(setFrontmatter('MMR/MMR-1.md', 'lifecycle', 'done', 'in_progress')).toEqual({
    fields: {
      expected_old_value: 'in_progress',
      field: 'lifecycle',
      new_value: 'done',
      path: 'MMR/MMR-1.md',
    },
    kind: 'set_frontmatter',
  });
});

test('setFrontmatter treats an explicit null precondition as "expected absent"', () => {
  const op = setFrontmatter('MMR/MMR-1.md', 'hold', 'blocked', null);
  expect(op.fields.expected_old_value).toBeNull();
});

test('addFrontmatter nests {path, field, new_value} under fields', () => {
  expect(addFrontmatter('MMR/MMR-1.md', 'kind', 'task')).toEqual({
    fields: { field: 'kind', new_value: 'task', path: 'MMR/MMR-1.md' },
    kind: 'add_frontmatter',
  });
});

test('removeFrontmatter nests {path, field} under fields', () => {
  expect(removeFrontmatter('MMR/MMR-1.md', 'target')).toEqual({
    fields: { field: 'target', path: 'MMR/MMR-1.md' },
    kind: 'remove_frontmatter',
  });
});

test('appendToSection nests {path, heading, content} under fields', () => {
  expect(appendToSection('MMR/MMR-1.md', 'History', '### x — lifecycle\ntodo → done\n')).toEqual({
    fields: {
      content: '### x — lifecycle\ntodo → done\n',
      heading: 'History',
      path: 'MMR/MMR-1.md',
    },
    kind: 'append_to_section',
  });
});

test('createDocument nests the payload under new_value.{frontmatter, body}', () => {
  expect(createDocument('MMR/MMR-1.md', { title: 'Do it', type: 'task' }, '# Do it\n')).toEqual({
    fields: {
      new_value: { body: '# Do it\n', frontmatter: { title: 'Do it', type: 'task' } },
      path: 'MMR/MMR-1.md',
    },
    kind: 'create_document',
  });
});

test('replaceBody carries a whole-document hash CAS precondition', () => {
  expect(replaceBody('MMR/MMR-1.md', 'blake3', 'canonical\n')).toEqual({
    fields: {
      document_hash: 'blake3',
      new_value: 'canonical\n',
      path: 'MMR/MMR-1.md',
    },
    kind: 'replace_body',
  });
});

test('migrationPlan stamps schema_version 1 and the vault root', () => {
  const op = setFrontmatter('MMR/MMR-1.md', 'lifecycle', 'done');
  expect(migrationPlan({ operations: [op], vaultRoot: '/vault' })).toEqual({
    operations: [op],
    schema_version: 1,
    vault_root: '/vault',
  });
  expect(MIGRATION_PLAN_SCHEMA_VERSION).toBe(1);
});

test('migrationPlan carries optional generator/generated_at only when supplied', () => {
  const plan = migrationPlan({
    generatedAt: '2026-07-03T00:00:00.000Z',
    generator: 'mimir',
    operations: [],
    vaultRoot: '/vault',
  });
  expect(plan.generator).toBe('mimir');
  expect(plan.generated_at).toBe('2026-07-03T00:00:00.000Z');

  const bare = migrationPlan({ operations: [], vaultRoot: '/vault' });
  expect('generator' in bare).toBe(false);
  expect('generated_at' in bare).toBe(false);
});
