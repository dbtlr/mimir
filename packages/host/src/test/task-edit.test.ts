import { MimirError } from '@mimir/contract';
import { describe, expect, it } from 'vitest';

import {
  editWrites,
  saveReport,
  saveWaits,
  settle,
  summaryError,
  taskDraft,
  writeError,
} from '../lib/task-edit';
import type { TaskDraft } from '../lib/task-edit';
import { engineTag, engineTask } from './node-fixtures';

const stamp = '2026-06-01T00:00:00.000Z';

const task = engineTask({
  description: 'Old prose.',
  externalRef: 'GH-12',
  grooming: 'not_groomed',
  id: 'MMR-40',
  parent: 'MMR-2',
  priority: 'p2',
  size: 'small',
  status: 'ready',
  summary: 'A short lede.',
  tags: [engineTag('ui', stamp), engineTag('feed', stamp)],
  title: 'Edit sheet',
});

const baseline = taskDraft(task);
const edit = (change: Partial<TaskDraft>): TaskDraft => ({ ...baseline, ...change });

describe('editWrites', () => {
  it('sends nothing when nothing changed', () => {
    expect(editWrites(baseline, baseline)).toStrictEqual([]);
  });

  it('sends only the content fields that changed, in one update', () => {
    expect(
      editWrites(baseline, edit({ size: 'large', title: '  Edit sheet, renamed ' })),
    ).toStrictEqual([
      {
        fields: { size: 'large', title: 'Edit sheet, renamed' },
        kind: 'content',
        touched: ['title', 'size'],
      },
    ]);
  });

  it('clears an emptied summary, external ref, size, or priority with null', () => {
    const [write] = editWrites(
      baseline,
      edit({ externalRef: ' ', priority: null, size: null, summary: '' }),
    );
    expect(write).toMatchObject({
      fields: { externalRef: null, priority: null, size: null, summary: null },
      kind: 'content',
    });
  });

  it('sends an emptied description as null, and leaves an untouched blank one out', () => {
    expect(editWrites(baseline, edit({ description: '' }))).toMatchObject([
      { fields: { description: null } },
    ]);
    const blank = taskDraft(engineTask({ description: null, status: 'ready' }));
    expect(editWrites(blank, { ...blank, description: '  ' })).toStrictEqual([]);
  });

  it('diffs the tags against the snapshot: adds the new, removes the dropped, never re-tags a kept one', () => {
    expect(editWrites(baseline, edit({ tags: ['ui', 'fresh'] }))).toStrictEqual([
      { kind: 'tag', name: 'fresh' },
      { kind: 'untag', name: 'feed' },
    ]);
  });

  it('moves the task when its parent changed', () => {
    expect(editWrites(baseline, edit({ parent: 'MMR-1' }))).toStrictEqual([
      { kind: 'move', to: 'MMR-1' },
    ]);
  });

  it('sets grooming when it changed, with the open questions as its note only for needs answers', () => {
    expect(editWrites(baseline, edit({ grooming: 'groomed', groomingPicked: true }))).toStrictEqual(
      [{ kind: 'groom', state: 'groomed' }],
    );
    expect(
      editWrites(
        baseline,
        edit({ grooming: 'needs_answers', groomingPicked: true, questions: ' Which store? ' }),
      ),
    ).toStrictEqual([{ kind: 'groom', note: 'Which store?', state: 'needs_answers' }]);
  });

  it('asks again when a task already needing answers is changed away and back', () => {
    const asking = taskDraft({ ...task, grooming: 'needs_answers' });
    expect(editWrites(asking, asking)).toStrictEqual([]);
    expect(
      editWrites(asking, {
        ...asking,
        grooming: 'needs_answers',
        groomingPicked: true,
        questions: 'Still open?',
      }),
    ).toStrictEqual([{ kind: 'groom', note: 'Still open?', state: 'needs_answers' }]);
  });

  it('holds no grooming for a task that has started', () => {
    const started = taskDraft({ ...task, lifecycle: 'in_progress', status: 'in_progress' });
    expect(started.grooming).toBeNull();
  });
});

describe('summaryError and saveWaits', () => {
  it('holds Save on a summary past the Engine’s 256 characters, counted as it stores them', () => {
    expect(summaryError(edit({ summary: `  ${'x'.repeat(256)}  ` }))).toBeUndefined();
    expect(saveWaits(edit({ summary: 'x'.repeat(256) }))).toBe(false);
    expect(summaryError(edit({ summary: 'x'.repeat(257) }))).toBe(
      'Summary must be 256 characters or fewer',
    );
    expect(saveWaits(edit({ summary: 'x'.repeat(257) }))).toBe(true);
  });
});

describe('settle', () => {
  it('takes what saved into the baseline, so a second save sends only what failed', () => {
    const draft = edit({ parent: 'MMR-1', size: 'large', tags: ['ui', 'feed', 'fresh'] });
    const [content, tagged, moved] = editWrites(baseline, draft);
    const next = settle(baseline, draft, [content!, tagged!]);
    expect(editWrites(next, draft)).toStrictEqual([moved]);
  });
});

describe('writeError and saveReport', () => {
  it('names the failed write and how to retry it, on the field it belongs to', () => {
    expect(
      writeError({ kind: 'move', to: 'MMR-1' }, new Error("the host didn't answer.")),
    ).toStrictEqual({
      field: 'parent',
      message: "Not moved: the host didn't answer. Save again to move it.",
    });
    expect(
      writeError(
        { fields: { summary: 'x', title: 'y' }, kind: 'content', touched: ['title', 'summary'] },
        new Error('refused'),
      ),
    ).toStrictEqual({ field: 'title', message: 'Not saved: refused. Save again to save it.' });
  });

  it('puts an Engine refusal under the field it names, with no Save again', () => {
    const content = {
      fields: { summary: 'x', title: 'y' },
      kind: 'content',
      touched: ['title', 'summary'],
    } as const;
    expect(
      writeError(
        content,
        new MimirError('validation', 'summary must be 256 characters or fewer (got 300)'),
      ),
    ).toStrictEqual({
      field: 'summary',
      message: 'Not saved: summary must be 256 characters or fewer (got 300).',
    });
    expect(
      writeError(
        { kind: 'move', to: 'MMR-1' },
        new MimirError('validation', 'a task cannot move under a project'),
      ),
    ).toStrictEqual({ field: 'parent', message: 'Not moved: a task cannot move under a project.' });
  });

  it('says what saved and what did not', () => {
    const size = { fields: { size: 'medium' }, kind: 'content', touched: ['size'] } as const;
    expect(saveReport([size, { kind: 'tag', name: 'ui' }], [{ kind: 'move', to: 'MMR-1' }])).toBe(
      "Size and tags saved. The move didn't.",
    );
    expect(saveReport([], [{ kind: 'groom', state: 'groomed' }])).toBe('Nothing saved.');
  });
});
