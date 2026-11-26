import {
  TabsList as SdkTabsList,
  TabsPanel as SdkTabsPanel,
  TabsTab as SdkTabsTab,
} from '@ui-sdk/react/tabs';
import { createContext, useContext } from 'react';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';
import { mergeClassName } from './class-name';

/*
 * The Tabs primitive (ADR 0046): UI SDK's tabs behavior (roving focus, arrow
 * keys, panel wiring) in the Meridian look. A record page's tabs (Work,
 * Details, Timeline, Artifacts; ADR 0019, MMR-726) compose it. The selected
 * tab reads on its own: bright ink plus an accent underline, never a faint
 * tint. Below `md` a tab is a 44 × 44 tap target with its label at the left
 * of its box, so the first label sits on the page's gutter; a row too wide
 * for the screen scrolls sideways and is never clipped.
 */
export { Tabs } from '@ui-sdk/react/tabs';

/** Whether the row is joined to the top edge of the control under it. */
const JoinedTabs = createContext(false);

const ROW_CLASS =
  'flex gap-5 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-line)] [scrollbar-width:none]';

/*
 * `joined`: the row is the top edge of the control under it (a Form sheet's
 * Description, Write and Preview; ADR 0019, MMR-731). It takes the control's
 * ink-faint edge on three sides and the panel's well-850, 4 inside its sides,
 * and draws no hairline: the control's own top edge is the line under it.
 */
const JOINED_ROW_CLASS =
  'flex overflow-x-auto rounded-t-md border border-b-0 border-ink-faint bg-well-850 px-1 [scrollbar-width:none]';

/**
 * The row of tabs, with a hairline under it that the selected tab's underline
 * covers. The hairline is an inset shadow, not a border: the row scrolls, so
 * it clips to its padding box, and a tab overlapping a border lost half its
 * 2px underline.
 */
export function TabsList({
  className,
  joined = false,
  ...props
}: ComponentProps<typeof SdkTabsList> & { joined?: boolean }) {
  return (
    <JoinedTabs.Provider value={joined}>
      <SdkTabsList
        className={mergeClassName(joined ? JOINED_ROW_CLASS : ROW_CLASS, className)}
        {...props}
      />
    </JoinedTabs.Provider>
  );
}

const TAB_CLASS =
  'flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-start gap-1.5 border-b-2 border-transparent text-label font-medium whitespace-nowrap text-ink-dim transition-colors outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent md:min-h-9 md:min-w-0 data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-dim data-[disabled]:hover:text-ink-dim data-[selected]:border-accent data-[selected]:font-semibold data-[selected]:text-ink-bright';

/** A joined tab is 44 tall on a phone and 36 from `md`, its label 12 inside each side. */
const JOINED_TAB_CLASS = 'justify-center px-3';

/** One tab. Put a count in a `<TabsCount>` so it stays quieter than the label. */
export function TabsTab({ className, ...props }: ComponentProps<typeof SdkTabsTab>) {
  const joined = useContext(JoinedTabs);
  return (
    <SdkTabsTab
      className={mergeClassName(TAB_CLASS, joined ? JOINED_TAB_CLASS : 'md:px-0.5', className)}
      {...props}
    />
  );
}

/** A tab's count ("Artifacts 3"): 13px sans in ink-dim, a step under the label. */
export function TabsCount({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('text-meta font-normal text-ink-dim', className)} {...props} />;
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof SdkTabsPanel>) {
  return (
    <SdkTabsPanel
      className={mergeClassName(
        'pt-4 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  );
}
