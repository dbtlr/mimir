import { MimirError } from '@mimir/contract';
import type { ErrorCode } from '@mimir/contract';
import { createSerializationAdapter } from '@tanstack/react-router';
import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';

import { HostFaultError, isEngineRefusal } from './api/errors';
import { refusalOf } from './server/fault-boundary';

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
  test: isEngineRefusal,
  toSerializable: (error: MimirError) => ({
    code: error.code,
    message: error.message,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  }),
});

/** An internal fault crosses as its type alone: no message, own property, or stack. */
export const hostFaultAdapter = createSerializationAdapter({
  fromSerializable: (): HostFaultError => new HostFaultError(),
  key: 'mimir-fault',
  test: (value): value is HostFaultError => value instanceof HostFaultError,
  toSerializable: (): Record<string, never> => ({}),
});

/**
 * Every server function's fault boundary: whatever its handler or input
 * validation throws leaves the host as an Engine refusal or a
 * {@link HostFaultError}, never as the thrown value (see `refusalOf`).
 */
const faultBoundary = createMiddleware({ type: 'function' }).server(
  async ({ next, serverFnMeta }) => {
    try {
      return await next();
    } catch (error) {
      throw refusalOf(error, serverFnMeta.name);
    }
  },
);

/**
 * Start's own cross-site check on server functions. Defining this instance
 * replaces Start's default, so it is registered here. It admits a browser call
 * only from the same origin (`Sec-Fetch-Site`, else `Origin`, else `Referer`),
 * and refuses a call that names none. The host guard (server/guard.ts) already
 * refuses cross-origin writes on every route; this adds the same refusal for
 * server-function reads, as defense in depth.
 */
const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' });

/** Start's instance: the cross-site check, the fault boundary, and the refusal codecs. */
export const startInstance = createStart(() => ({
  functionMiddleware: [faultBoundary],
  requestMiddleware: [csrf],
  serializationAdapters: [mimirErrorAdapter, hostFaultAdapter],
}));
