import { toast } from 'sonner';

import type { WireDoctorRecord } from '../api/types';

/**
 * One `mimir doctor` finding in the Record-health panel (MMR-185). Strictly
 * read-only: the ONLY affordance is Copy location (the row's `<table>/<key>`) —
 * the fix happens at the database, never here. The surface stays in the
 * in-progress (amber) family, never red: amber is the system reporting, not an
 * alarm.
 */

/** One evidence value as plain text — a list reads comma-joined, null as `none`. */
function evidenceText(value: unknown): string {
  if (value === null || value === undefined) {
    return 'none';
  }
  if (Array.isArray(value)) {
    return value.map(evidenceText).join(', ');
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Copy the row locator — the one affordance. The success toast waits for the
 * clipboard write to resolve; a rejection or an absent `navigator.clipboard` (an
 * insecure off-loopback context) toasts the failure instead of falsely
 * announcing a copy. */
function CopyLocation({ locator }: { locator: string }) {
  const copy = async () => {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(locator);
      toast.success(`Copied ${locator}`);
    } catch {
      toast.error(`Couldn't copy ${locator} — select it from the finding above.`);
    }
  };
  return (
    <button
      type="button"
      onClick={() => {
        void copy();
      }}
      className="shrink-0 rounded-md px-2.5 py-[3px] text-tag font-semibold text-accent-foreground inset-ring inset-ring-accent/25 transition-colors hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent"
    >
      Copy location
    </button>
  );
}

export function DoctorRecord({ record }: { record: WireDoctorRecord }) {
  const evidence = Object.entries(record.evidence);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
        <span className="rounded-full bg-status-in-progress/14 px-2 py-0.5 font-mono text-micro font-semibold text-status-in-progress-foreground">
          {record.cause}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-ink-bright">{record.id}</span>
        <span className="ml-auto shrink-0 font-mono text-tag text-ink-faint">{record.locator}</span>
        <CopyLocation locator={record.locator} />
      </div>
      <p className="text-tag text-ink-dim">{record.note}</p>
      {evidence.length > 0 && (
        <dl aria-label="Evidence" className="flex max-w-[420px] flex-col gap-1">
          {evidence.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3 text-tag">
              <dt className="text-ink-dim">{key}</dt>
              <dd className="text-right font-mono text-ink">{evidenceText(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
