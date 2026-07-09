import { useState } from 'react';

import { useTag, useUntag } from '../api/mutations';
import type { WireTag } from '../api/types';

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
          <span
            key={t.tag}
            className="inline-flex items-center gap-1 rounded-sm border border-line-bright px-1.5 py-px text-micro font-medium text-ink-dim whitespace-nowrap"
          >
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
          </span>
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
          <button
            type="button"
            aria-label="Add tag"
            disabled={addDisabled}
            onClick={handleAdd}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-well-950 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
