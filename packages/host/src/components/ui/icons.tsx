import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/*
 * The console chrome's icons (MMR-715): one 24px grid, one stroke weight, drawn
 * in `currentColor`. They are decoration; the control that holds one carries
 * the name. The default size follows the icon button: 22px on a phone, 18px
 * from `md` up.
 */
function Icon({ className, children, ...props }: ComponentProps<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-[22px] shrink-0 md:size-[18px]', className)}
      {...props}
    >
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export function MenuIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </Icon>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </Icon>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M20 7v5h-5M4 17v-5h5M6.1 8.2A7 7 0 0 1 18.7 7M17.9 15.8A7 7 0 0 1 5.3 17" />
    </Icon>
  );
}

export function MoonIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7Z" />
    </Icon>
  );
}

export function SunIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4m0-13.4-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </Icon>
  );
}

export function MoreIcon({ className }: IconProps) {
  return (
    <Icon className={className} fill="currentColor" stroke="none">
      <circle cx="5.5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18.5" cy="12" r="1.6" />
    </Icon>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Icon>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

/*
 * Key glyphs for a key hint (the jump palette's footer), drawn on the same
 * grid rather than taken from the system font, so they match its weight.
 */

export function ArrowUpIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 19V5m-6 6 6-6 6 6" />
    </Icon>
  );
}

export function ArrowDownIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 5v14m-6-6 6 6 6-6" />
    </Icon>
  );
}

export function EnterKeyIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M19 5v7a3 3 0 0 1-3 3H5m4-4-4 4 4 4" />
    </Icon>
  );
}

export function CommandKeyIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V9Z" />
    </Icon>
  );
}
