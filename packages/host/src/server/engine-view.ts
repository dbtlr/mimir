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

/** The Engine as `actor` sees it: the same methods, with each mutation marked. */
export function createEngineView(engine: Engine, actor: Actor, marks: MutationMarks): Engine {
  const flat = wrapNamespace(engine, engineSchemas, actor, marks);
  const console = wrapNamespace(engine.console, consoleSchemas, actor, marks);
  // The view has exactly the Engine's methods, one per contract schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { ...flat, console } as unknown as Engine;
}
