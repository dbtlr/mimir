import { describe, expect, test } from 'bun:test';

import type { NodeView, SetResult } from '@mimir/contract';
import { parseJson } from '@mimir/helpers';

import {
  formatIds,
  formatNodeJson,
  formatSetJson,
  formatSetJsonl,
  formatStatusJson,
} from './format';

const task = (id: string, over: Partial<NodeView> = {}): NodeView => ({
  completedAt: null,
  createdAt: '2026-06-05T00:00:00.000Z',
  description: null,
  externalRef: null,
  hold: 'none',
  holdReason: null,
  id,
  lifecycle: 'todo',
  parent: 'MMR-1',
  priority: 'p1',
  size: null,
  status: 'ready',
  title: `title ${id}`,
  type: 'task',
  updatedAt: '2026-06-05T00:00:00.000Z',
  ...over,
});

const set = (items: NodeView[]): SetResult<NodeView> => ({
  items,
  returned: items.length,
  startsAt: 0,
  total: items.length,
});

describe('formatIds', () => {
  test('one id per line', () => {
    expect(formatIds([task('MMR-2'), task('MMR-3')])).toBe('MMR-2\nMMR-3');
    expect(formatIds([])).toBe('');
  });
});

describe('formatSetJson', () => {
  test('count-led envelope with the unit key and snake_case fields', () => {
    const parsed = parseJson<{
      total: number;
      returned: number;
      starts_at: number;
      tasks: { id: string; hold_reason: string }[];
    }>(formatSetJson(set([task('MMR-2', { holdReason: 'x' })])));
    expect(parsed.total).toBe(1);
    expect(parsed.starts_at).toBe(0);
    expect(parsed.tasks[0]?.id).toBe('MMR-2');
    expect(parsed.tasks[0]?.hold_reason).toBe('x'); // camelCase DTO -> snake_case wire
  });

  test('unit key is configurable', () => {
    const parsed = parseJson<Record<string, unknown>>(formatSetJson(set([]), 'nodes'));
    expect(parsed.nodes).toEqual([]);
  });
});

describe('formatSetJsonl', () => {
  test('one object per line, no wrapper', () => {
    const lines = formatSetJsonl([task('MMR-2'), task('MMR-3')]).split('\n');
    expect(lines).toHaveLength(2);
    expect(parseJson<{ id: string }>(lines[0] ?? '{}').id).toBe('MMR-2');
  });
});

describe('formatNodeJson', () => {
  test('bare object (no set wrapper), only defined fields', () => {
    const parsed = parseJson<Record<string, unknown>>(
      formatNodeJson(task('MMR-2', { externalRef: 'gh#9' })),
    );
    expect(parsed.id).toBe('MMR-2');
    expect(parsed.external_ref).toBe('gh#9');
    expect('total' in parsed).toBe(false);
  });

  test('phase omits task-only fields, includes target', () => {
    const phase: NodeView = {
      createdAt: '2026-06-05T00:00:00.000Z',
      description: null,
      id: 'MMR-1',
      parent: null,
      status: 'ready',
      target: 'ship',
      title: 'ph',
      type: 'phase',
      updatedAt: '2026-06-05T00:00:00.000Z',
    };
    const parsed = parseJson<Record<string, unknown>>(formatNodeJson(phase));
    expect(parsed.target).toBe('ship');
    expect('priority' in parsed).toBe(false);
    expect('hold' in parsed).toBe(false);
  });
});

describe('formatStatusJson', () => {
  test('id, status, and distribution', () => {
    const parsed = parseJson<{ id: string; status: string; distribution: Record<string, number> }>(
      formatStatusJson({
        distribution: { in_progress: 1, ready: 2 },
        id: 'MMR-1',
        status: 'in_progress',
        type: 'phase',
      }),
    );
    expect(parsed.status).toBe('in_progress');
    expect(parsed.distribution).toEqual({ in_progress: 1, ready: 2 });
  });
});
