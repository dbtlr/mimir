/**
 * The argv words after a command that misplace or retire a flag, one flag each.
 * The owner table (`flag-owners.ts`) redirects every one with a hint naming the
 * command that owns the flag. The parity tests run them. Test-only data.
 */

/**
 * The words after `list` and `get` that misplace or retire a flag. A flag
 * `list` owns is misplaced on `get`.
 */
export const LIST_REDIRECTS: readonly string[] = [
  '-s MMR --offset 1 -f ids',
  '-s MMR --since 2020-01-01',
  '-s MMR --not-before created_at:2020-01-01',
  '-s MMR --not-after created_at:2020-01-01',
  '-s MMR --parent MMR-2',
  '-s MMR --title x',
  '-s MMR --summary x',
  '-s MMR --target x',
  '-s MMR --ref x',
  '-s MMR --upstream x',
  '-s MMR --groomed',
  '-s MMR --pinned',
  '-s MMR --not-pinned',
  '-s MMR --remote x',
  '-s MMR --host x',
  '-s MMR --harness x',
  '-s MMR --session x',
  '-s MMR --branch x',
  '-s MMR --project XX',
  '-s MMR --requester XX',
  '-s MMR --direction x',
  '-s MMR --next',
  '-s MMR --clear-links',
  '-s MMR --expected-updated-at x',
  '-s MMR --force',
  '-s MMR --reason x',
  '-s MMR --dry-run',
  '-s MMR --apply',
  '-s MMR --resume',
];
export const GET_REDIRECTS: readonly string[] = [
  'MMR-3 --tz UTC',
  'MMR-3 --at-or-before created_at:2020-01-01',
  'MMR-3 --at-or-after created_at:2020-01-01',
  'MMR-3 --on created_at:2020-01-01',
  'MMR-3 --query x',
  'MMR-3 -q x',
];

/** One misplaced flag per seed verb and `triage`. */
export const SEED_REDIRECTS: readonly string[] = [
  'seed x -k idea -s MMR --parent MMR-2',
  'promote MMR-s1 --summary x',
  'reject MMR-s1 no --force',
  // `--reason` is the scratch flag; reject and resolve take the reason as words.
  'resolve MMR-s1 done --reason x',
  'triage MMR --force',
];

/** One misplaced flag per scratch write. */
export const SCRATCH_REDIRECTS: readonly string[] = [
  'scratch create x -s MMR --parent MMR-2',
  'scratch update abc --parent MMR-2',
  'scratch checkpoint abc t --dry-run',
  'scratch agenda add abc x --dry-run',
  'scratch freeze abc --direction x',
  'scratch discard abc --parent MMR-2',
];

/** One misplaced flag per node-write verb. */
export const NODE_REDIRECTS: readonly string[] = [
  'annotate MMR-3 note --parent MMR-2',
  'attach MMR-5 --file notes.md --parent MMR-2',
  'create task x --parent MMR-2 --direction x',
  'create phase x --parent MMR-1 --clear-links',
  'create initiative x --parent MMR --not-pinned',
  'create project x --key GAM -y --since 2020-01-01',
  'depend MMR-5 --on MMR-3 --parent MMR-2',
  'undepend MMR-5 --on MMR-3 --parent MMR-2',
  'groom MMR-4 groomed --parent MMR-2',
  'move MMR-5 --to MMR-1 --parent MMR-2',
  'reorder MMR-3 --top --parent MMR-2',
  'tag MMR-5 design --parent MMR-2',
  'untag MMR-3 alpha --parent MMR-2',
  'update MMR-3 --title x --clear-links',
  'update MMR-3 --title x --groomed',
];

/** One misplaced flag per machine-local verb. */
export const MACHINE_REDIRECTS: readonly string[] = [
  'bind MMR --parent MMR-2',
  'doctor -s MMR --parent MMR-2',
  'store upgrade --parent MMR-2',
  'store export - --parent MMR-2',
  'store import x.json --parent MMR-2',
];

/** One misplaced flag per uniform verb. */
export const LIFECYCLE_REDIRECTS: readonly string[] = [
  'queue MMR-3 --session run-1 --parent MMR-2',
  'unqueue MMR-3 run cancelled --parent MMR-2',
  'start MMR-3 --parent MMR-2',
  'submit MMR-5 --parent MMR-2',
  'return MMR-5 needs tests --parent MMR-2',
  'done MMR-5 --title x',
  'abandon MMR-3 dropped --direction x',
  'reopen MMR-7 --clear-links',
  'park MMR-3 waiting --groomed',
  'unpark MMR-3 --apply',
  'block MMR-3 waiting --parent MMR-2',
  'unblock MMR-6 --parent MMR-2',
  'archive XX --parent MMR-2',
  'unarchive XX --parent MMR-2',
];
