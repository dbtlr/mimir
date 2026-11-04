import { createServerFn } from '@tanstack/react-start';

import { parseT3CatalogInput, parseT3LaunchInput } from '../../server/t3-input';
import type { T3CatalogInput } from '../../server/t3-input';
import type { T3LaunchInput } from '../../server/t3-states';
import { requestOrigin, t3Integration } from './engine';

export type {
  T3CallbackReason,
  T3Catalog,
  T3ConnectResult,
  T3LaunchInput,
  T3LaunchResult,
  T3Origin,
  T3Status,
  T3System,
} from '../../server/t3-states';

/*
 * The T3 Code integration's server functions (ADR 0040). They act on the
 * host's T3 adapter, not the Engine; each body is a method of server/t3.ts.
 * Each answers a tagged state rather than throwing for a T3 failure. They call
 * a fixed list of T3 operations with arguments the server builds; nothing the
 * browser sends names an operation. The query policy lives in t3-queries.ts.
 */

/** The Devices page's T3 read: unconfigured, misconfigured, disconnected, unreachable, or connected. */
export const t3Status = createServerFn({ method: 'GET' }).handler(async () =>
  (await t3Integration()).status(requestOrigin()),
);

/** The T3 systems one Mimir project can launch onto. */
export const t3Catalog = createServerFn({ method: 'GET' })
  .validator((input: T3CatalogInput) => parseT3CatalogInput(input))
  .handler(async ({ data }) => (await t3Integration()).catalog(data.project));

/** Start Connect T3: the authorization URL to send the browser to, or why it cannot start. */
export const connectT3 = createServerFn({ method: 'POST' }).handler(async () =>
  (await t3Integration()).connect(requestOrigin()),
);

/**
 * Launch a task in a new T3 thread and queue it there: a choice, never a T3
 * operation. Answers a tagged state; only `unreachable` and `not_queued` are
 * worth a retry with the same attempt.
 */
export const launchT3 = createServerFn({ method: 'POST' })
  .validator((input: T3LaunchInput) => parseT3LaunchInput(input))
  .handler(async ({ data }) => (await t3Integration()).launch(data));

/** The Open in T3 origin: `MIMIR_T3_URL` when the feature is configured, else null. */
export const t3Origin = createServerFn({ method: 'GET' }).handler(async () =>
  (await t3Integration()).origin(),
);
