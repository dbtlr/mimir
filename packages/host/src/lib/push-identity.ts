/*
 * What this browser is, read from its user agent, and the label a push
 * subscription carries (ADR 0045, MMR-711). The label is generated, never
 * typed: "<Platform> · <Browser>", so the operator can tell their devices
 * apart in the list without naming them.
 */

export const PLATFORMS = [
  'iPhone',
  'iPad',
  'Android',
  'Mac',
  'Windows',
  'Linux',
  'ChromeOS',
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const BROWSERS = [
  'Safari',
  'Chrome',
  'Edge',
  'Firefox',
  'Opera',
  'Samsung Internet',
  'Browser',
] as const;
export type BrowserName = (typeof BROWSERS)[number];

/** What the page reads from the browser to tell itself apart. */
export type IdentityInput = {
  userAgent: string;
  maxTouchPoints: number;
  /** Running as an installed app: `display-mode: standalone`, or iOS's `navigator.standalone`. */
  standalone: boolean;
};

export type BrowserIdentity = {
  platform: Platform | null;
  browser: BrowserName;
  installed: boolean;
};

/** The longest label the host keeps. */
const LABEL_MAX = 60;

function platformOf({ userAgent, maxTouchPoints }: IdentityInput): Platform | null {
  if (/iPhone|iPod/.test(userAgent)) {
    return 'iPhone';
  }
  if (/iPad/.test(userAgent)) {
    return 'iPad';
  }
  if (/Android/.test(userAgent)) {
    return 'Android';
  }
  if (/CrOS/.test(userAgent)) {
    return 'ChromeOS';
  }
  if (/Macintosh|Mac OS X/.test(userAgent)) {
    // iPadOS asks for desktop sites by default and reports a Mac; only an iPad has a touch screen.
    return maxTouchPoints > 1 ? 'iPad' : 'Mac';
  }
  if (/Windows/.test(userAgent)) {
    return 'Windows';
  }
  return /Linux|X11/.test(userAgent) ? 'Linux' : null;
}

function browserOf(userAgent: string): BrowserName {
  // Order matters: most browsers' user agents also name Chrome and Safari.
  if (/Edg(?:e|A|iOS)?\//.test(userAgent)) {
    return 'Edge';
  }
  if (/OPR\/|Opera|OPiOS/.test(userAgent)) {
    return 'Opera';
  }
  if (/SamsungBrowser/.test(userAgent)) {
    return 'Samsung Internet';
  }
  if (/Firefox\/|FxiOS/.test(userAgent)) {
    return 'Firefox';
  }
  if (/Chrome\/|CriOS/.test(userAgent)) {
    return 'Chrome';
  }
  return /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
}

/** Read the platform, browser, and installed state from the browser's own words. */
export function identify(input: IdentityInput): BrowserIdentity {
  return {
    browser: browserOf(input.userAgent),
    installed: input.standalone,
    platform: platformOf(input),
  };
}

/** Whether the platform is an Apple phone or tablet, where push needs the Home Screen app. */
export function isIos(platform: Platform | null): platform is 'iPad' | 'iPhone' {
  return platform === 'iPhone' || platform === 'iPad';
}

/** Whether this browser is a desktop one, which only notifies while it is running. */
export const isDesktop = (identity: BrowserIdentity): boolean =>
  !isIos(identity.platform) && identity.platform !== 'Android';

/** The generated label a subscription carries, at most 60 characters. */
export function deviceLabel(identity: BrowserIdentity): string {
  const { platform, browser, installed } = identity;
  let name: string = browser;
  if (installed) {
    name = isIos(platform) ? 'Home Screen app' : `${browser} app`;
  }
  const label = platform === null ? name : `${platform} · ${name}`;
  return label.slice(0, LABEL_MAX);
}
