import { SettingsPage } from '../components/settings-page';
import { SegmentedControl } from '../components/ui/segmented-control';
import { THEME_CHOICE_LABEL } from '../lib/settings';
import type { ThemeChoice } from '../lib/theme';
import { useTheme } from '../lib/use-theme';

const OPTIONS = (['light', 'dark', 'system'] as const).map((value) => ({
  label: THEME_CHOICE_LABEL[value],
  value,
}));

/**
 * `/settings/appearance` — Light, Dark, or Match system (MMR-733). The choice
 * lives in this browser. Match system clears the stored pick, so the console
 * follows the OS again.
 */
export function AppearancePage() {
  const { theme, choice, choose } = useTheme();
  return (
    <SettingsPage title="Appearance">
      <SegmentedControl<ThemeChoice>
        ariaLabel="Theme"
        options={OPTIONS}
        value={choice}
        onChange={choose}
        className="w-fit"
      />
      <p className="text-xs text-ink-dim">
        {choice === 'system'
          ? `This device is set to ${theme} right now, and the console follows it.`
          : `The console stays ${theme} on this device, whatever the system is set to.`}
      </p>
    </SettingsPage>
  );
}
