import { useState } from 'react';

import { useTag, useUntag } from '../api/mutations';
import type { WireTag } from '../api/types';
import { ActionButton } from './ui/action-button';
import { Badge } from './ui/badge';

export function TagEditor({
  nodeId,
  tags,
  offline,
}: {
  nodeId: string;
  tags: WireTag[];
  offline?: boolean;
}) {
  const [value, setValue] = useState('');
  const tag = useTag(nodeId);
  const untag = useUntag(nodeId);

  const trimmed = value.trim();
  const addDisabled = trimmed === '' || tag.isPending || untag.isPending;

  function handleAdd() {
    tag.mutate(trimmed, { onSuccess: () => setValue('') });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {tags.map((t) => (
          <Badge key={t.tag} variant="outline">
            {t.tag}
            {!offline && (
              <button
                type="button"
                aria-label={`Remove ${t.tag}`}
                disabled={tag.isPending || untag.isPending}
                onClick={() => untag.mutate(t.tag)}
                className="ml-0.5 text-ink-faint hover:text-ink transition-colors focus-visible:outline-2 focus-visible:outline-accent"
              >
                ×
              </button>
            )}
          </Badge>
        ))}
      </div>

      {!offline && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !addDisabled) {
                handleAdd();
              }
            }}
            placeholder="Add tag…"
            className="min-w-0 flex-1 rounded border border-line bg-well-850 px-2 py-1 text-xs text-ink outline-none focus-visible:border-accent"
          />
          <ActionButton
            size="sm"
            aria-label="Add tag"
            disabled={addDisabled}
            onClick={handleAdd}
            className="disabled:cursor-not-allowed"
          >
            Add
          </ActionButton>
        </div>
      )}
    </div>
  );
}
