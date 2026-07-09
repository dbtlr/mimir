import { useState } from 'react';

import { useAnnotate } from '../api/mutations';
import { ActionButton } from './ui/action-button';

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
    <div className="flex flex-col gap-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add a note…"
        className="min-h-16 resize-y rounded border border-line bg-well-850 p-2 text-xs text-ink outline-none focus-visible:border-accent"
      />
      <div className="flex justify-end">
        <ActionButton
          size="sm"
          aria-label="Add note"
          disabled={disabled}
          onClick={handleClick}
          className="disabled:cursor-not-allowed"
        >
          Add note
        </ActionButton>
      </div>
    </div>
  );
}
