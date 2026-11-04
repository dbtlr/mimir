/*
 * The T3 Code integration's tagged states (ADR 0040), shared by the console
 * server and the Devices page: types, and the plain constant lists they are
 * built from. The console's server-function module and the browser both read
 * this file, so it imports nothing.
 */

/** A setting the T3 integration depends on. */
export type T3Setting =
  | 'MIMIR_HOSTS'
  | 'MIMIR_SECRET_KEY'
  | 'MIMIR_SECRET_KEY_FILE'
  | 'MIMIR_T3_URL'
  | 'MIMIR_URL';

/** What is wrong with that setting; never its value. */
export type T3Problem = 'malformed' | 'missing' | 'not HTTPS' | 'unreadable' | 'unset';

/** One configuration problem: the setting and the problem kind. */
export type T3Misconfiguration = { setting: T3Setting; problem: T3Problem };

/** Why no usable connection exists: none saved, past its expiry, or refused by T3. */
export type T3Disconnection = 'expired' | 'none' | 'rejected';

/** The states every T3 read shares before it reaches T3's data. */
export type T3Unavailable =
  | { state: 'unconfigured' }
  | ({ state: 'misconfigured' } & T3Misconfiguration)
  | { state: 'disconnected'; reason: T3Disconnection }
  | { state: 'unreachable' };

/** The Devices page's read: the configured server's label and the token's expiry. */
export type T3Status = T3Unavailable | { state: 'connected'; label: string; expiresAt: string };

/** What Connect T3 answers: the authorization URL to send the browser to, or why it cannot. */
export type T3ConnectResult = T3Unavailable | { state: 'authorize'; url: string };

/** A model a provider offers, with its launch options. */
export type T3Model = {
  id: string;
  /** T3 may list a model without a label. */
  label: string | null;
  options: {
    id: string;
    values: (boolean | number | string)[];
    default: boolean | number | string | null;
  }[];
};

/** The runtime modes, narrowest first. */
export const T3_RUNTIME_MODES = [
  'approval-required',
  'auto-accept-edits',
  'auto',
  'full-access',
] as const;
export type T3RuntimeMode = (typeof T3_RUNTIME_MODES)[number];

/** An enabled provider on a system, with the runtime modes a launch may use. */
export type T3Provider = {
  providerInstanceId: string;
  displayName: string;
  models: T3Model[];
  runtimeModes: T3RuntimeMode[];
};

/** A T3 project whose repository matches the Mimir project's remote. */
export type T3Project = {
  id: string;
  title: string;
  defaultModelSelection: { instanceId: string; model: string } | null;
};

/** One T3 environment a project can launch onto, or one that could not be read. */
export type T3System =
  | { environmentId: string; label: string; status: 'unreachable' }
  | {
      environmentId: string;
      label: string;
      status: 'reachable';
      projects: T3Project[];
      defaultThreadEnvMode: string | null;
      providers: T3Provider[];
    };

/** The launch catalog for one Mimir project. */
export type T3Catalog =
  | T3Unavailable
  | { state: 'connected'; expiresAt: string; noRemote: boolean; systems: T3System[] };

/** Where the OAuth callback sends the browser: `/devices?t3=<reason>`. */
export const T3_CALLBACK_REASONS = [
  'connected',
  'denied',
  'failed',
  'issuer',
  'misconfigured',
  'read_only',
  'stale',
] as const;
export type T3CallbackReason = (typeof T3_CALLBACK_REASONS)[number];

/** A launch attempt id: one launch of one task with one choice (ADR 0040, Launch). */
export const T3_ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** A model option's chosen value, in T3's `{ id, value }` form. */
export type T3OptionChoice = { id: string; value: boolean | number | string };

/** Where the thread works: the project checkout, or a new worktree with an optional new branch. */
export type T3Workspace = { type: 'root' } | { type: 'worktree'; branch?: string };

/** The launch server function's input: a choice, never a T3 operation. */
export type T3LaunchInput = {
  task: string;
  environmentId: string;
  projectId: string;
  model: { instanceId: string; model: string; options: T3OptionChoice[] };
  runtimeMode: T3RuntimeMode;
  interactionMode: 'default' | 'plan';
  workspace: T3Workspace;
  attempt: string;
};

/** The input field an `invalid` launch names. */
export type T3LaunchField =
  | 'attempt'
  | 'branch'
  | 'environmentId'
  | 'interactionMode'
  | 'model'
  | 'options'
  | 'projectId'
  | 'runtimeMode'
  | 'task'
  | 'workspace';

/** The thread a launch reached. */
export type T3LaunchedThread = { threadId: string; environmentId: string; label: string };

/** What a launch answers (ADR 0040, Launch). Only `unreachable` and `not_queued` are retried with the same attempt. */
export type T3LaunchResult =
  | T3Unavailable
  | { state: 'not_ready' }
  | { state: 'taken'; harness: string | null; session: string | null; host: string | null }
  | { state: 'invalid'; field: T3LaunchField }
  | { state: 'refused' }
  | ({ state: 'launched' } & T3LaunchedThread)
  | ({ state: 'not_queued'; message: string } & T3LaunchedThread);

/** The Open in T3 origin: `MIMIR_T3_URL` when the feature is configured, else null. */
export type T3Origin = { origin: string | null };
