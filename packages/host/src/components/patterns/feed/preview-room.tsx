import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/*
 * Whether a preview panel is open anywhere on the page, for the shell, which
 * makes room for it from `md` up (ADR 0019, MMR-720 refinement): the sidebar
 * yields from 1024 to 1599, and the content column re-centres beside the panel.
 */

type PreviewRoom = { open: boolean; claim: (open: boolean) => void };

const PreviewRoomContext = createContext<PreviewRoom | null>(null);

/** Mount once in the shell, above every page that may open a preview. */
export function PreviewRoomProvider({ children }: { children: ReactNode }) {
  const [open, claim] = useState(false);
  const room = useMemo(() => ({ claim, open }), [open]);
  return <PreviewRoomContext.Provider value={room}>{children}</PreviewRoomContext.Provider>;
}

/** Whether a desktop preview panel is open: the shell makes room for it while it is. */
export function usePreviewRoomOpen(): boolean {
  return useContext(PreviewRoomContext)?.open ?? false;
}

/** Reports a preview's open state to the shell; outside one (a test, a bare page) it does nothing. */
export function useClaimPreviewRoom(open: boolean): void {
  const claim = useContext(PreviewRoomContext)?.claim;
  useEffect(() => {
    if (claim === undefined) {
      return undefined;
    }
    claim(open);
    return () => {
      claim(false);
    };
  }, [claim, open]);
}
