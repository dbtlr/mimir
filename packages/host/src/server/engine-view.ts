import { consoleSchemas, engineSchemas } from '@mimir/contract';
import type { Engine } from '@mimir/contract';

import type { Actor, MutationMarks } from './notifier';

/*
 * An Engine view (ADR 0045): the one Engine as one actor sees it. Every call
 * goes to the Engine unchanged and returns the Engine's own result or error;
 * around each mutation the view tells the notifier it began, then succeeded or
 * failed. The contract's `kind` says which methods are mutations. The notifier
 * is never awaited and a fault in it never reaches the caller.
 */

type Call = (input: unknown) => Promise<unknown>;
type Kinded = Record<string, { kind: string }>;

/** Tell the notifier something; its fault never reaches the write. */
function tell(mark: (actor: Actor) => void, actor: Actor): void {
  try {
    mark(actor);
  } catch {
    // The notifier's fault is not the write's.
  }
}

function markMutation(call: Call, actor: Actor, marks: MutationMarks): Call {
  return async (input) => {
    tell(marks.began, actor);
    try {
      const result = await call(input);
      tell(marks.succeeded, actor);
      return result;
    } catch (error) {
      tell(marks.failed, actor);
      throw error;
    }
  };
}

function wrapNamespace(
  target: object,
  schemas: Kinded,
  actor: Actor,
  marks: MutationMarks,
): Record<string, Call> {
  // A contract method name indexes the Engine; the schemas list only methods.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const methods = target as Record<string, Call>;
  const view: Record<string, Call> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    // Called on the target, so a method keeps its `this`.
    const call: Call = (input) => methods[name]!.call(target, input);
    view[name] = schema.kind === 'mutation' ? markMutation(call, actor, marks) : call;
  }
  return view;
}

/** The schema maps a view wraps: the flat methods, and each namespace of the Engine by name. */
export type ViewSchemas = {
  flat: Kinded;
  // A namespace is any key of `Engine` that is not a flat method: a new one fails to compile
  // here until the default below names its schemas.
  namespaces: Record<Exclude<keyof Engine, keyof typeof engineSchemas>, Kinded>;
};

const CONTRACT_SCHEMAS: ViewSchemas = {
  flat: engineSchemas,
  namespaces: { console: consoleSchemas },
};

/** The Engine as `actor` sees it: the same methods, with each mutation marked. */
export function createEngineView(
  engine: Engine,
  actor: Actor,
  marks: MutationMarks,
  schemas: ViewSchemas = CONTRACT_SCHEMAS,
): Engine {
  const flat = wrapNamespace(engine, schemas.flat, actor, marks);
  const namespaces: Record<string, Record<string, Call>> = {};
  for (const [name, namespaceSchemas] of Object.entries(schemas.namespaces)) {
    const target: unknown = Reflect.get(engine, name);
    if (typeof target !== 'object' || target === null) {
      throw new TypeError(`the Engine has no namespace ${name}`);
    }
    namespaces[name] = wrapNamespace(target, namespaceSchemas, actor, marks);
  }
  // The view has exactly the Engine's methods, one per contract schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { ...flat, ...namespaces } as unknown as Engine;
}

/** The Engine's views by the consumer they are for. */
export type EngineViews = {
  /** An agent run's grant (ADR 0041). */
  agentRuns: Engine;
  /** The console's server functions. */
  console: Engine;
  /** The T3 adapter's writes for a console action. */
  t3: Engine;
  /** The `/trpc` handler: a paired CLI or MCP server. */
  trpc: Engine;
};

/**
 * The one place that says which actor each consumer writes as (ADR 0045, "An
 * event reaches a recipient unless they caused it"): the console and the T3
 * adapter are the operator; `/trpc` and agent runs are `other`. One view per
 * actor, shared by its consumers.
 */
export function createEngineViews(engine: Engine, marks: MutationMarks): EngineViews {
  const operator = createEngineView(engine, 'operator', marks);
  const other = createEngineView(engine, 'other', marks);
  return { agentRuns: other, console: operator, t3: operator, trpc: other };
}
