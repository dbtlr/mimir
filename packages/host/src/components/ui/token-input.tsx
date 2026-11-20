import {
  TokenInput as SdkTokenInput,
  TokenInputEditor,
  TokenInputToken,
  TokenInputTokenRemove,
} from '@ui-sdk/react/token-input';
import type { Token, TokenInputValue } from '@ui-sdk/react/token-input';
import { useState } from 'react';

import { cn } from '../../lib/cn';
import { TEXT_FIELD_CLASS } from './input';

/*
 * The Token Input primitive (ADR 0046): a text box whose finished words become
 * chips. The task form's tags use it: type a word, press Enter or comma, and
 * it becomes a removable chip (ADR 0019, MMR-736). Its value is the list of
 * tag strings; a word still being typed is not part of it.
 */

const NO_TAGS: string[] = [];
const TAG_TYPE = 'tag';

const tagToken = (tag: string): Token => ({ label: tag, type: TAG_TYPE, value: tag });

const isToken = (part: string | Token): part is Token => typeof part !== 'string';

/** The tags held by a value, in order. */
export function tagsOf(value: TokenInputValue): string[] {
  return value.filter(isToken).map((token) => token.value);
}

/**
 * Turns finished words into tag chips. Text before a comma is finished; with
 * `flush`, all of the text is (Enter). Blank and repeated words are dropped.
 * Chips come first, then the word still being typed.
 */
export function commitTags(value: TokenInputValue, flush: boolean): TokenInputValue {
  const tags = tagsOf(value);
  const text = value.filter((part): part is string => !isToken(part)).join('');
  const words = text.split(',');
  const draft = flush ? '' : (words.pop() ?? '');
  for (const word of words) {
    const tag = word.trim();
    if (tag !== '' && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return [...tags.map(tagToken), ...(draft === '' ? [] : [draft])];
}

/** A tag chip: the Badge look, with a remove button that draws its own x. */
function TagChip({ token }: { token: Token }) {
  return (
    <TokenInputToken className="mx-0.5 inline-flex items-center gap-1 rounded-sm bg-well-800 py-px pr-0.5 pl-1.5 align-middle text-tag font-medium whitespace-nowrap text-ink inset-ring inset-ring-line data-[selected]:inset-ring-accent md:text-micro">
      {token.label}
      <TokenInputTokenRemove
        aria-label={`Remove ${token.label}`}
        className="inline-flex size-4 cursor-pointer items-center justify-center rounded-sm text-ink-dim hover:bg-well-700 hover:text-ink-bright data-[disabled]:cursor-not-allowed"
      >
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
  const [value, setValue] = useState<TokenInputValue>(() => defaultValue.map(tagToken));
  const update = (next: TokenInputValue) => {
    const before = tagsOf(value);
    setValue(next);
    const after = tagsOf(next);
    if (after.length !== before.length || after.some((tag, at) => tag !== before[at])) {
      onValueChange?.(after);
    }
  };
  return (
    <SdkTokenInput
      value={value}
      disabled={disabled}
      name={name}
      submitShortcut="enter"
      onValueChange={(next) => {
        update(commitTags(next, false));
      }}
      onSubmit={(next) => {
        update(commitTags(next, true));
      }}
      renderToken={(token) => <TagChip token={token} />}
    >
      <TokenInputEditor
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={cn(
          TEXT_FIELD_CLASS,
          'min-h-11 py-2.5 leading-[26px] data-[empty]:before:text-ink-ghost data-[empty]:before:content-[attr(aria-placeholder)]',
          className,
        )}
      />
    </SdkTokenInput>
  );
}
