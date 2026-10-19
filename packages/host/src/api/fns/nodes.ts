import { engineSchemas, parseEngineInput } from '@mimir/contract';
import type { EngineInput } from '@mimir/contract';
import { createServerFn } from '@tanstack/react-start';

import { engine } from './engine';

/*
 * The node records' server functions (MMR-539): reading a project's or node's
 * record and a board's Scratchpads, and every node write. Each is one Engine
 * method on the host's shared Engine, named after the method and validated by
 * its contract input schema through `parseEngineInput`, so a malformed input
 * is the Engine's own validation refusal. Reads are GETs and writes are POSTs.
 * Node create and the project archive pair live in shell.ts and are imported
 * from there. The facets a read asks for, its cache key, and every other
 * query policy stay in node-queries.ts and node-mutations.ts.
 *
 * The uniform lifecycle and hold verbs are written out one by one: Start's
 * compiler extracts each server function from a top-level declaration, so
 * they cannot be generated in a loop. `return` is a reserved word, so its
 * function is `returnTask`.
 */

/** One project's or node's record, with the facets the caller names. */
export const getNode = createServerFn({ method: 'GET' })
  .validator((input: EngineInput<'getNode'>) =>
    parseEngineInput(engineSchemas.getNode.input, input),
  )
  .handler(async ({ data }) => (await engine()).getNode(data));

/** One board's active Scratchpads, each with the work it is anchored to. */
export const scratchList = createServerFn({ method: 'GET' })
  .validator((input: EngineInput<'scratchList'>) =>
    parseEngineInput(engineSchemas.scratchList.input, input),
  )
  .handler(async ({ data }) => (await engine()).scratchList(data));

/** Write a node's own fields: title, prose, signals, the owned direction, and resume handles. */
export const update = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'update'>) => parseEngineInput(engineSchemas.update.input, input))
  .handler(async ({ data }) => (await engine()).update(data));

/** Reparent a node. */
export const move = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'move'>) => parseEngineInput(engineSchemas.move.input, input))
  .handler(async ({ data }) => (await engine()).move(data));

/** Make a node depend on others. */
export const depend = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'depend'>) => parseEngineInput(engineSchemas.depend.input, input))
  .handler(async ({ data }) => (await engine()).depend(data));

/** Remove a node's dependencies on others. */
export const undepend = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'undepend'>) =>
    parseEngineInput(engineSchemas.undepend.input, input),
  )
  .handler(async ({ data }) => (await engine()).undepend(data));

/** Set the grooming state of tasks (ADR 0033); `needs_answers` carries a note. */
export const groom = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'groom'>) => parseEngineInput(engineSchemas.groom.input, input))
  .handler(async ({ data }) => (await engine()).groom(data));

/** Add tags to nodes. */
export const tag = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'tag'>) => parseEngineInput(engineSchemas.tag.input, input))
  .handler(async ({ data }) => (await engine()).tag(data));

/** Remove tags from nodes. */
export const untag = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'untag'>) => parseEngineInput(engineSchemas.untag.input, input))
  .handler(async ({ data }) => (await engine()).untag(data));

/** Append a freeform note to a node. */
export const annotate = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'annotate'>) =>
    parseEngineInput(engineSchemas.annotate.input, input),
  )
  .handler(async ({ data }) => (await engine()).annotate(data));

/** Start a ready or queued task with the worker’s resume handles. */
export const start = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'start'>) => parseEngineInput(engineSchemas.start.input, input))
  .handler(async ({ data }) => (await engine()).start(data));

/** Release a run’s reservation with a cancellation reason. */
export const unqueue = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'unqueue'>) =>
    parseEngineInput(engineSchemas.unqueue.input, input),
  )
  .handler(async ({ data }) => (await engine()).unqueue(data));

/** Submit a task for review. */
export const submit = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'submit'>) => parseEngineInput(engineSchemas.submit.input, input))
  .handler(async ({ data }) => (await engine()).submit(data));

/** Send a task back from review (the Engine method `return`). */
export const returnTask = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'return'>) => parseEngineInput(engineSchemas.return.input, input))
  .handler(async ({ data }) => (await engine()).return(data));

/** Mark a task done. */
export const done = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'done'>) => parseEngineInput(engineSchemas.done.input, input))
  .handler(async ({ data }) => (await engine()).done(data));

/** Abandon a task. */
export const abandon = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'abandon'>) =>
    parseEngineInput(engineSchemas.abandon.input, input),
  )
  .handler(async ({ data }) => (await engine()).abandon(data));

/** Reopen a done or abandoned task. */
export const reopen = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'reopen'>) => parseEngineInput(engineSchemas.reopen.input, input))
  .handler(async ({ data }) => (await engine()).reopen(data));

/** Park a task, or a seed. */
export const park = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'park'>) => parseEngineInput(engineSchemas.park.input, input))
  .handler(async ({ data }) => (await engine()).park(data));

/** Resume a parked task, or a parked seed. */
export const unpark = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'unpark'>) => parseEngineInput(engineSchemas.unpark.input, input))
  .handler(async ({ data }) => (await engine()).unpark(data));

/** Mark a task blocked, on you or on others. */
export const block = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'block'>) => parseEngineInput(engineSchemas.block.input, input))
  .handler(async ({ data }) => (await engine()).block(data));

/** Clear a task's block. */
export const unblock = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'unblock'>) =>
    parseEngineInput(engineSchemas.unblock.input, input),
  )
  .handler(async ({ data }) => (await engine()).unblock(data));
