import { useState } from 'react';

import { useAnnotate } from '../api/mutations';
import { ActionButton } from './ui/action-button';

/**
 * The dossier's append-only note composer (ADR 0003): a single-row field + an
 * accent-wash "Append" chip. Submitting only ever adds a new annotation — never
 * edits or deletes a prior one. Inert (disabled, 40% via ActionButton) when
 * offline; writes invalidate + refetch, never queue.
 */
export function AnnotationComposer({ nodeId, offline }: { nodeId: string; offline?: boolean }) {
  const [value, setValue] = useState('');
  const annotate = useAnnotate(nodeId);

  const trimmed = value.trim();
  const disabled = offline === true || annotate.isPending || trimmed === '';

  function handleClick() {
    annotate.mutate(trimmed, {
      onSuccess: () => setValue(''),
    });
  }

  return (
    <div className="flex items-end gap-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={offline === true}
        placeholder="Add a note…"
        rows={1}
        className="min-h-9 flex-1 resize-y rounded-md border border-line bg-well-850 px-2.5 py-2 text-xs text-ink outline-none focus-visible:border-accent disabled:opacity-40"
      />
      {/*
       * Single-use accent-wash chip (gap 4a): the twMerge on `cn` swaps the
       * solid `action` fill for the `/14` accent wash the mock specifies. Promote
       * to an `actionButtonVariants` variant if another surface needs the idiom.
       */}
      <ActionButton
        size="sm"
        aria-label="Append note"
        disabled={disabled}
        onClick={handleClick}
        className="bg-accent/14 text-accent-foreground hover:bg-accent/20 disabled:cursor-not-allowed"
      >
        Append
      </ActionButton>
    </div>
  );
}
