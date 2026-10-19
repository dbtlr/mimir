/**
 * The `store` command family (ADR 0030, ADR 0032): the machinery noun for the
 * store itself. `upgrade` moves a database schema, and `export` and `import`
 * carry the store's stored facts across a backend or a machine (MMR-380) as a
 * transfer document. All three act through the machine port, never the Engine:
 * `upgrade` must run before a schema gate would let a store exist.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';

import { defaultFormat } from '../default-format';
import { MimirUsageError } from '../failures';
import { STREAM } from '../machine';
import type { ExportedStore, ImportReport, UpgradeReport } from '../machine';
import type { Ports } from '../ports';
import { proseViews } from '../render/machine';
import { countLine, okLine, presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { compactJson } from '../render/views';

/** The value every `store` verb reports: its prose is built from the invocation's styling. */
type Reported<Report> = { presentation: Presentation; report: Report };

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

/** A one-line human summary of an upgrade run. */
function describeUpgrade(report: UpgradeReport): string {
  if (report.applied.length === 0) {
    return `store: schema at version ${String(report.to)} (already current)`;
  }
  return `store: schema upgraded from ${String(report.from)} to ${String(report.to)} (${report.applied.join(', ')})`;
}

const upgradeViews = proseViews(
  ({ presentation, report }: Readonly<Reported<UpgradeReport>>) =>
    okLine(presentation, describeUpgrade(report)),
  ({ report }) => compactJson(report),
);

function upgradeCommand(ports: Ports) {
  return new Command('upgrade', {
    description:
      "Move the configured database's schema to this build's. A shared Postgres store moves only when an operator runs this once. Prints prose on a terminal and json when piped.",
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({
        examples: [{ command: 'store upgrade', note: 'run once after every binary is new enough' }],
      }),
    ],
  })
    .result<Reported<UpgradeReport>>({ views: upgradeViews })
    .views({}, { default: 'records' })
    .action(async ({ host, out }) => {
      const report = await ports.machine.store.upgrade();
      await out.results({ presentation: presentationOf(host, false), report });
    });
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/** The refusal for an export path that is already taken. */
function alreadyExists(file: string): MimirUsageError {
  return new MimirUsageError(
    `store export: ${file} already exists`,
    'export refuses to overwrite a backup — remove or rename the file, or name another path',
  );
}

/** The document on stdout, or the summary of the file it was written to. */
type ExportValue =
  | { kind: 'stream'; text: string }
  | { kind: 'file'; presentation: Presentation; path: string; exported: ExportedStore };

function exportProse(value: Readonly<ExportValue>): string {
  if (value.kind === 'stream') {
    return value.text.trimEnd();
  }
  const { counts } = value.exported;
  const parts = [
    countLine(counts.projects, 'project'),
    countLine(counts.nodes, 'node'),
    countLine(counts.artifacts, 'artifact'),
    countLine(counts.seeds, 'seed'),
    countLine(counts.scratchpads, 'scratchpad'),
  ];
  return okLine(value.presentation, `store: exported ${parts.join(', ')} to ${value.path}`);
}

function exportJson(value: Readonly<ExportValue>): string {
  if (value.kind === 'stream') {
    return value.text.trimEnd();
  }
  const { counts, exportedAt, schemaVersion } = value.exported;
  return compactJson({
    ...counts,
    exported_at: exportedAt,
    path: value.path,
    schema_version: schemaVersion,
  });
}

/**
 * Write the whole store as a transfer document. The file is refused when it
 * already exists rather than overwritten: the one thing a backup command must
 * never do is destroy the backup taken before it. On `-` the document is the
 * output, with no summary in any format, or the pipe would carry two documents.
 */
