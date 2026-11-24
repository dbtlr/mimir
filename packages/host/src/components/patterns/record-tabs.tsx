import type { ReactNode } from 'react';

import { Tabs, TabsCount, TabsList, TabsPanel, TabsTab } from '../ui/tabs';

/** One of a record page's tabs: its value, its label, and an optional count. */
export type RecordTab<T extends string> = { value: T; label: string; count?: number };

/**
 * A record page's tabs under its header (ADR 0013 and ADR 0019, MMR-726): the
 * URL holds the selected one, so a tab's choice is a navigation and survives
 * a reload. Only the selected tab's panel renders. A page whose tabs lead to
 * other routes (a project's Tasks, Seeds, and Artifacts) activates a tab on
 * Enter rather than on each arrow key, so arrowing along the row does not
 * open every page it passes.
 */
export function RecordTabs<T extends string>({
  tabs,
  value,
  onSelect,
  manual = false,
  children,
}: {
  tabs: readonly RecordTab<T>[];
  value: T;
  onSelect: (value: T) => void;
  manual?: boolean;
  children: ReactNode;
}) {
  return (
    <Tabs
      value={value}
      activation={manual ? 'manual' : 'automatic'}
      onValueChange={(next) => {
        const chosen = tabs.find((tab) => tab.value === next);
        if (chosen !== undefined && chosen.value !== value) {
          onSelect(chosen.value);
        }
      }}
    >
      {/* The row runs to the phone's screen edges, so a scrolled row is never cut at the gutter. */}
      <TabsList aria-label="Record views" className="-mx-3.5 mt-5 px-3.5 md:mx-0 md:mt-6 md:px-0">
        {tabs.map((tab) => (
          <TabsTab key={tab.value} value={tab.value}>
            {tab.label}{' '}
            {tab.count !== undefined && <TabsCount>{tab.count.toLocaleString('en-US')}</TabsCount>}
          </TabsTab>
        ))}
      </TabsList>
      <TabsPanel value={value} className="pt-5 md:pt-6">
        {children}
      </TabsPanel>
    </Tabs>
  );
}
