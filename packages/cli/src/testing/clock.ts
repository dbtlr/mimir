/**
 * A clock that never moves, so every stamp a board writes and every age a view
 * prints is the same on every run. The zone a view prints in is the run's own
 * (`mockProcess` reads UTC), not the machine's. Test-only.
 */
/** The instant a board lives at, which is every stamp and every Scratchpad guard. */
export const FROZEN_AT = new Date('2026-10-01T12:00:00.000Z');

const RealDate = Date;

/**
 * A `Date` whose clock never moves: `new Date()` and `Date.now()` read the frozen
 * instant. Every other constructor form, such as `new Date(2026, 9, 1)`, is untouched.
 */
const FrozenDate = new Proxy(RealDate, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 ? [FROZEN_AT.getTime()] : args, newTarget),
  get: (target, property, receiver) =>
    property === 'now' ? () => FROZEN_AT.getTime() : Reflect.get(target, property, receiver),
});

/** Freeze the clock, or thaw it. Bun's `setSystemTime` keeps ticking, so stamps would drift between boards. */
export function freezeClock(frozen: boolean): void {
  Reflect.set(globalThis, 'Date', frozen ? FrozenDate : RealDate);
}
