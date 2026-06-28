import { describe, expect, test } from 'vitest';

import { taskFormSchema, emptyTaskForm } from '../lib/schemas';

describe('taskFormSchema', () => {
  it('requires a non-blank title', () => {
    const r = taskFormSchema.safeParse({ ...emptyTaskForm, title: '   ' });
    expect(r.success).toBe(false);
  });

  it('accepts a title-only task and normalizes empty optionals to null', () => {
    const r = taskFormSchema.safeParse({ ...emptyTaskForm, title: 'do the thing' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.priority).toBeNull();
      expect(r.data.size).toBeNull();
      expect(r.data.description).toBeNull();
      expect(r.data.external_ref).toBeNull();
    }
  });

  it('rejects an out-of-enum priority', () => {
    const r = taskFormSchema.safeParse({ ...emptyTaskForm, title: 'x', priority: 'p9' });
    expect(r.success).toBe(false);
  });

  it('keeps a valid priority/size', () => {
    const r = taskFormSchema.safeParse({
      ...emptyTaskForm,
      title: 'x',
      priority: 'p1',
      size: 'small',
    });
    expect(r.success && r.data.priority).toBe('p1');
  });
});
