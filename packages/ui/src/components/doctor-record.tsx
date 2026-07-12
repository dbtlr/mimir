import { toast } from 'sonner';

import type { WireDoctorRecord, WireDoctorSnippetLine } from '../api/types';
import { groupBytes } from '../lib/health';

/**
 * One dropped record in the Record-health panel (MMR-185, mocks 15a/23b). Strictly
 * read-only: the ONLY affordance is Copy location (`path:line`) — this view never
 * writes. The source snippet renders on a dark well in BOTH themes (ADR 0019 §7
 * rule 4 — machine ground stays dark), the offending token washed amber. Amber is
 * the system behaving, never an alarm; the whole surface stays in the in-progress
 * (amber) family, never red.
 */

/** The offending source line, its bad token split out and washed amber. A context
 * line renders verbatim. Whitespace is preserved (frontmatter indentation matters). */
function SnippetLine({ line }: { line: WireDoctorSnippetLine }) {
  const gutter = <span className="text-[#4D5866]">{String(line.n).padStart(3, ' ')}</span>;
  if (line.offending === undefined) {
    return (
      <div>
        {gutter} {line.text}
      </div>
    );
  }
  const { start, length } = line.offending;
  return (
    <div>
      {gutter} {line.text.slice(0, start)}
      <span className="rounded-[4px] bg-status-in-progress/20 px-1 py-px font-semibold text-status-in-progress-foreground">
        {line.text.slice(start, start + length)}
      </span>
      {line.text.slice(start + length)}
    </div>
  );
}

/** Copy `path:line` (or the bare path when unlocated) — the one affordance. The
 * success toast waits for the clipboard write to resolve; a rejection or an absent
 * `navigator.clipboard` (an insecure off-loopback context) toasts the failure
 * instead of falsely announcing a copy. */
function CopyLocation({ record }: { record: WireDoctorRecord }) {
  const target = record.location === null ? record.path : `${record.path}:${record.location.line}`;
  const copy = async () => {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(target);
      toast.success(`Copied ${target}`);
    } catch {
      toast.error(`Couldn't copy ${target} — select it from the file group above.`);
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
  const heading =
    record.title === null || record.title === '' ? record.id : `${record.id} · "${record.title}"`;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
        <span className="rounded-full bg-status-in-progress/14 px-2 py-0.5 font-mono text-micro font-semibold text-status-in-progress-foreground">
          {record.cause}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-ink-bright">{heading}</span>
        {record.location !== null && (
          <span className="ml-auto shrink-0 font-mono text-tag text-ink-faint">
            line {record.location.line} · byte {groupBytes(record.location.byte)}
          </span>
        )}
        <CopyLocation record={record} />
      </div>
      {record.snippet !== null && (
        <div className="overflow-x-auto rounded-[9px] border border-line bg-[#0B0F14] px-3.5 py-2.5 font-mono text-xs leading-[1.8] whitespace-pre text-ink-dim">
          {record.snippet.lines.map((line) => (
            <SnippetLine key={line.n} line={line} />
          ))}
        </div>
      )}
      <p className="text-tag text-ink-dim">
        {record.note}
        {record.suggestion !== null && record.suggestion !== '' && (
          <>
            {' '}
            Nearest legal:{' '}
            <span className="font-mono text-[11.5px] text-ink">{record.suggestion}</span>.
          </>
        )}{' '}
        Fix it in the file — this view never writes.
      </p>
    </div>
  );
}
