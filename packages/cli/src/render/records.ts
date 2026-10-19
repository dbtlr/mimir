/**
 * The styled artifact and seed views `get KEY-aN` and `get KEY-sN` render,
 * ported from the old CLI's renderer.
 */
import type { ArtifactDetail, SeedView } from '@mimir/contract';
import { formatDay, formatInstant } from '@mimir/helpers';

import { recordRow } from './node';
import { bold, countLine } from './presentation';
import type { Presentation } from './presentation';

/** An artifact's one-row `table`. */
export function renderArtifactTable(artifact: ArtifactDetail, p: Presentation): string {
  const tags = artifact.tags.length > 0 ? `   ${artifact.tags.join(', ')}` : '';
  return [
    countLine(1, 'artifact'),
    '',
    `${artifact.id}   ${artifact.title}${tags}   ${formatDay(artifact.createdAt, p.zone)}`,
  ].join('\n');
}

/** An artifact's `records`: metadata rows, then the frozen body when it was read. */
export function renderArtifactRecords(artifact: ArtifactDetail, p: Presentation): string {
  const pairs: [string, string][] = [['title', artifact.title]];
  if (artifact.summary !== undefined) {
    pairs.push(['summary', artifact.summary]);
  }
  pairs.push(['project', artifact.project]);
  if (artifact.links.length > 0) {
    pairs.push(['links', artifact.links.join(', ')]);
  }
  if (artifact.tags.length > 0) {
    pairs.push(['tags', artifact.tags.join(', ')]);
  }
  pairs.push(['created', formatInstant(artifact.createdAt, p.zone)]);
  const labelW = Math.max(...pairs.map(([label]) => label.length));
  const lines = [bold(artifact.id, p.plain), ...pairs.map(([l, v]) => recordRow(l, v, labelW))];
  if (artifact.content !== undefined) {
    lines.push('', artifact.content);
  }
  return lines.join('\n');
}

/** A seed's `records`, which its `table` renders too: verb-owned relations show only when set. */
export function renderSeedRecords(seed: SeedView, p: Presentation): string {
  const pairs: [string, string][] = [
    ['project', seed.project],
    ['title', seed.title],
    ['kind', seed.kind],
    ['lifecycle', seed.lifecycle],
  ];
  if (seed.requester !== null) {
    pairs.push(['requester', seed.requester]);
  }
  if (seed.spawned.length > 0) {
    pairs.push(['spawned', seed.spawned.join(', ')]);
  }
  if (seed.readyToResolve) {
    pairs.push(['ready', 'ready to resolve']);
  }
  if (seed.description != null && seed.description !== '') {
    pairs.push(['description', seed.description]);
  }
  pairs.push(['created', formatInstant(seed.createdAt, p.zone)]);
  const labelW = Math.max(...pairs.map(([label]) => label.length));
  return [bold(seed.id, p.plain), ...pairs.map(([l, v]) => recordRow(l, v, labelW))].join('\n');
}
