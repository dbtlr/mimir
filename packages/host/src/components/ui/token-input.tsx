import {
  createTokenInputController,
  TokenInput as SdkTokenInput,
  TokenInputEditor,
  TokenInputToken,
  TokenInputTokenRemove,
} from '@ui-sdk/react/token-input';
import type { TextRange, Token, TokenInputValue } from '@ui-sdk/react/token-input';
import { useRef, useState } from 'react';

import { cn } from '../../lib/cn';
import { TEXT_FIELD_CLASS } from './input';

/*
 * The Token Input primitive (ADR 0046): a text box whose finished words become
 * chips. The task form's tags use it: type a word, then press comma or Enter or
 * leave the box, and it becomes a removable chip (ADR 0019, MMR-736). Its value
 * is the list of tag strings. Tags are labels, so "Bug" and "bug" are one tag,
 * spelled as first entered.
 */

const NO_TAGS: string[] = [];
const TAG_TYPE = 'tag';

const tagToken = (tag: string): Token => ({ label: tag, type: TAG_TYPE, value: tag });

const isToken = (part: string | Token): part is Token => typeof part !== 'string';

/** The tags held by a value, in order. */
export function tagsOf(value: TokenInputValue): string[] {
  return value.filter(isToken).map((token) => token.value);
}

/** One replacement of finished words by chips, at UI SDK offsets (a chip counts as one). */
export type TagEdit = { at: TextRange; content: TokenInputValue };

/**
 * The edits that turn finished words into chips where they were typed. Text up
 * to a segment's last comma is finished; with `flush`, all of it is (Enter,
 * blur). Blank words and tags already present in any case are dropped. Each
 * chip is followed by a space, as UI SDK's own insertion does, so the caret
 * lands after it. Edits run right to left, so each leaves the earlier offsets valid.
 */
export function tagEdits(value: TokenInputValue, flush: boolean): TagEdit[] {
  const seen = new Set(tagsOf(value).map((tag) => tag.toLowerCase()));
  const edits: TagEdit[] = [];
  let offset = 0;
  for (const segment of value) {
    if (isToken(segment)) {
      offset += 1;
      continue;
    }
    const lead = segment.length - segment.trimStart().length;
    const finished = flush ? segment.trimEnd().length : segment.lastIndexOf(',') + 1;
    if (finished > lead) {
      const chips: Token[] = [];
      for (const word of segment.slice(lead, finished).split(',')) {
        const tag = word.trim();
        if (tag !== '' && !seen.has(tag.toLowerCase())) {
          seen.add(tag.toLowerCase());
          chips.push(tagToken(tag));
        }
      }
      const content: TokenInputValue = chips.flatMap((chip) => [chip, ' ']);
      if (/\s/.test(segment[finished] ?? '')) {
        content.pop();
      }
      edits.unshift({ at: { end: offset + finished, start: offset + lead }, content });
    }
    offset += segment.length;
  }
  return edits;
}

/**
 * The chips of `after` that repeat another chip in any case, except the repeats
 * `before` already held (a defaultValue shows stored data as it is). The first
 * of a spelling stays. A pasted chip's trailing space goes with it. Edits run
 * right to left.
 */
