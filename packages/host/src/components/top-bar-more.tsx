import { cn } from '../lib/cn';
import type { Theme } from '../lib/theme';
import { UpdateReadyDot, usePwaRefresh } from './pwa-refresh-action';
import { iconButtonClass } from './ui/icon-button';
import { MoonIcon, MoreIcon, RefreshIcon, SunIcon } from './ui/icons';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from './ui/menu';

/** Menu-item icons sit at the menu's text size, not the button's. */
const ITEM_ICON = 'size-[18px] md:size-4 text-ink-dim';

/**
 * The phone top bar's More menu (MMR-715): the controls a phone reaches for
 * rarely (check for an update, switch the theme), so the ones it reaches for
 * often keep the 44px target. A waiting update marks the More button itself.
 */
export function TopBarMore({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const refresh = usePwaRefresh();
  const updateReady = refresh.shown && refresh.ready;
  const toLight = theme === 'dark';
  return (
    <MenuRoot>
      <MenuTrigger
        aria-label={updateReady ? 'More, update ready' : 'More'}
        className={iconButtonClass}
      >
        <MoreIcon />
        {updateReady && <UpdateReadyDot />}
      </MenuTrigger>
      <MenuContent className="min-w-52">
        {refresh.shown && (
          // Stays open: the check's spinner and label are its only feedback.
          <MenuItem
            closeOnClick={false}
            disabled={refresh.disabled}
            onClick={refresh.handleRefresh}
            className={updateReady ? 'text-action' : undefined}
          >
            <RefreshIcon
              className={cn(
                ITEM_ICON,
                updateReady && 'text-action',
                refresh.checking && 'animate-spin',
              )}
            />
            {refresh.label}
          </MenuItem>
        )}
        <MenuItem onClick={onToggleTheme}>
          {toLight ? <SunIcon className={ITEM_ICON} /> : <MoonIcon className={ITEM_ICON} />}
          {toLight ? 'Switch to light theme' : 'Switch to dark theme'}
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
