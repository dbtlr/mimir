import { consoleSchemas, parseEngineInput } from '@mimir/contract';
import type { ConsoleInput } from '@mimir/contract';
import { createServerFn } from '@tanstack/react-start';

import { engine } from './engine';

/*
 * The composite pages' server functions (MMR-538): the review page, the work
 * pages, and the project overview. Each is one `console.*` Engine method on
 * the host's shared Engine, named after the method and validated by its
 * contract input schema through `parseEngineInput`, so a malformed input is
 * the Engine's own validation refusal. All are reads, so all are GETs. The
 * time zone, the cache keys, and every other query policy stay in
 * view-queries.ts.
 */

/** What needs the operator across every active project, plus the project list. */
export const review = createServerFn({ method: 'GET' })
  .validator((input: ConsoleInput<'review'>) =>
    parseEngineInput(consoleSchemas.review.input, input),
  )
  .handler(async ({ data }) => (await engine()).console.review(data));

/** A project's work page: Now, Needs you, Frontier, Shipped, and Going cold. */
export const projectWork = createServerFn({ method: 'GET' })
  .validator((input: ConsoleInput<'projectWork'>) =>
    parseEngineInput(consoleSchemas.projectWork.input, input),
  )
  .handler(async ({ data }) => (await engine()).console.projectWork(data));

/** A container's work page: the same sections over one initiative's or phase's subtree. */
export const nodeWork = createServerFn({ method: 'GET' })
  .validator((input: ConsoleInput<'nodeWork'>) =>
    parseEngineInput(consoleSchemas.nodeWork.input, input),
  )
  .handler(async ({ data }) => (await engine()).console.nodeWork(data));

/** A project's overview: what is awaiting, active, and blocked, with the direction. */
export const overview = createServerFn({ method: 'GET' })
  .validator((input: ConsoleInput<'overview'>) =>
    parseEngineInput(consoleSchemas.overview.input, input),
  )
  .handler(async ({ data }) => (await engine()).console.overview(data));
