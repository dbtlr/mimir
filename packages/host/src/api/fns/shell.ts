import { consoleSchemas, engineSchemas } from '@mimir/contract';
import { createServerFn } from '@tanstack/react-start';

import { engine } from './engine';

/*
 * The shell's server functions (MMR-537): the project lists, the sidebar tree,
 * the jump palette's search, and the project writes. Each is one Engine method
 * on the host's shared Engine, named after the method and validated by its
 * contract input schema. Reads are GETs and writes are POSTs. The facets a read
 * asks for, its cache key, and every other query policy stay in
 * shell-queries.ts and shell-mutations.ts.
 *
 * One server function per Engine method, defined once: another area imports
 * these rather than redefining them, and an area that needs a method no module
 * defines yet adds it to its own `fns/<area>.ts`.
 */

/** Active or archived projects, with the facets the caller names. */
export const projects = createServerFn({ method: 'GET' })
  .validator(engineSchemas.projects.input)
  .handler(async ({ data }) => (await engine()).projects(data));

/** A project's or container's whole hierarchy, nested and rank-ordered. */
export const tree = createServerFn({ method: 'GET' })
  .validator(engineSchemas.tree.input)
  .handler(async ({ data }) => (await engine()).tree(data));

/** Cross-record search across every project, ranking the current one first. */
export const consoleSearch = createServerFn({ method: 'GET' })
  .validator(consoleSchemas.search.input)
  .handler(async ({ data }) => (await engine()).console.search(data));

/** Create a project or a node; the input's `type` picks which. */
export const create = createServerFn({ method: 'POST' })
  .validator(engineSchemas.create.input)
  .handler(async ({ data }) => (await engine()).create(data));

/** Write a project's own fields: its name, description, direction, or pin. */
export const updateProject = createServerFn({ method: 'POST' })
  .validator(engineSchemas.updateProject.input)
  .handler(async ({ data }) => (await engine()).updateProject(data));

/** Archive a project: frozen and hidden, never deleted (ADR 0015). */
export const archive = createServerFn({ method: 'POST' })
  .validator(engineSchemas.archive.input)
  .handler(async ({ data }) => (await engine()).archive(data));

/** Restore an archived project (ADR 0015). */
export const unarchive = createServerFn({ method: 'POST' })
  .validator(engineSchemas.unarchive.input)
  .handler(async ({ data }) => (await engine()).unarchive(data));
