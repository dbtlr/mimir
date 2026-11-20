import type { ClassValue } from 'clsx';

import { cn } from '../../lib/cn';

/** A UI SDK part's className: a string, or a function of the part's state. */
type ClassNameProp<State> = string | ((state: State) => string | undefined) | undefined;

/*
 * Merge a styled wrapper's base classes with the caller's `className`. UI SDK
 * parts accept className as a string or a function of the part's state; cn()
 * (clsx) discards a function, so a wrapper that used it would drop the caller's
 * state-based classes. The last argument is the caller's className; everything
 * before it is base classes.
 */
export function mergeClassName<State>(
  ...args: [...base: ClassValue[], className: ClassNameProp<State>]
): string | ((state: State) => string) {
  const base = args.filter((arg) => typeof arg !== 'function');
  const last = args[args.length - 1];
  if (typeof last === 'function') {
    return (state) => cn(base, last(state));
  }
  return cn(base);
}
