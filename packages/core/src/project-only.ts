import type { Identity } from './ids';

/**
 * The project-only applicability rule, shared by every transport that accepts a
 * project-only write: only a project can be pinned (MMR-493) or renamed through
 * `name` (MMR-499). A task, container, seed, or artifact refuses it, so a caller
 * who typed the wrong id learns so rather than having the flag silently dropped.
 */

/** What an id names, in the words a project-only refusal uses. */
function targetNoun(kind: Identity['kind']): string {
  switch (kind) {
    case 'project': {
      return 'a project';
    }
    case 'artifact': {
      return 'an artifact';
    }
    case 'seed': {
      return 'a seed';
    }
    case 'node': {
      return 'a task or container';
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * The refusal text for a project-only field (`pinned`, `name`) aimed at the thing
 * `kind` names, or `null` when it is a project. `subject` is the transport's
 * spelling of the field (`--pinned`, `pinned`) so each refusal reads in its own
 * voice; `rule` completes "only a project can be …" (`pinned`, `renamed`).
 */
export function projectOnlyRefusal(
  kind: Identity['kind'],
  subject: string,
  rule: string,
): string | null {
  return kind === 'project'
    ? null
    : `${subject} doesn't apply to ${targetNoun(kind)} — only a project can be ${rule}`;
}
