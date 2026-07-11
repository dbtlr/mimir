import { useQuery } from '@tanstack/react-query';

import { healthQuery } from '../api/queries';
import { BUILD_VERSION } from '../lib/build-version';

/**
 * The always-reachable build signal (MMR-260): a days-old binary serves a
 * baked-in bundle with no other way to tell "stale binary" from "broken
 * design." Renders the daemon's reported version (falling back to the loaded
 * bundle's own when unreachable) and, when the two disagree, a quiet
 * "update available" hint — the reload/restart is on the operator, this is
 * only the tell. Deliberately achromatic (ADR 0019 §1): a version mismatch is
 * neither a status nor an attention-set member, so it earns no hue of its own.
 */
export function VersionFooter() {
  const health = useQuery(healthQuery);
  const serverVersion = health.data?.version;
  const stale = serverVersion !== undefined && serverVersion !== BUILD_VERSION;

  return (
    <footer className="flex items-center justify-center gap-1.5 border-t border-line px-3 py-1">
      <span
        className="font-mono text-micro text-ink-ghost"
        title={
          serverVersion === undefined
            ? `console ${BUILD_VERSION}`
            : `daemon ${serverVersion} · console ${BUILD_VERSION}`
        }
      >
        {serverVersion ?? BUILD_VERSION}
      </span>
      {stale && (
        <span
          className="text-micro text-ink-dim"
          title={`This console bundle (${BUILD_VERSION}) doesn't match the running daemon (${serverVersion}) — reload to converge; if the console is the newer side, restart or update the daemon instead.`}
        >
          · update available
        </span>
      )}
    </footer>
  );
}
