import { describe, expect, it } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { ancestorsOf, subtreeOf } from '../lib/ancestry';

function tn(id: string, type: WireTreeNode['type'], children: WireTreeNode[] = []): WireTreeNode {
  return {
    children,
    created_at: '2026-06-01T10:00:00.000Z',
    id,
    parent: null,
    status: 'ready',
    title: id,
    type,
    updated_at: '2026-06-01T10:00:00.000Z',
  };
}

const tree = tn('MMR', 'project', [
  tn('MMR-1', 'initiative', [tn('MMR-2', 'phase', [tn('MMR-3', 'task')]), tn('MMR-4', 'task')]),
]);

describe('ancestorsOf', () => {
  it('lists the containers above a node, outermost first, without the project', () => {
    expect(ancestorsOf(tree, 'MMR-3')?.map((n) => n.id)).toStrictEqual(['MMR-1', 'MMR-2']);
  });

  it('is empty for a node directly under the project', () => {
    expect(ancestorsOf(tree, 'MMR-1')).toStrictEqual([]);
  });

  it('is undefined for a node the tree does not hold', () => {
    expect(ancestorsOf(tree, 'MMR-99')).toBeUndefined();
  });
});

describe('subtreeOf', () => {
  it('finds a nested container with its children', () => {
    expect(subtreeOf(tree, 'MMR-2')?.children.map((n) => n.id)).toStrictEqual(['MMR-3']);
  });

  it('is the root itself for the project key', () => {
    expect(subtreeOf(tree, 'MMR')).toBe(tree);
  });

  it('is undefined for a node the tree does not hold', () => {
    expect(subtreeOf(tree, 'MMR-99')).toBeUndefined();
  });
});
