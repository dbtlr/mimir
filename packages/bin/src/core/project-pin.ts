import type { Identity } from './ids';

/**
 * The project pin's applicability rule (MMR-493), shared by every transport that
 * accepts a pin write: only a project can be pinned. A task, container, seed, or
 * artifact refuses it, so a caller who typed the wrong id learns so rather than
 * having the flag silently dropped.
 */

/** What an id names, in the words a pin refusal uses. */
function pinTargetNoun(kind: Identity['kind']): string {
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
 * The refusal text for pinning the thing `kind` names, or `null` when it can be
 * pinned. `subject` is the transport's spelling of the field (`--pinned`,
 * `pinned`) so each refusal reads in its own voice.
 */
export function pinRefusal(kind: Identity['kind'], subject: string): string | null {
  return kind === 'project'
    ? null
    : `${subject} doesn't apply to ${pinTargetNoun(kind)} — only a project can be pinned`;
}
