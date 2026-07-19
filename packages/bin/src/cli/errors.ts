/**
 * CLI-level error types, exit-code mapping, and error rendering. Two families:
 * - UsageError (exit 2): bad invocation — unknown command, invalid flag value.
 * - MimirError (exit 1): operational domain error from the core.
 *
 * Rendering targets stderr only; stdout is left empty on failure.
 * Machine formats (json/jsonl) emit a structured envelope; human formats
 * (records/table/ids) emit a Norn-style glyph line + optional note line.
 */
import type { ValueWarning } from '@mimir/contract';

import { MimirError } from '../core';
import type { Io } from '../presentation';

/** A bad invocation (parse failure, unknown verb, invalid flag value). Exit 2. */
export class UsageError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

export const usage = (message: string, hint?: string): UsageError => new UsageError(message, hint);

export type RenderableError = MimirError | UsageError;

export function isRenderable(err: unknown): err is RenderableError {
  return err instanceof MimirError || err instanceof UsageError;
}

/** 0 success · 2 usage · 1 operational. */
export function exitCodeFor(err: RenderableError): number {
  return err instanceof UsageError ? 2 : 1;
}

function codeOf(err: RenderableError): string {
  return err instanceof UsageError ? 'usage' : err.code;
}

/** Render a renderable error to stderr in the requested format. Never touches stdout. */
export function renderError(err: RenderableError, format: string, io: Io): void {
  if (format === 'json' || format === 'jsonl') {
    const error: { code: string; message: string; hint?: string } = {
      code: codeOf(err),
      message: err.message,
    };
    if (err.hint !== undefined) {
      error.hint = err.hint;
    }
    io.error(JSON.stringify({ error }));
    return;
  }
  const glyph = io.plain ? '[err]' : '\x1b[31m✗\x1b[0m';
  io.error(`${glyph} ${err.message}`);
  if (err.hint !== undefined) {
    const label = io.plain ? 'note:' : '\x1b[36mnote:\x1b[0m';
    io.error(`${label} ${err.hint}`);
  }
}

/**
 * Render value warnings (MMR-33) to stderr — the non-fatal member of the
 * diagnostic family, mirroring the error envelope. Exit stays 0; stdout
 * carries the (empty) result.
 */
export function renderWarnings(warnings: readonly ValueWarning[], format: string, io: Io): void {
  for (const warning of warnings) {
    if (format === 'json' || format === 'jsonl') {
      io.error(JSON.stringify({ warning }));
      continue;
    }
    const glyph = io.plain ? '[warn]' : '\x1b[33m⚠\x1b[0m';
    io.error(`${glyph} ${warning.message}`);
    const label = io.plain ? 'note:' : '\x1b[36mnote:\x1b[0m';
    io.error(`${label} expected ${warning.expected.join(', ')}`);
  }
}
