import type { Theme } from '../lib/theme';
import { IconButton } from './ui/icon-button';
import { MoonIcon, SunIcon } from './ui/icons';

/**
 * The header theme switch. Presentational — the Shell owns {@link useTheme} and
 * passes the live theme + toggle so the toggle and the Toaster never diverge.
 * Shows the current theme's glyph; the label says where a click goes.
 */
export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <IconButton onClick={onToggle} aria-label={label} title={label}>
      {isDark ? <MoonIcon /> : <SunIcon />}
    </IconButton>
  );
}
