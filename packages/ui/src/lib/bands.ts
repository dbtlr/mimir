import type { Distribution, StatusWord } from '@mimir/contract';

import type { WireNode, WireTreeNode } from '../api/types';
import { BOARD_COLUMNS } from './board';
import type { Board, BoardColumn } from './board';

/**
 * The swimlane band model (MMR-221). The board's status lens is re-cut into
 * band rows × status columns: each band groups the project's leaf tasks by a
 * spine (a phase/initiative container, a `release:*` tag, or nothing), and each
 * band carries its own slice of the four swimlane status columns. Grouping is
 * pure and client-side — no new reads; the same board + tree the route already
 * fetched feed it.
 */

/** How the board groups its rows. URL-addressable (`?bands=`); `phase` is default. */
export type BandMode = 'phase' | 'release' | 'off';
export const BAND_MODES: readonly BandMode[] = ['phase', 'release', 'off'];

/**
 * The columns the swimlane grid renders. The held set (parked/blocked/awaiting)
 * moves out of the grid to the HELD ledge, so only these four are columns here.
 */
export const SWIMLANE_COLUMNS = ['ready', 'in_progress', 'under_review', 'done'] as const;
export type SwimlaneColumn = (typeof SWIMLANE_COLUMNS)[number];

/** The rankable swimlane columns — drag-to-reorder lives here (ADR 0007, per status). */
export const SWIMLANE_RANKABLE: readonly SwimlaneColumn[] = ['ready', 'in_progress'];

/**
 * A band's per-status card slices. Every {@link BoardColumn} is bucketed (not
 * just the four swimlane columns): the desktop grid reads only the swimlane
 * four, while the mobile board's single-status paging (MMR-224) needs the held
 * three (parked/blocked/awaiting) grouped by band the same way. Pure re-bucketing
 * of the board already fetched — no new reads.
 */
export type BandColumns = Record<BoardColumn, WireNode[]>;

export type Band = {
  /** Stable identity for keys/tests (container id, `release:<v>`, or a sentinel). */
  key: string;
  /** Spine display name — container title, release value, or empty (off mode). */
  name: string;
  /** Backing tree container (phase/initiative) — absent for release/off/untagged bands. */
  node?: WireTreeNode;
  /** Open-ended container: append `∞`, kind reads `standing`, caption replaces the bar. */
  openEnded: boolean;
  /** De-emphasize the spine name to `--color-ink-faint` — the `No release` bucket (§8.3). */
  muted?: boolean;
  /** The mini-bar source — the container rollup (phase) or computed over the band's leaves. */
  distribution: Distribution;
  columns: BandColumns;
};

function emptyColumns(): BandColumns {
  return {
    awaiting: [],
    blocked: [],
    done: [],
    in_progress: [],
    parked: [],
    ready: [],
    under_review: [],
  };
}

function bandLeaves(columns: BandColumns): WireNode[] {
  return BOARD_COLUMNS.flatMap((column) => columns[column]);
}

/** Tally a set of leaves into a status distribution — the fallback mini-bar source. */
function distributionOf(nodes: readonly WireNode[]): Distribution {
  const dist: Partial<Record<StatusWord, number>> = {};
  for (const node of nodes) {
    dist[node.status] = (dist[node.status] ?? 0) + 1;
  }
  return dist;
}

/** The single flat band — off mode, or phase mode with no tree to group by. */
function flatBand(board: Board): Band {
  const columns: BandColumns = { ...board };
  return {
    columns,
    distribution: distributionOf(bandLeaves(columns)),
    key: '__all__',
    name: '',
    openEnded: false,
  };
}

/**
 * Map every leaf id → its band container: the nearest ancestor phase, else the
 * nearest ancestor initiative (a leaf directly under an initiative bands on the
 * initiative). A leaf with neither on its path falls back to the project root.
 */