function exportCommand(ports: Ports) {
  return new Command('export', {
    description:
      'Write the whole store as a transfer document. Refuses to overwrite an existing file. Prints prose on a terminal and json when piped.',
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({
        examples: [
          { command: 'store export backup.json', note: 'write a backup file' },
          { command: 'store export -', note: 'write the document to stdout' },
        ],
      }),
    ],
  })
    .argument('file', { description: 'The file to write, or - for stdout.', required: true })
    .result<ExportValue>({ views: proseViews(exportProse, exportJson) })
    .views({}, { default: 'records' })
    .action(async ({ args, host, out }) => {
      const file = args.file;
      if (file !== STREAM && ports.machine.store.documentExists(file)) {
        throw alreadyExists(file);
      }
      const exported = await ports.machine.store.export();
      if (file === STREAM) {
        await out.results({ kind: 'stream', text: exported.text });
        return;
      }
      // The write is exclusive, not the check above alone: a file created
      // between the check and the write must still be refused.
      if (ports.machine.store.writeDocument(file, exported.text) === 'exists') {
        throw alreadyExists(file);
      }
      await out.results({
        exported,
        kind: 'file',
        path: file,
        presentation: presentationOf(host, false),
      });
    });
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/**
 * The thin shape check: an object carrying a numeric `schema_version`. It lets
 * a file that is plainly not a transfer document be refused by name; the
 * store's own validation checks the contents.
 */
function looksLikeDocument(parsed: unknown): boolean {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    'schema_version' in parsed &&
    typeof parsed.schema_version === 'number'
  );
}

/** Read and shape-check the document at `file` (`-` is stdin). */
async function readDocument(ports: Ports, file: string): Promise<unknown> {
  const read = await ports.machine.store.readDocument(file);
  const source = file === STREAM ? 'stdin' : file;
  if (read.kind === 'refused') {
    throw read.reason === 'missing'
      ? new MimirUsageError(`store import: ${file} doesn't exist`)
      : new MimirUsageError(
          `store import: ${file} is not a file`,
          'pass the transfer document itself, or - to read it from stdin',
        );
  }
  const { text } = read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MimirUsageError(`store import: ${source} isn't valid JSON`);
  }
  if (!looksLikeDocument(parsed)) {
    throw new MimirUsageError(
      `store import: ${source} isn't a store export document (no numeric schema_version)`,
      "write one with 'mimir store export <file>'",
    );
  }
  return parsed;
}

/** A one-line human summary of an import run, or of the apply a preview declined. */
function describeImport(report: ImportReport): string {
  if (report.applied) {
    return `store: imported ${String(report.created)}, skipped ${String(report.skipped)} (${report.mode})`;
  }
  return `store: import preview — would create ${String(report.created)}, skip ${String(report.skipped)} (${report.mode}); run again with --apply to write`;
}

const importViews = proseViews(
  ({ presentation, report }: Readonly<Reported<ImportReport>>) =>
    okLine(presentation, describeImport(report)),
  ({ report }) => compactJson(report),
);

/** Import is a preview by default, since it writes another store's identities into this one. */
function importCommand(ports: Ports) {
  return new Command('import', {
    description:
      'Read a transfer document into the store. A preview unless --apply is given. Prints prose on a terminal and json when piped.',
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({
        examples: [
          { command: 'store import backup.json', note: 'preview what an import would do' },
          { command: 'store import backup.json --apply', note: 'write it' },
          { command: 'store import backup.json --apply --resume', note: 're-run a partial import' },
        ],
      }),
    ],
  })
    .argument('file', { description: 'The document to read, or - for stdin.', required: true })
    .option('apply', { description: 'Write the import instead of previewing it.', type: 'boolean' })
    .option('resume', {
      description: 'Re-run a partial import, skipping what is already identical.',
      type: 'boolean',
    })
    .result<Reported<ImportReport>>({ views: importViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const document = await readDocument(ports, args.file);
      const report = await ports.machine.store.import(document, {
        apply: options.apply,
        resume: options.resume,
      });
      await out.results({ presentation: presentationOf(host, false), report });
    });
}

export function storeCommand(ports: Ports) {
  return new Command('store', {
    description:
      'Operate on the store itself: upgrade its schema, export it, or import a document.',
  })
    .command(upgradeCommand(ports))
    .command(exportCommand(ports))
    .command(importCommand(ports));
}
