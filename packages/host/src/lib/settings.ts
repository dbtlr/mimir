import type { T3Status } from '../server/t3-states';
import type { ThemeChoice } from './theme';

/*
 * The words the Settings index shows as each row's current value (ADR 0013,
 * MMR-733). Pure, so the wording is proved once here and the page only wires it.
 */

/** Appearance's value: the stored choice, not the theme it resolves to. */
export const THEME_CHOICE_LABEL: Record<ThemeChoice, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'Match system',
};

/** Devices' value, and whether it needs the operator: waiting requests win over the paired count. */
export function devicesValue(counts: { waiting: number; paired: number }): {
  text: string;
  attention: boolean;
} {
  return counts.waiting > 0
    ? { attention: true, text: `${String(counts.waiting)} waiting` }
    : { attention: false, text: `${String(counts.paired)} paired` };
}

/** Connections' value: the T3 state in a word or two; empty until the state is known. */
export function connectionValue(status: T3Status | undefined): string {
  if (status === undefined) {
    return '';
  }
  switch (status.state) {
    case 'unconfigured': {
      return 'Not set up';
    }
    case 'misconfigured': {
      return 'Misconfigured';
    }
    case 'connected': {
      return 'Connected';
    }
    case 'disconnected': {
      return status.reason === 'none' ? 'Not connected' : 'Reconnect needed';
    }
    case 'unreachable': {
      return 'Not answering';
    }
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** A release version as the index and About show it: `v0.30.0`. */
export function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}
