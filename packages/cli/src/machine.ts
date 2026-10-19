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
