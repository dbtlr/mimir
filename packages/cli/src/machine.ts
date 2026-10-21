/**
 * What the machine-local commands need from the composition root (MMR-553):
 * the clone binding, the store backend's diagnosis, and the store's own
 * upgrade and transfer. These act on the machine, not on the board, so they
 * are not Engine reads; `src/app.ts` supplies them over core and commands see
 * only these shapes. They mirror core's types structurally, so no command
 * imports `@mimir/core`.
 */

/** What the clone's git config and origin remote say about its project. */
export type BindingCheck =
  | { state: 'bound'; key: string; source: 'git-config' | 'origin' }
  | { state: 'unbound'; reason: 'no-origin' | 'no-match' }
  | { state: 'unbound'; reason: 'ambiguous'; candidates: string[] };

/** One diagnostic pass: the wire findings, each finding's human line, and what the scope matched. */
export type Diagnosis = {
  findings: readonly Record<string, unknown>[];
  /** One human line per finding, in the same order. */
  lines: readonly string[];
  /** The scope's match count; null when the run is unscoped. */
  scope: { key: string; matched_records: number } | null;
};

/** What a schema upgrade did. */
export type UpgradeReport = { from: number; to: number; applied: string[] };

/** The store as a transfer document, ready to write, with its summary. */
export type ExportedStore = {
  /** Canonical JSON with a trailing newline. */
  text: string;
  counts: {
    artifacts: number;
    nodes: number;
    projects: number;
    scratchpads: number;
    seeds: number;
  };
  exportedAt: string;
  schemaVersion: number;
};

/** What one import did, or on a preview what an apply would do. */
export type ImportReport = {
  mode: 'fresh' | 'resume';
  applied: boolean;
  created: number;
  skipped: number;
};

/** The `file` argument of `store export` and `store import` that stands for the standard stream. */
export const STREAM = '-';

/** A transfer document read from a file or stdin, or why it could not be. */
export type DocumentRead =
  | { kind: 'text'; text: string }
  | { kind: 'refused'; reason: 'missing' | 'not-a-file' };

/** Whether a document write created its file, or found the path taken. */
export type DocumentWrite = 'written' | 'exists';

/** What `/health` told a pairing about the host. */
export type PairingHost = { version: string; minClient: string };

/** Where this build sits against a host's version window. */
export type WindowVerdict = 'inside' | 'malformed' | 'below-minimum' | 'above-host';

/** A filed pairing request: the code for the operator, and what the wait needs. */
export type PairingFiled = {
  userCode: string;
  /** Stays on this device; only `poll` reads it. */
  pollSecret: string;
  /** ISO-8601 instant the request lapses. */
  expiresAt: string;
  /** Seconds between polls. */
  interval: number;
  /** The host's clock at filing, in epoch milliseconds, when it stated one. */
  hostNow?: number;
};

/**
 * A poll's answer. `unreachable` is a failure a later poll may recover from;
 * every definite failure is thrown as a refusal instead.
 */
export type PairingPoll =
  | { status: 'pending' | 'denied' | 'expired' | 'unreachable' }
  | { status: 'approved'; device: string; token: string };

/**
 * What `pair` needs from the machine: the host's pre-credential routes, the
 * config and credentials files it writes, and the clock and hostname it
 * reads. It never needs the Engine, because pairing is what repairs a broken
 * `[host]` or credentials file.
 */
export type Pairing = {
  /** The config file, which refusals name. */
  configFile: string;
  /** The origin of an http or https URL, or undefined for anything else. */
  origin: (url: string) => string | undefined;
  /** Whether the config declares `[store]`, a local board that pairing would orphan. */
  declaresStore: () => boolean;
  /**
   * The pairing the config holds now: the origin its `[host]` names, if usable, and the
   * device name that host knows this machine by, when the credentials record one for it.
   */
  previous: () => { origin: string; device: string | undefined } | undefined;
  /** Refuse now, writing nothing, if `[host] url` could not be set to `origin` later. */
  preflight: (origin: string) => void;
  /** This machine's hostname, as the operating system reports it. */
  hostname: () => string;
  /** Epoch milliseconds. */
  now: () => number;
  /** Wait `ms`; throws the signal's reason when `signal` aborts first. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  health: (origin: string) => Promise<PairingHost>;
  /** This build against the host's window. */
  window: (host: PairingHost) => WindowVerdict;
  /** File the request; a refusal is thrown with its remedy. */
  file: (origin: string, device: string) => Promise<PairingFiled>;
  /** Ask once; an abort of `signal` ends the request, which then reads as `unreachable`. */
  poll: (origin: string, pollSecret: string, signal: AbortSignal) => Promise<PairingPoll>;
  /** Write the credentials, then `[host] url`. */
  save: (pairing: { origin: string; device: string; token: string }) => void;
};

export type Machine = {
  /** The running build's version. */
  version: string;
  binding: {
    /** The config key the binding is stored under. */
    configKey: string;
    /** The clone's project from git config, else the origin remote; `notify` hears an auto-bind. */
    check: (notify: (line: string) => void) => Promise<BindingCheck>;
    /** Bind the clone to `key`; reports the origin it recorded on the project, if any. */
    bind: (key: string) => Promise<{ recordedRemote?: string }>;
    /** The project in git config alone, never resolved from the origin. */
    configured: () => Promise<string | undefined>;
    /** Whether the retired checked-in binding file is still in the working directory. */
    legacyFilePresent: () => boolean;
  };
  doctor: { diagnose: (scope: string | undefined) => Promise<Diagnosis> };
  pair: Pairing;
  store: {
    /** Move the configured database's schema to this build's. */
    upgrade: () => Promise<UpgradeReport>;
    export: () => Promise<ExportedStore>;
    /** Hand a transfer document to the store; a preview unless `apply`. */
    import: (
      document: unknown,
      flags: { apply: boolean; resume: boolean },
    ) => Promise<ImportReport>;
    /** The text of the transfer document in `file`; `-` is the whole standard input. */
    readDocument: (file: string) => Promise<DocumentRead>;
    /** Whether a file or directory already stands at `file`. */
    documentExists: (file: string) => boolean;
    /** Create `file` with `text`; the path is never overwritten. */
    writeDocument: (file: string, text: string) => DocumentWrite;
  };
};

/** What `store export` and `store import` act through: the store's transfer, without its upgrade. */
export type StoreTransfer = Omit<Machine['store'], 'upgrade'>;
