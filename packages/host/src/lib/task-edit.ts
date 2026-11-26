import type { EngineNode, Grooming, Priority, Size } from '@mimir/contract';

import { isEngineRefusal } from '../api/errors';
import type { UpdateNodeInput } from '../api/node-mutations';
import { visibleGrooming } from './grooming';
import { proseEdit } from './prose';
import { capitalized } from './sentence-case';

/*
 * The edit sheet's model (ADR 0019, MMR-731): what the sheet holds for a task,
 * and the writes one Save sends. A Save sends only what changed since the
 * snapshot taken when the sheet opened, as separate Engine writes: the content
 * update, one tag or untag per changed tag, the move, and the grooming change.
 * What saved joins the snapshot (`settle`), so a Save after a partial failure
 * sends only what failed.
 */

/** A field of the sheet, as a write's error names the one it belongs to. */
export type EditField =
  | 'title'
  | 'summary'
  | 'description'
  | 'size'
  | 'priority'
  | 'grooming'
  | 'parent'
  | 'tags'
  | 'externalRef';

/** The fields the content update carries, in the sheet's order. */
const CONTENT_FIELDS = [
  'title',
  'summary',
  'description',
  'size',
  'priority',
  'externalRef',
] as const;

type ContentField = (typeof CONTENT_FIELDS)[number];

/** What the sheet holds, as its controls hold it. */
export type TaskDraft = {
  title: string;
  summary: string;
  description: string;
  size: Size | null;
  priority: Priority | null;
  /** Null when the sheet shows no Grooming: the task has started. */
  grooming: Grooming | null;
  /** The operator chose a grooming state in this opening; only a choice sends a groom write. */
  groomingPicked: boolean;
  /** The open questions a choice of Needs answers asks; saved as the grooming note. */
  questions: string;
  parent: string | null;
  tags: string[];
  externalRef: string;
};

/** The draft a task opens the sheet with: its saved values. */
export function taskDraft(node: EngineNode): TaskDraft {
  return {
    description: node.description ?? '',
    externalRef: node.externalRef ?? '',
    grooming: visibleGrooming(node) ?? null,
    groomingPicked: false,
    parent: node.parent,
    priority: node.priority ?? null,
    questions: '',
    size: node.size ?? null,
    summary: node.summary ?? '',
    tags: node.tags?.map((t) => t.tag) ?? [],
    title: node.title,
  };
}

/** One Engine write a Save sends. */
export type EditWrite =
  | { kind: 'content'; fields: UpdateNodeInput; touched: readonly ContentField[] }
  | { kind: 'tag'; name: string }
  | { kind: 'untag'; name: string }
  | { kind: 'move'; to: string }
  | { kind: 'groom'; state: Grooming; note?: string };

/** One-line text as the Engine stores it: trimmed, and empty as null. */
const line = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
};

/** The content update's fields that changed from `before` to `after`, as it sends them. */
function contentChanges(before: TaskDraft, after: TaskDraft): UpdateNodeInput {
  const fields: UpdateNodeInput = {};
  const title = after.title.trim();
  if (title !== before.title.trim()) {
    fields.title = title;
  }
  if (line(after.summary) !== line(before.summary)) {
    fields.summary = line(after.summary);
  }
  if (after.description !== before.description) {
    const description = proseEdit(after.description, before.description);
    if (description !== undefined) {
      fields.description = description;
    }
  }
  if (after.size !== before.size) {
    fields.size = after.size;
  }
  if (after.priority !== before.priority) {
    fields.priority = after.priority;
  }
  if (line(after.externalRef) !== line(before.externalRef)) {
    fields.externalRef = line(after.externalRef);
  }
  return fields;
}

/** Whether a Save sends this grooming: a choice that changed it, or one that asks again. */
function groomingSent(before: TaskDraft, after: TaskDraft): Grooming | null {
  if (after.grooming === null || !after.groomingPicked) {
    return null;
  }
  return after.grooming !== before.grooming || after.grooming === 'needs_answers'
    ? after.grooming
    : null;
}

/** Whether the sheet shows Open questions: the operator chose Needs answers in this opening. */
export function asksQuestions(draft: TaskDraft): boolean {
  return draft.grooming === 'needs_answers' && draft.groomingPicked;
}

/** The longest summary the Engine stores; it refuses a longer one. */
const SUMMARY_MAX = 256;

/** The Summary's own error: longer than the Engine stores, counted as it stores it (each run of line breaks one space, trimmed). */
export function summaryError(draft: TaskDraft): string | undefined {
  return draft.summary.replaceAll(/[\r\n]+/g, ' ').trim().length > SUMMARY_MAX
    ? `Summary must be ${String(SUMMARY_MAX)} characters or fewer`
    : undefined;
}

/**
 * Whether Save must wait: the title is empty, the summary is too long, or a
 * choice of Needs answers has no questions.
 */
export function saveWaits(draft: TaskDraft): boolean {
  return (
    draft.title.trim() === '' ||
    summaryError(draft) !== undefined ||
    (asksQuestions(draft) && draft.questions.trim() === '')
  );
}