export function pastedDuplicateEdits(before: TokenInputValue, after: TokenInputValue): TagEdit[] {
  const allowed = new Map<string, number>();
  for (const tag of tagsOf(before)) {
    const key = tag.toLowerCase();
    allowed.set(key, (allowed.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const edits: TagEdit[] = [];
  let offset = 0;
  after.forEach((part, index) => {
    if (!isToken(part)) {
      offset += part.length;
      return;
    }
    const key = part.value.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > Math.max(1, allowed.get(key) ?? 0)) {
      const next = after[index + 1];
      const end = offset + (typeof next === 'string' && next.startsWith(' ') ? 2 : 1);
      edits.unshift({ at: { end, start: offset }, content: [] });
    }
    offset += 1;
  });
  return edits;
}

/** `after` with the chips `pastedDuplicateEdits` would remove already gone. */
export function withoutPastedDuplicates(
  before: TokenInputValue,
  after: TokenInputValue,
): TokenInputValue {
  const doomed = new Set<number>();
  const edits = pastedDuplicateEdits(before, after);
  let offset = 0;
  after.forEach((part, index) => {
    if (isToken(part) && edits.some((edit) => edit.at.start === offset)) {
      doomed.add(index);
    }
    offset += isToken(part) ? 1 : part.length;
  });
  return after.filter((_, index) => !doomed.has(index));
}

/** The chip look Token Input and the multiple Combobox share: the Badge look. */
export const CHIP_CLASS =
  'mx-0.5 inline-flex items-center gap-1 rounded-sm bg-well-800 py-px pr-0.5 pl-1.5 align-middle text-tag font-medium whitespace-nowrap text-ink inset-ring inset-ring-line data-[selected]:inset-ring-accent md:text-micro';

/** The chip's remove button. */
export const CHIP_REMOVE_CLASS =
  'inline-flex size-4 cursor-pointer items-center justify-center rounded-sm text-ink-dim hover:bg-well-700 hover:text-ink-bright data-[disabled]:cursor-not-allowed';

/** The x drawn in a chip's remove button (web.css, which would draw it, is not loaded). */
export function ChipRemoveIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** A tag chip with a remove button. */
function TagChip({ token }: { token: Token }) {
  return (
    <TokenInputToken className={CHIP_CLASS}>
      {token.label}
      <TokenInputTokenRemove aria-label={`Remove ${token.label}`} className={CHIP_REMOVE_CLASS}>
        <ChipRemoveIcon />
      </TokenInputTokenRemove>
    </TokenInputToken>
  );
}

export type TokenInputProps = {
  'aria-label'?: string;
  className?: string;
  defaultValue?: string[];
  disabled?: boolean;
  /** Names the tags' codec text when submitted in a form. */
  name?: string;
  /** Runs with the full tag list whenever a tag is added or removed. */
  onValueChange?: (tags: string[]) => void;
  placeholder?: string;
};

export function TokenInput({
  'aria-label': ariaLabel,
  className,
  defaultValue = NO_TAGS,
  disabled,
  name,
  onValueChange,
  placeholder,
}: TokenInputProps) {
  const [controller] = useState(createTokenInputController);
  const [initial] = useState(() => defaultValue.flatMap((tag) => [tagToken(tag), ' ']));
  const reported = useRef(defaultValue);
  const held = useRef<TokenInputValue>(initial);
  // UI SDK's insert keeps the caret where the edit leaves it.
  const commit = (flush: boolean) => {
    for (const edit of tagEdits(controller.getValue(), flush)) {
      controller.insert(edit.content, { at: edit.at });
    }
  };
  return (
    <SdkTokenInput
      controller={controller}
      defaultValue={initial}
      disabled={disabled}
      name={name}
      onValueChange={(next, details) => {
        // A paste or drop may not add a tag the input already holds, in any case.
        const dropsDuplicates = details.reason === 'paste' || details.reason === 'drop';
        const prior = held.current;
        held.current = next;
        const edits = dropsDuplicates ? pastedDuplicateEdits(prior, next) : [];
        const tags = tagsOf(dropsDuplicates ? withoutPastedDuplicates(prior, next) : next);
        const before = reported.current;
        if (tags.length !== before.length || tags.some((tag, at) => tag !== before[at])) {
          reported.current = tags;
          onValueChange?.(tags);
        }
        if (edits.length > 0) {
          queueMicrotask(() => {
            for (const edit of edits) {
              controller.insert(edit.content, { at: edit.at });
            }
          });
        }
        // A typed comma becomes a chip once UI SDK has applied the keystroke;
        // undo and redo are left as they are, so undoing a chip restores its text.
        if (
          details.reason !== 'undo' &&
          details.reason !== 'redo' &&
          tagEdits(next, false).length > 0
        ) {
          queueMicrotask(() => commit(false));
        }
      }}
      onSubmit={() => commit(true)}
      renderToken={(token) => <TagChip token={token} />}
    >
      <TokenInputEditor
        aria-label={ariaLabel}
        placeholder={placeholder}
        onBlur={() => commit(true)}
        className={cn(
          TEXT_FIELD_CLASS,
          'min-h-11 py-2.5 leading-[26px] data-[empty]:before:text-ink-ghost data-[empty]:before:content-[attr(aria-placeholder)]',
          className,
        )}
      />
    </SdkTokenInput>
  );
}
