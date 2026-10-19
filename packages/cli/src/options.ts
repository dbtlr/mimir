/**
 * Option declarations several commands share. Each command declares the ones
 * it reads as its own local options: nothing inherits (Loom ADR 0003), so a
 * flag a command does not read is an unknown option there.
 */
import type { BooleanOption, StringOption } from '@loomcli/core';
import { helpInput } from '@loomcli/plugins/help/extension';

export const scopeOption = {
  description: 'The project to read. Defaults to the clone binding.',
  extensions: [helpInput({ placeholder: 'KEY' })],
  short: 's',
  type: 'string',
} satisfies StringOption;

export const colOption = {
  description:
    'Add a column (deps tags children distribution …). Repeat it, or separate with commas.',
  extensions: [helpInput({ placeholder: 'col' })],
  multiple: true,
  type: 'string',
} satisfies StringOption;

export const asciiOption = {
  description: 'Print without color, in ASCII glyphs.',
  type: 'boolean',
} satisfies BooleanOption;

export const tzOption = {
  description:
    "Your zone: what a bare YYYY-MM-DD means, and what table and records render. Defaults to this machine's.",
  extensions: [helpInput({ placeholder: 'IANA' })],
  type: 'string',
} satisfies StringOption;

/** One `FIELD:VALUE` query-op flag (bare `FIELD` for has and missing), repeatable. */
export function filterOption(description: string, placeholder = 'FIELD:VALUE') {
  return {
    description,
    extensions: [helpInput({ placeholder })],
    multiple: true,
    type: 'string',
  } satisfies StringOption;
}

/** A string option with the `helpInput` placeholder a value shows as in help. */
export const text = (description: string, placeholder = 'text') =>
  ({
    description,
    extensions: [helpInput({ placeholder })],
    type: 'string',
  }) satisfies StringOption;

/** `-t/--tag`, repeatable. */
export const tagOption = {
  description: 'Tag it. Repeat it for several.',
  extensions: [helpInput({ placeholder: 'tag' })],
  multiple: true,
  short: 't',
  type: 'string',
} satisfies StringOption;

/** The MCP annotations of a write that adds or changes records and never deletes. */
export const writeHints = {
  destructive: false,
  openWorld: false,
  readOnly: false,
} as const;
