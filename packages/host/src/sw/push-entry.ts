import { registerPushHandlers } from './push-handlers';
import type { PushScope } from './push-handlers';

/** The DOM lib types `self` as a Window; confirm the worker scope's parts the handlers use. */
function isPushScope(scope: unknown): scope is PushScope {
  return (
    typeof scope === 'object' &&
    scope !== null &&
    'addEventListener' in scope &&
    'clients' in scope &&
    'registration' in scope &&
    'location' in scope &&
    'navigator' in scope
  );
}

const scope: unknown = globalThis;
if (!isPushScope(scope)) {
  throw new Error('the push handlers must run in the console service worker');
}
registerPushHandlers(scope);
