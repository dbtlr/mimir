import { Dialog } from "@base-ui-components/react/dialog";
import { useState } from "react";
import type { VerbSpec } from "../lib/transitions";

/**
 * Optional-reason modal for park/block/abandon. The reason is genuine
 * next-agent context; for the irreversible `abandon` it doubles as the
 * confirmation gate. Empty is allowed — the operator may skip it.
 */
export function ReasonDialog({
  verb,
  open,
  onClose,
  onConfirm,
}: {
  verb: VerbSpec["verb"] | null;
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason("");
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none">
          <Dialog.Title className="text-[14px] font-semibold text-ink-bright capitalize">
            {verb}
          </Dialog.Title>
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
            placeholder="Reason (optional) — context for the next agent"
            className="min-h-20 resize-y rounded border border-line bg-well-850 p-2 text-[12.5px] text-ink outline-none focus-visible:border-accent"
          />
          <div className="flex justify-end gap-2">
            <Dialog.Close className="rounded px-3 py-1.5 text-[12px] text-ink-dim hover:text-ink">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={() => {
                onConfirm(reason.trim());
                setReason("");
              }}
              className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-well-950 hover:opacity-90"
            >
              Confirm
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