/** The writes a Save sends to turn `before` into `after`: only what changed. */
export function editWrites(before: TaskDraft, after: TaskDraft): EditWrite[] {
  const writes: EditWrite[] = [];
  const fields = contentChanges(before, after);
  const touched = CONTENT_FIELDS.filter((field) => field in fields);
  if (touched.length > 0) {
    writes.push({ fields, kind: 'content', touched });
  }
  // Each added or removed tag is its own write, so one that fails is reported and resent alone.
  const kept = new Set(before.tags);
  const next = new Set(after.tags);
  for (const name of after.tags) {
    if (!kept.has(name)) {
      writes.push({ kind: 'tag', name });
    }
  }
  for (const name of before.tags) {
    if (!next.has(name)) {
      writes.push({ kind: 'untag', name });
    }
  }
  if (after.parent !== null && after.parent !== before.parent) {
    writes.push({ kind: 'move', to: after.parent });
  }
  const state = groomingSent(before, after);
  if (state === 'needs_answers') {
    writes.push({ kind: 'groom', note: after.questions.trim(), state });
  } else if (state !== null) {
    writes.push({ kind: 'groom', state });
  }
  return writes;
}

/** The snapshot once `saved` has landed: each saved write's values join it. */
export function settle(
  before: TaskDraft,
  after: TaskDraft,
  saved: readonly EditWrite[],
): TaskDraft {
  const next: TaskDraft = { ...before, tags: [...before.tags] };
  for (const write of saved) {
    switch (write.kind) {
      case 'content': {
        for (const field of write.touched) {
          Object.assign(next, { [field]: after[field] });
        }
        break;
      }
      case 'tag': {
        next.tags = [...next.tags, write.name];
        break;
      }
      case 'untag': {
        next.tags = next.tags.filter((name) => name !== write.name);
        break;
      }
      case 'move': {
        next.parent = write.to;
        break;
      }
      case 'groom': {
        next.grooming = write.state;
        break;
      }
      default: {
        const exhaustive: never = write;
        return exhaustive;
      }
    }
  }
  return next;
}

/** How the footer note and a refusal name each content field. */
const FIELD_WORD: Record<ContentField, string> = {
  description: 'description',
  externalRef: 'external ref',
  priority: 'priority',
  size: 'size',
  summary: 'summary',
  title: 'title',
};

/** A refusal's reason, without its closing stop, to sit inside a sentence. */
function reasonOf(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return message === '' ? 'the write failed' : message.replace(/\.$/, '');
}

/** The first touched field a refusal's reason names (`external_ref` reads as "external ref"). */
function namedField(touched: readonly ContentField[], reason: string): ContentField | undefined {
  const words = reason.toLowerCase().replaceAll('_', ' ');
  return touched.find((field) => new RegExp(`\\b${FIELD_WORD[field]}\\b`).test(words));
}

/**
 * A failed write's error: the field it shows under, and what to do. An Engine
 * refusal says why it refused, so only a write that never landed (the host
 * unreachable) asks for another Save.
 */
export function writeError(
  write: EditWrite,
  error: unknown,
): { field: EditField; message: string } {
  const reason = reasonOf(error);
  const again = (act: string) => (isEngineRefusal(error) ? '' : ` Save again to ${act}.`);
  switch (write.kind) {
    case 'content': {
      return {
        field: namedField(write.touched, reason) ?? write.touched[0] ?? 'title',
        message: `Not saved: ${reason}.${again('save it')}`,
      };
    }
    case 'tag':
    case 'untag': {
      return { field: 'tags', message: `Tags not changed: ${reason}.${again('change them')}` };
    }
    case 'move': {
      return { field: 'parent', message: `Not moved: ${reason}.${again('move it')}` };
    }
    case 'groom': {
      return { field: 'grooming', message: `Grooming not set: ${reason}.${again('set it')}` };
    }
    default: {
      const exhaustive: never = write;
      return exhaustive;
    }
  }
}

/** How the footer note names each write: as saved, then as not saved. */
function writeWords(write: EditWrite): { saved: string[]; failed: string[] } {
  switch (write.kind) {
    case 'content': {
      const words = write.touched.map((field) => FIELD_WORD[field]);
      return { failed: words.map((word) => `the ${word}`), saved: words };
    }
    case 'tag':
    case 'untag': {
      return { failed: ['the tag changes'], saved: ['tags'] };
    }
    case 'move': {
      return { failed: ['the move'], saved: ['the move'] };
    }
    case 'groom': {
      return { failed: ['the grooming change'], saved: ['grooming'] };
    }
    default: {
      const exhaustive: never = write;
      return exhaustive;
    }
  }
}

/** "a", "a and b", "a, b, and c", each word once. */
function andList(words: readonly string[]): string {
  const distinct = [...new Set(words)];
  if (distinct.length <= 2) {
    return distinct.join(' and ');
  }
  return `${distinct.slice(0, -1).join(', ')}, and ${distinct.at(-1) ?? ''}`;
}

/** The footer note after a Save that partly failed: what saved, then what didn't. */
export function saveReport(saved: readonly EditWrite[], failed: readonly EditWrite[]): string {
  if (saved.length === 0) {
    return 'Nothing saved.';
  }
  const savedWords = andList(saved.flatMap((write) => writeWords(write).saved));
  const failedWords = andList(failed.flatMap((write) => writeWords(write).failed));
  return `${capitalized(savedWords)} saved. ${capitalized(failedWords)} didn't.`;
}
