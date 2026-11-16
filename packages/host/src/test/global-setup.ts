// Every human-facing timestamp renders in the reader's zone (ADR 0029), so the
// suite pins one: a date assertion means the same thing on any machine.
//
// The zone is set here, in the main process before any worker starts, because
// a vmThreads test context keeps the zone its process started with: assigning
// process.env.TZ in a setup file, or through Vitest's `env` option, does not
// reach it.
export default function setup() {
  process.env.TZ = 'America/New_York';
}
