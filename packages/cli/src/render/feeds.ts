/**
 * The styled views of the non-node sets: the artifact feed, cross-record
 * search, the seed queue, and the scratchpad list, ported from the old CLI's
 * renderer. Layout is evolvable and never parsed (ADR 0009); the parity
 * harness holds it to the old CLI's bytes.
 */
import { seedLane } from '@mimir/contract';
import type { ArtifactSummary, SearchHit, SeedView, SetResult } from '@mimir/contract';
import { relativeTime } from '@mimir/helpers';

import { bold, color, countLine, dimmed, pad } from './presentation';
import type { Layout, Presentation } from './presentation';

/** The indented, dimmed second line a row carries for its preview text. */
const preview = (text: string, p: Presentation): string => dimmed(`      ${text}`, p.plain);

/**
 * One artifact feed row: id, title, tags, age, with the summary dimmed beneath
 * it. Titles and tags are free text, so the columns pad by terminal cell.
 */
function artifactRows(items: readonly ArtifactSummary[], p: Layout): string[] {
  const idW = Math.max(...items.map((a) => p.width(a.id)));
  const titleW = Math.max(...items.map((a) => p.width(a.title)));
  const tagW = Math.max(...items.map((a) => p.width(a.tags.join(', '))));
  const now = Date.now();
  return items.map((a) => {
    const head = [
      pad(a.id, idW, p.width),
      pad(a.title, titleW, p.width),
      pad(a.tags.join(', '), tagW, p.width),
      relativeTime(a.createdAt, now),
    ].join('   ');
    return a.summary === undefined || a.summary === '' ? head : `${head}\n${preview(a.summary, p)}`;
  });
}

/** `table` and `records` of the artifact feed: count-led, then one row each. */
export function renderArtifactFeed(result: SetResult<ArtifactSummary>, p: Layout): string {
  const lines = [countLine(result.total, 'artifact')];
  if (result.items.length > 0) {
    lines.push('', ...artifactRows(result.items, p));
  }
  return lines.join('\n');
}

/** How a search hit matched, as its row shows it: a link hit's relation, else the match. */
const searchMarker = (h: SearchHit): string =>
  h.match === 'link' && h.link !== undefined ? h.link : h.match;

/**
 * One search hit row: id, kind, how it matched, title, with a description
 * hit's snippet dimmed beneath. The padded columns are ASCII by construction,
 * so they pad by length; the title comes last.
 */
function searchRows(items: readonly SearchHit[], p: Presentation): string[] {
  const idW = Math.max(...items.map((h) => h.id.length));
  const kindW = Math.max(...items.map((h) => h.kind.length));
  const markerW = Math.max(...items.map((h) => searchMarker(h).length));
  return items.map((h) => {
    const head = [
      h.id.padEnd(idW),
      h.kind.padEnd(kindW),
      searchMarker(h).padEnd(markerW),
      h.title,
    ].join('   ');
    return h.snippet === undefined || h.snippet === '' ? head : `${head}\n${preview(h.snippet, p)}`;
  });
}

/** `table` and `records` of cross-record search: count-led, then one row per hit. */
export function renderSearchSet(result: SetResult<SearchHit>, p: Presentation): string {
  const lines = [countLine(result.total, 'result')];
  if (result.items.length > 0) {
    lines.push('', ...searchRows(result.items, p));
  }
  return lines.join('\n');
}

/**
 * One seed queue row: kind, lifecycle, requester, age, id, title, with the
 * lede dimmed beneath. The padded columns are ASCII by construction (the
 * requester is a project key), so they pad by length; the title comes last.
 */
export function seedRows(seeds: readonly SeedView[], p: Presentation): string[] {
  const kindW = Math.max(...seeds.map((s) => s.kind.length));
  const lifeW = Math.max(...seeds.map((s) => s.lifecycle.length));
  const reqW = Math.max(...seeds.map((s) => (s.requester ?? '-').length));
  const idW = Math.max(...seeds.map((s) => s.id.length));
  const now = Date.now();
  const ages = seeds.map((s) => relativeTime(s.createdAt, now));
  const ageW = Math.max(...ages.map((age) => age.length));
  const readyGlyph = p.plain ? ' *' : ` ${color('●', 32, false)}`;
  return seeds.map((s, i) => {
    const ready = s.readyToResolve ? readyGlyph : '';
    const head = `${s.kind.padEnd(kindW)}   ${s.lifecycle.padEnd(lifeW)}   ${(s.requester ?? '-').padEnd(reqW)}   ${(ages[i] ?? '').padEnd(ageW)}   ${s.id.padEnd(idW)}   ${s.title}${ready}`;
    return s.lede == null || s.lede === '' ? head : `${head}\n${preview(s.lede, p)}`;
  });
}

/** `table` of the seed queue: the flat, count-led queue, oldest-first as the caller ordered it. */
export function renderSeedQueue(
  seeds: readonly SeedView[],
  p: Presentation,
  emptyMessage: string,
): string {
  const lines = [countLine(seeds.length, 'seed')];
  if (seeds.length === 0) {
    if (p.isTTY) {
      lines.push('', emptyMessage);
    }
    return lines.join('\n');
  }
  lines.push('', ...seedRows(seeds, p));
  return lines.join('\n');
}

/**
 * The `--grouped` lane view: untriaged, ready to resolve, and settled always,
 * with promoted and parked only when populated, so no seed is dropped.
 */
export function renderSeedLanes(seeds: readonly SeedView[], p: Presentation): string {
  const inLane = (lane: string): SeedView[] => seeds.filter((s) => seedLane(s) === lane);
  const lanes: [string, SeedView[]][] = [
    ['untriaged', inLane('untriaged')],
    ['ready to resolve', inLane('ready')],
    ['promoted', inLane('promoted')],
    ['parked', inLane('parked')],
    ['settled', inLane('settled')],
  ];
  const out: string[] = [countLine(seeds.length, 'seed')];
  for (const [label, lane] of lanes) {
    if ((label === 'promoted' || label === 'parked') && lane.length === 0) {
      continue;
    }
    out.push('', bold(`${label} (${String(lane.length)})`, p.plain));
    if (lane.length > 0) {
      out.push(...seedRows(lane, p));
    }
  }
  return out.join('\n');
}