function phaseBandMap(root: WireTreeNode): Map<string, WireTreeNode> {
  const map = new Map<string, WireTreeNode>();
  const walk = (node: WireTreeNode, band: WireTreeNode | undefined): void => {
    // A phase overrides an initiative already seen; an initiative sets the band
    // when nothing nearer has. Tasks inherit whatever the descent carried down.
    const next = node.type === 'phase' || node.type === 'initiative' ? node : band;
    if (node.type === 'task') {
      map.set(node.id, next ?? root);
    }
    for (const child of node.children) {
      walk(child, next);
    }
  };
  walk(root, undefined);
  return map;
}

/** Pre-order position of every node — the canonical band ordering key. */
function preorderIndex(root: WireTreeNode): Map<string, number> {
  const order = new Map<string, number>();
  let i = 0;
  const walk = (node: WireTreeNode): void => {
    order.set(node.id, i);
    i += 1;
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return order;
}

/** Phase mode — group by nearest phase-or-initiative ancestor, ordered by the tree. */
function phaseBands(board: Board, tree: WireTreeNode): Band[] {
  const bandOf = phaseBandMap(tree);
  const order = preorderIndex(tree);
  const byBand = new Map<string, { node: WireTreeNode; columns: BandColumns }>();
  for (const column of BOARD_COLUMNS) {
    for (const node of board[column]) {
      const container = bandOf.get(node.id) ?? tree;
      let entry = byBand.get(container.id);
      if (entry === undefined) {
        entry = { columns: emptyColumns(), node: container };
        byBand.set(container.id, entry);
      }
      entry.columns[column].push(node);
    }
  }
  return [...byBand.values()]
    .map(({ node, columns }): Band => {
      const openEnded = node.open_ended === true;
      return {
        columns,
        distribution: node.distribution ?? distributionOf(bandLeaves(columns)),
        key: node.id,
        name: node.title,
        node,
        openEnded,
      };
    })
    .toSorted((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

/** The first `release:*` tag's value, or undefined when a leaf carries none. */
function releaseOf(node: WireNode): string | undefined {
  const tag = (node.tags ?? []).find((t) => t.tag.startsWith('release:'));
  return tag === undefined ? undefined : tag.tag.slice('release:'.length);
}

/** Release mode — group by `release:*` tag; untagged leaves trail in `No release`. */
function releaseBands(board: Board): Band[] {
  const order: string[] = [];
  const byRelease = new Map<string, BandColumns>();
  const untagged = emptyColumns();
  let hasUntagged = false;
  for (const column of BOARD_COLUMNS) {
    for (const node of board[column]) {
      const release = releaseOf(node);
      if (release === undefined || release === '') {
        untagged[column].push(node);
        hasUntagged = true;
        continue;
      }
      let columns = byRelease.get(release);
      if (columns === undefined) {
        columns = emptyColumns();
        byRelease.set(release, columns);
        order.push(release);
      }
      columns[column].push(node);
    }
  }
  const bands: Band[] = order.map((release) => {
    const columns = byRelease.get(release) ?? emptyColumns();
    return {
      columns,
      distribution: distributionOf(bandLeaves(columns)),
      key: `release:${release}`,
      name: release,
      openEnded: false,
    };
  });
  if (hasUntagged) {
    bands.push({
      columns: untagged,
      distribution: distributionOf(bandLeaves(untagged)),
      key: '__no_release__',
      muted: true,
      name: 'No release',
      openEnded: false,
    });
  }
  return bands;
}

/**
 * Cut the board into swimlane bands for the chosen mode. Phase mode needs the
 * project tree for ancestry; without it (a degraded tree read) it falls back to
 * the single flat band so the board still renders every card.
 */
export function buildBands(board: Board, mode: BandMode, tree?: WireTreeNode): Band[] {
  if (mode === 'release') {
    return releaseBands(board);
  }
  if (mode === 'phase' && tree !== undefined) {
    return phaseBands(board, tree);
  }
  // Off mode, or phase mode with no tree to group by — one flat band.
  return [flatBand(board)];
}
