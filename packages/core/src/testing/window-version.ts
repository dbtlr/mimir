import { MIN_CLIENT } from '@mimir/contract';

/**
 * A release version on the minimum client's major.minor.patch, so a client
 * and a host both built from it sit inside the version window (ADR 0038).
 * Derived from MIN_CLIENT so a raise of the minimum never breaks a test that
 * only needs a version inside the window.
 */
export const WINDOW_VERSION: string = MIN_CLIENT.replace(/[-+].*$/, '');
