import type {
  AgendaItemState,
  ScratchpadAgendaItem,
  ScratchpadBody,
  ScratchpadJournalEntry,
} from '@mimir/contract';

import { isCanonicalInstant } from '../time';

export const SCRATCHPAD_JOURNAL_HEADING = 'Journal';
export const SCRATCHPAD_AGENDA_HEADING = 'Agenda';

const MARK: Record<AgendaItemState, string> = { done: 'x', open: ' ', superseded: '-' };
const JOURNAL_ENTRY = /^### ([1-9]\d*) — (\S+)$/;
const AGENDA_ITEM = /^([1-9]\d*)\. \[([ x-])\] (.+)$/;

export type JournalTimestamp = { line: number; section: 'Journal'; value: string };

/** Journal heading instants accepted by the reader, with their body locations. */
export function journalTimestamps(body: string): JournalTimestamp[] {
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  const journal = lines.indexOf(`## ${SCRATCHPAD_JOURNAL_HEADING}`);
  const agenda = lines.indexOf(`## ${SCRATCHPAD_AGENDA_HEADING}`, journal + 1);
  if (journal === -1 || agenda === -1) {
    return [];
  }
  const timestamps: JournalTimestamp[] = [];
  for (let index = journal + 1; index < agenda; index++) {
    const match = JOURNAL_ENTRY.exec(lines[index] ?? '');
    if (match?.[2] !== undefined) {
      timestamps.push({ line: index + 1, section: 'Journal', value: match[2] });
    }
  }
  return timestamps;
}

export type ScratchpadBodyProblem =
  | 'missing-journal-section'
  | 'duplicate-journal-section'
  | 'missing-agenda-section'
  | 'duplicate-agenda-section'
  | 'section-order'
  | 'malformed-journal-entry'
  | 'invalid-journal-timestamp'
  | 'journal-sequence'
  | 'empty-journal-entry'
  | 'malformed-agenda-item'
  | 'agenda-sequence'
  | 'superseded-reason-required';
export type ScratchpadBodyFinding = {
  line: number;
  problem: ScratchpadBodyProblem;
  evidence: string;
};
export type ScratchpadBodyDecode = {
  value: ScratchpadBody | null;
  problems: ScratchpadBodyFinding[];
};

/** In-memory invariants that TypeScript's nullable Agenda shape cannot express. */
export function lintScratchpadValue(body: ScratchpadBody): string[] {
  return body.agenda.flatMap((item) => {
    if (item.state === 'superseded') {
      return typeof item.reason === 'string' && item.reason.trim() !== ''
        ? []
        : [`agenda ${String(item.number)} requires a supersession reason`];
    }
    return item.reason === null
      ? []
      : [`agenda ${String(item.number)} carries a reason outside superseded state`];
  });
}

export function encodeScratchpadBody(body: ScratchpadBody): string {
  const journal = body.journal
    .map(
      (entry: ScratchpadJournalEntry) =>
        `### ${entry.number} — ${entry.at}\n\n${escapeHeadingLines(entry.content)}`,
    )
    .join('\n\n');
  const agenda = body.agenda
    .map((item: ScratchpadAgendaItem) => {
      const reason = item.state === 'superseded' ? ` — reason: ${item.reason}` : '';
      return `${item.number}. [${MARK[item.state]}] ${item.content}${reason}`;
    })
    .join('\n');
  return `## ${SCRATCHPAD_JOURNAL_HEADING}\n\n${journal}${journal === '' ? '' : '\n\n'}## ${SCRATCHPAD_AGENDA_HEADING}\n\n${agenda}${agenda === '' ? '' : '\n'}`;
}

export function decodeScratchpadBody(body: string): ScratchpadBodyDecode {
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  const journalAnchors = headingLines(lines, SCRATCHPAD_JOURNAL_HEADING);
  const agendaAnchors = headingLines(lines, SCRATCHPAD_AGENDA_HEADING);
  const problems: ScratchpadBodyFinding[] = [];

  checkAnchor(lines, journalAnchors, SCRATCHPAD_JOURNAL_HEADING, problems);
  checkAnchor(lines, agendaAnchors, SCRATCHPAD_AGENDA_HEADING, problems);
  if (
    journalAnchors.length === 1 &&
    agendaAnchors.length === 1 &&
    (journalAnchors[0] ?? 0) > (agendaAnchors[0] ?? 0)
  ) {
    problems.push(finding(agendaAnchors[0] ?? 0, 'section-order', lines));
  }
  if (problems.length > 0 || journalAnchors[0] === undefined || agendaAnchors[0] === undefined) {
    return { problems, value: null };
  }

  const journal = parseJournal(lines, journalAnchors[0], agendaAnchors[0], problems);
  const agenda = parseAgenda(lines, agendaAnchors[0], lines.length, problems);
  return problems.length === 0
    ? { problems, value: { agenda, journal } }
    : { problems: problems.toSorted((a, b) => a.line - b.line), value: null };
}

export function lintScratchpadBody(body: string): ScratchpadBodyFinding[] {
  return decodeScratchpadBody(body).problems;
}

function headingLines(lines: readonly string[], heading: string): number[] {
  const target = `## ${heading}`;
  return semanticLines(lines, (line) => line === target);
}

