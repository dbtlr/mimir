import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/**
 * A Settings sub-page's frame (ADR 0013, MMR-733): a "← Settings" link back to
 * the index where the sidebar is not beside the page, the title, and one column
 * no wider than 900px. `actions` sit at the title's right edge.
 */
export function SettingsPage({
  title,
  subtitle,
  actions,
  back = true,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** False on the index itself, which has nowhere to go back to. */
  back?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-[900px] min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5">
      {back && (
        <Link
          to="/settings"
          className="w-fit rounded text-xs text-ink-dim hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent lg:hidden"
        >
          ← Settings
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-header font-bold tracking-[-0.01em] text-ink-bright">{title}</h1>
        {subtitle !== undefined && (
          <span className="font-mono text-[11.5px] text-ink-faint">{subtitle}</span>
        )}
        {actions !== undefined && <div className="ml-auto">{actions}</div>}
      </div>
      {children}
    </main>
  );
}
