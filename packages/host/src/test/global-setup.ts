// Every human-facing timestamp renders in the reader's zone (ADR 0029), so the
// suite pins one: a date assertion means the same thing on any machine.
//
// The zone is process-wide, and it is set here, in the main process before any
// worker starts. A worker thread gets a copy of process.env, and writing TZ
// into that copy (from a setup file, or through Vitest's `env` option) does not
// change the zone. setup.ts checks that the pin took.
export const PINNED_TIME_ZONE = 'America/New_York';

export default function setup() {
  process.env.TZ = PINNED_TIME_ZONE;
}
