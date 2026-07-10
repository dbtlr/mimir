import { Dialog } from '@base-ui-components/react/dialog';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useMoveNode } from '../api/mutations';
import { treeQuery } from '../api/queries';
import { projectKeyOf } from '../api/types';
import { parentOptions } from '../lib/parent-options';
import { ActionButton } from './ui/action-button';

/**
 * The reparent picker behind the dossier's "Move…" verb chip (gap 3). A minimal
 * dialog over `parentOptions()` + `useMoveNode` — the same plumbing the drawer's
 * inline edit-mode `<select>` used, promoted to a standalone verb. Confirming
 * fires the `move` verb (invalidate + refetch); no optimistic write.
 */
export function MoveDialog({
  nodeId,
  currentParent,
  open,
  onClose,
}: {
  nodeId: string;
  currentParent: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const tree = useQuery({ ...treeQuery(projectKeyOf(nodeId)), enabled: open });
  const move = useMoveNode(nodeId);
  const [target, setTarget] = useState('');

  const options = tree.data ? parentOptions(tree.data) : [];

  function handleMove() {
    if (target !== '' && target !== currentParent) {
      move.mutate(target, { onSuccess: onClose });
    } else {
      onClose();
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTarget('');
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-[60] flex w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none light:shadow-overlay">
          <Dialog.Title className="text-sm font-semibold text-ink-bright">Move to…</Dialog.Title>
          <select
            aria-label="New parent"
            value={target === '' ? (currentParent ?? '') : target}
            disabled={tree.data === undefined || move.isPending}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent disabled:opacity-50"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.depth === 1 ? `  — ${o.label}` : o.label}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2">
            <Dialog.Close className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink">
              Cancel
            </Dialog.Close>
            <ActionButton
              size="sm"
              disabled={tree.data === undefined || move.isPending}
              onClick={handleMove}
            >
              Move
            </ActionButton>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
