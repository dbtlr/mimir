import { useAnnotate } from '../api/node-mutations';
import { Composer } from './patterns/composer';

/**
 * A node's append-only note composer (ADR 0003), on the Composer pattern.
 * Submitting only ever adds a new annotation, never edits or deletes a prior
 * one. Inert when offline; writes invalidate and refetch, never queue. A
 * refused write keeps the note and says why in a Notice.
 */
export function AnnotationComposer({ nodeId, offline }: { nodeId: string; offline?: boolean }) {
  const annotate = useAnnotate(nodeId);
  return (
    <Composer
      label="Add a note"
      placeholder="Add a note"
      commitLabel="Add note"
      disabled={offline === true}
      onCommit={async (text) => {
        await annotate.mutateAsync(text);
      }}
    />
  );
}
