import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/*
 * The page's one open preview (ADR 0019, MMR-720 refinement). The room holds
 * which feed's preview is open, so a card in a second feed closes the first
 * feed's panel, and whether that preview is the desktop panel, for the shell,
 * which makes room for it from `md` up: the sidebar yields from 1024 to 1599,
 * and the content column re-centres beside the panel.
 */

type Claim = { owner: string; panel: boolean };

type PreviewRoom = {
  claim: Claim | null;
  take: (claim: Claim) => void;
  release: (owner: string) => void;
};

const PreviewRoomContext = createContext<PreviewRoom | null>(null);

/** Mount once in the shell, above every page that may open a preview. */
export function PreviewRoomProvider({ children }: { children: ReactNode }) {
  const [claim, setClaim] = useState<Claim | null>(null);
  const take = useCallback((next: Claim) => {
    setClaim(next);
  }, []);
  // A feed lets go only of its own claim: one another feed took since is that feed's.
  const release = useCallback((owner: string) => {
    setClaim((current) => (current?.owner === owner ? null : current));
  }, []);
  const room = useMemo(() => ({ claim, release, take }), [claim, release, take]);
  return <PreviewRoomContext.Provider value={room}>{children}</PreviewRoomContext.Provider>;
}

/** Whether a desktop preview panel is open: the shell makes room for it while it is. */
export function usePreviewRoomOpen(): boolean {
  return useContext(PreviewRoomContext)?.claim?.panel ?? false;
}

/**
 * Claims the page's preview for the feed `owner` while its preview is `open`,
 * `panel` when that is the desktop panel. Returns the feed that holds the
 * claim, so a feed whose preview another feed has taken closes its own.
 * Outside a room (a test, a bare page) it claims nothing and returns `null`.
 */
export function usePreviewClaim({
  owner,
  open,
  panel,
}: {
  owner: string;
  open: boolean;
  panel: boolean;
}): string | null {
  const room = useContext(PreviewRoomContext);
  const take = room?.take;
  const release = room?.release;
  useEffect(() => {
    if (take === undefined || release === undefined || !open) {
      return undefined;
    }
    take({ owner, panel });
    return () => {
      release(owner);
    };
  }, [take, release, owner, open, panel]);
  return room?.claim?.owner ?? null;
}
