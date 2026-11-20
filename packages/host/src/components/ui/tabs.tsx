import {
  TabsList as SdkTabsList,
  TabsPanel as SdkTabsPanel,
  TabsTab as SdkTabsTab,
} from '@ui-sdk/react/tabs';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/*
 * The Tabs primitive (ADR 0046): UI SDK's tabs behavior (roving focus, arrow
 * keys, panel wiring) in the Meridian look. A record page's header tabs (Work,
 * Details, Timeline, Artifacts; ADR 0019, MMR-717/MMR-726) compose it. The
 * selected tab reads on its own: bright ink plus an accent underline, never a
 * faint tint.
 */
export { Tabs } from '@ui-sdk/react/tabs';

/** The row of tabs, with a hairline under it that the selected tab's underline sits on. */
export function TabsList({ className, ...props }: ComponentProps<typeof SdkTabsList>) {
  return (
    <SdkTabsList
      className={cn('flex gap-5 overflow-x-auto border-b border-line', className)}
      {...props}
    />
  );
}

/** One tab. Put a count in a `<TabsCount>` so it stays quieter than the label. */
export function TabsTab({ className, ...props }: ComponentProps<typeof SdkTabsTab>) {
  return (
    <SdkTabsTab
      className={cn(
        '-mb-px flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-0.5 py-2 text-sm font-medium text-ink-dim transition-colors outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-faint data-[disabled]:hover:text-ink-faint data-[selected]:border-accent data-[selected]:font-semibold data-[selected]:text-ink-bright',
        className,
      )}
      {...props}
    />
  );
}

/** A tab's count ("Artifacts 3"). */
export function TabsCount({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('text-mono-id font-mono text-ink-faint', className)} {...props} />;
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof SdkTabsPanel>) {
  return (
    <SdkTabsPanel
      className={cn(
        'pt-4 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  );
}
