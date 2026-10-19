import { describeFault, formatDiagnostic } from '@mimir/helpers';

import { HostFaultError, isEngineRefusal } from '../api/errors';

/**
 * What a server function's caller receives for a thrown `error`. An Engine
 * refusal crosses as itself, input validation included (each server function
 * validates through `parseEngineInput`). Anything else is an internal fault:
 * its message and stack go to the host's log through the same diagnostic
 * helpers `/trpc` uses, and the caller gets only {@link HostFaultError}.
 */
export function refusalOf(
  error: unknown,
  serverFn: string,
  log: (line: string) => void = (line) => console.error(line),
): Error {
  if (isEngineRefusal(error)) {
    return error;
  }
  log(
    `✗ host: request did not complete — ${formatDiagnostic({ ...describeFault(error), serverFn })}`,
  );
  return new HostFaultError();
}
