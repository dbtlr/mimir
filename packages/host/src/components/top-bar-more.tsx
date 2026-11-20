import { Link } from '@tanstack/react-router';

import { cn } from '../lib/cn';
import type { Theme } from '../lib/theme';
import { ActionMenu } from './patterns/action-menu';
import type { ActionMenuEntry } from './patterns/action-menu';
import { UpdateReadyDot, usePwaRefresh } from './pwa-refresh-action';
import { iconButtonClass } from './ui/icon-button';
import { MoonIcon, MoreIcon, RefreshIcon, SettingsIcon, SunIcon } from './ui/icons';

/** Menu-item icons sit at the menu's text size, not the button's. */
const ITEM_ICON = 'size-[18px] md:size-4 text-ink-dim';

/**
 * The top bar's "…" Action menu, the only control at every width (MMR-715,
 * MMR-733): Settings first, then the theme as a Choice that keeps the menu
 * open, then the update check when the console runs installed. A waiting
 * update marks the "…" button itself.
 */
export function TopBarMore({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const refresh = usePwaRefresh();
  const updateReady = refresh.shown && refresh.ready;
  const entries: ActionMenuEntry[] = [
    {
      icon: <SettingsIcon className={ITEM_ICON} />,
      key: 'settings',
      kind: 'action',
      label: 'Settings',
      render: <Link to="/settings" />,
    },
    { key: 'separator', kind: 'separator' },
    {
      key: 'theme',
      kind: 'choice',
      label: 'Theme',
      onChange: (value) => {
        if (value !== theme) {
          onToggleTheme();
        }
      },
      options: [
        { icon: <MoonIcon className={ITEM_ICON} />, label: 'Dark', value: 'dark' },
        { icon: <SunIcon className={ITEM_ICON} />, label: 'Light', value: 'light' },
      ],
      value: theme,
    },
  ];
  if (refresh.shown) {
    // Stays open: the check's spinner and label are its only feedback.
    entries.push({
      className: updateReady ? 'text-action' : undefined,
      disabled: refresh.disabled,
      icon: (
        <RefreshIcon
          className={cn(
            ITEM_ICON,
            updateReady && 'text-action',
            refresh.checking && 'animate-spin',
          )}
        />
      ),
      keepOpen: true,
      key: 'refresh',
      kind: 'action',
      label: refresh.label,
      onSelect: refresh.handleRefresh,
    });
  }
  return (
    <ActionMenu
      title="More"
      menuClassName="min-w-52"
      trigger={
        <button
          type="button"
          aria-label={updateReady ? 'More, update ready' : 'More'}
          className={iconButtonClass}
        >
          <MoreIcon />
          {updateReady && <UpdateReadyDot />}
        </button>
      }
      entries={entries}
    />
  );
}
