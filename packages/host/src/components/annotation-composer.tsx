import { useAnnotate } from '../api/node-mutations';
import { Composer } from './patterns/composer';

/**
 * Each record's unsent note, for this page load: the Timeline tab unmounts its
 * composer when another tab opens (MMR-728), and a draft must outlive that.
 */
const drafts = new Map<string, string>();

function keepDraft(nodeId: string, text: string) {
  if (text === '') {
    drafts.delete(nodeId);
  } else {
    drafts.set(nodeId, text);
  }
}

/**
 * A node's append-only note composer (ADR 0003), on the Composer pattern.
 * Submitting only ever adds a new annotation, never edits or deletes a prior
 * one. Inert when offline; writes invalidate and refetch, never queue. A
 * refused write keeps the note and says why in a Notice. An unsent note stays
 * with its record when the composer unmounts and comes back.
 */
export function AnnotationComposer({ nodeId, offline }: { nodeId: string; offline?: boolean }) {
  const annotate = useAnnotate(nodeId);
  return (
    <Composer
      key={nodeId}
      label="Add a note"
      placeholder="Add a note"
      commitLabel="Add note"
      draft={{ onChange: (text) => keepDraft(nodeId, text), text: drafts.get(nodeId) ?? '' }}
      disabled={offline === true}
      onCommit={async (text) => {
        await annotate.mutateAsync(text);
      }}
    />
  );
}