function checkAnchor(
  lines: readonly string[],
  anchors: readonly number[],
  heading: typeof SCRATCHPAD_JOURNAL_HEADING | typeof SCRATCHPAD_AGENDA_HEADING,
  problems: ScratchpadBodyFinding[],
): void {
  const lower = heading === SCRATCHPAD_JOURNAL_HEADING ? 'journal' : 'agenda';
  if (anchors.length === 0) {
    problems.push({ evidence: `## ${heading}`, line: 1, problem: `missing-${lower}-section` });
  }
  for (const duplicate of anchors.slice(1)) {
    problems.push(finding(duplicate, `duplicate-${lower}-section`, lines));
  }
}

function parseJournal(
  lines: readonly string[],
  anchor: number,
  end: number,
  problems: ScratchpadBodyFinding[],
): ScratchpadJournalEntry[] {
  const boundaries: number[] = [];
  boundaries.push(
    ...semanticLines(lines.slice(anchor + 1, end), (line) => line.startsWith('### ')).map(
      (index) => index + anchor + 1,
    ),
  );
  const preambleEnd = boundaries[0] ?? end;
  const preambleLine = lines.slice(anchor + 1, preambleEnd).findIndex((line) => line.trim() !== '');
  if (preambleLine !== -1) {
    problems.push(finding(anchor + 1 + preambleLine, 'malformed-journal-entry', lines));
  }
  const entries: ScratchpadJournalEntry[] = [];
  for (let position = 0; position < boundaries.length; position++) {
    const start = boundaries[position] ?? 0;
    const match = JOURNAL_ENTRY.exec(lines[start] ?? '');
    if (match === null) {
      problems.push(finding(start, 'malformed-journal-entry', lines));
      continue;
    }
    const number = Number(match[1]);
    const at = match[2] ?? '';
    if (number !== position + 1) {
      problems.push(finding(start, 'journal-sequence', lines));
    }
    if (!isCanonicalInstant(at)) {
      problems.push(finding(start, 'invalid-journal-timestamp', lines));
    }
    const next = boundaries[position + 1] ?? end;
    const content = unescapeHeadingLines(trimBlank(lines.slice(start + 1, next)).join('\n'));
    if (content.trim() === '') {
      problems.push(finding(start, 'empty-journal-entry', lines));
    }
    entries.push({ at, content, number });
  }
  return entries;
}

function parseAgenda(
  lines: readonly string[],
  anchor: number,
  end: number,
  problems: ScratchpadBodyFinding[],
): ScratchpadAgendaItem[] {
  const contentLines = trimBlank(lines.slice(anchor + 1, end));
  const items: ScratchpadAgendaItem[] = [];
  for (const [position, line] of contentLines.entries()) {
    const sourceLine =
      anchor + 1 + lines.slice(anchor + 1, end).indexOf(contentLines[0] ?? '') + position;
    const match = AGENDA_ITEM.exec(line);
    if (match === null) {
      problems.push(finding(sourceLine, 'malformed-agenda-item', lines));
      continue;
    }
    const number = Number(match[1]);
    const mark = match[2] ?? '';
    let content = match[3] ?? '';
    let reason: string | null = null;
    let state: AgendaItemState = 'open';
    if (mark === 'x') {
      state = 'done';
    } else if (mark === '-') {
      state = 'superseded';
    }
    if (state === 'superseded') {
      const delimiter = content.lastIndexOf(' — reason: ');
      if (delimiter === -1 || content.slice(delimiter + 11).trim() === '') {
        problems.push(finding(sourceLine, 'superseded-reason-required', lines));
      } else {
        reason = content.slice(delimiter + 11);
        content = content.slice(0, delimiter);
      }
    }
    if (number !== position + 1) {
      problems.push(finding(sourceLine, 'agenda-sequence', lines));
    }
    items.push({ content, number, reason, state });
  }
  return items;
}

function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') {
    start++;
  }
  while (end > start && lines[end - 1]?.trim() === '') {
    end--;
  }
  return lines.slice(start, end);
}

function escapeHeadingLines(content: string): string {
  return mapSemanticHeadingLines(content, (line) =>
    line.replace(/^(\\*)(#{2,3} )/, String.raw`\$1$2`),
  );
}

function unescapeHeadingLines(content: string): string {
  return mapSemanticHeadingLines(content, (line) => line.replace(/^\\(\\*#{2,3} )/, '$1'));
}

/** Select semantic Markdown lines outside indented and fenced code blocks. */
function semanticLines(lines: readonly string[], matches: (line: string) => boolean): number[] {
  const found: number[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const fenceLine = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (
        fenceLine?.[2]?.[0] === fence.marker &&
        fenceLine[2].length >= fence.length &&
        /^[ \t]*$/.test(fenceLine[3] ?? '')
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceLine?.[2] !== undefined) {
      const marker = fenceLine[2][0];
      const info = fenceLine[3] ?? '';
      if ((marker === '~' || !info.includes('`')) && (marker === '`' || marker === '~')) {
        fence = { length: fenceLine[2].length, marker };
        continue;
      }
    }
    if (!line.startsWith('    ') && matches(line)) {
      found.push(index);
    }
  }
  return found;
}

/** Apply a reversible heading escape only where Markdown treats the line structurally. */
function mapSemanticHeadingLines(content: string, map: (line: string) => string): string {
  const lines = content.split('\n');
  const indexes = new Set(semanticLines(lines, (line) => /^(\\*)#{2,3} /.test(line)));
  return lines.map((line, index) => (indexes.has(index) ? map(line) : line)).join('\n');
}

function finding(
  index: number,
  problem: ScratchpadBodyProblem,
  lines: readonly string[],
): ScratchpadBodyFinding {
  return { evidence: lines[index] ?? '', line: index + 1, problem };
}
