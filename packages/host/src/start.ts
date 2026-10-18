import { MimirError } from '@mimir/contract';
import type { ErrorCode } from '@mimir/contract';
import { createSerializationAdapter } from '@tanstack/react-router';
import { createStart } from '@tanstack/react-start';

/**
 * An Engine refusal (`MimirError`, ADR 0034) crosses a server function as
 * itself: its code, message, and hint. Start's own error encoding keeps only
 * the message, which would leave the console unable to tell a not-found from
 * a validation refusal.
 */
export const mimirErrorAdapter = createSerializationAdapter({
  fromSerializable: ({
    code,
    hint,
    message,
  }: {
    code: ErrorCode;
    hint?: string;
    message: string;
  }) => new MimirError(code, message, hint),
  key: 'mimir-error',
  // By name, not `instanceof`: the host may load core's copy of the class
  // apart from the console's, and either copy is the same refusal.
  test: (value): value is MimirError =>
    value instanceof Error && value.name === 'MimirError' && 'code' in value,
  toSerializable: (error: MimirError) => ({
    code: error.code,
    message: error.message,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  }),
});

/** Start's instance: Engine refusals cross server functions with their code. */
export const startInstance = createStart(() => ({ serializationAdapters: [mimirErrorAdapter] }));
