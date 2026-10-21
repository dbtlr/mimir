import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { useApprovePairing, useDenyPairing } from '../api/device-mutations';
import { pairingLookupQuery } from '../api/device-queries';
import { OfflineBanner } from '../components/offline-banner';
import { ActionButton } from '../components/ui/action-button';
import { Skeleton } from '../components/ui/skeleton';
import { connectivity } from '../lib/connectivity';
import { ago, until } from '../lib/time';
import { pairRoute } from '../router';

/**
 * `/pair` — approve or deny a device's pairing request from the console (ADR
 * 0038, MMR-585), the second approval surface beside `mimir-host approve`. The
 * device's terminal shows a code and `mimir pair` prints this page's URL with
 * the code in it; the operator checks the code matches, then decides. One
 * message covers a wrong, used, or expired code, so the page tells an
 * outsider nothing about which codes exist.
 */

const CODE_LENGTH = 8;

/** Typed or pasted text as the code reads on the device: `XXXX-XXXX`, uppercase, no stray characters. */
function formatTyped(raw: string): string {
  const letters = raw
    .replaceAll(/[^0-9A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, CODE_LENGTH);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

/** A decision made on this page, tied to the code it was made on. */
type Outcome = { code: string; verdict: 'approved' | 'denied'; device: string };

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-tag text-ink-faint">{label}</dt>
      <dd className="text-meta text-ink">{children}</dd>
    </>
  );
}

function ConfirmCard({
  code,
  request,
  onDecided,
}: {
  code: string;
  request: { device: string; created_at: string; expires_at: string; rotates: boolean };
  onDecided: (verdict: Outcome['verdict']) => void;
}) {
  const approve = useApprovePairing();
  const deny = useDenyPairing();
  const busy = approve.isPending || deny.isPending;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-well-850 p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-ink-bright">Approve {request.device}?</h2>
        <p className="text-meta text-ink-dim">
          Check that this code matches the one shown in the device&apos;s terminal.
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5">
        <Detail label="Device">
          <span className="font-mono text-ink-bright">{request.device}</span>
        </Detail>
        <Detail label="Filed">{ago(request.created_at)}</Detail>
        <Detail label="Expires">{until(request.expires_at)}</Detail>
      </dl>
      {request.rotates && (
        <p className="rounded-lg bg-status-in-progress/[0.07] px-3 py-2 text-xs text-status-in-progress-foreground inset-ring inset-ring-status-in-progress/30">
          {request.device} is already paired. Approving replaces its token.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        <ActionButton
          variant="attention"
          disabled={busy}
          onClick={() => {
            approve.mutate(code, { onSuccess: () => onDecided('approved') });
          }}
        >
          Approve
        </ActionButton>
        <ActionButton
          variant="outline"
          className="text-status-blocked-foreground inset-ring-status-blocked/35 hover:text-status-blocked-foreground"
          disabled={busy}
          onClick={() => {
            deny.mutate(code, { onSuccess: () => onDecided('denied') });
          }}
        >
          Deny
        </ActionButton>
        <Link to="/devices" className="ml-auto text-xs text-ink-dim hover:text-ink-bright">
          Manage devices →
        </Link>
      </div>
    </div>
  );
}

function OutcomeCard({ outcome }: { outcome: Outcome }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-line bg-well-850 p-5">
      <p className="text-sm font-medium text-ink-bright">
        {outcome.verdict === 'approved'
          ? `Approved ${outcome.device}. It finishes pairing on its next poll, so check the terminal.`
          : `Denied ${outcome.device}.`}
      </p>
      <Link to="/devices" className="text-xs text-ink-dim hover:text-ink-bright">
        Manage devices →
      </Link>
    </div>
  );
}

export function PairPage() {
  const initial = pairRoute.useSearch().code;
  const navigate = pairRoute.useNavigate();
  const [typed, setTyped] = useState(formatTyped(initial ?? ''));
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const code = typed.length === CODE_LENGTH + 1 ? typed : undefined;
  const lookup = useQuery({ ...pairingLookupQuery(code ?? ''), enabled: code !== undefined });
  const conn = connectivity(code === undefined ? [] : [lookup]);
  const request = lookup.isSuccess ? lookup.data : undefined;
  const decided = outcome?.code === code ? outcome : undefined;

  return (
    <>
      <OfflineBanner {...conn} />
      <main className="mx-auto flex w-full max-w-[560px] min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        <div className="flex flex-col gap-3">
          <h1 className="microlabel text-ink-faint">Pair a device</h1>
          <input
            aria-label="Pairing code"
            value={typed}
            placeholder="XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(event) => {
              const next = formatTyped(event.target.value);
              setTyped(next);
              void navigate({ replace: true, search: { code: next === '' ? undefined : next } });
            }}
            className="w-full rounded-lg border border-line-bright bg-well-950 px-3.5 py-3 font-mono text-xl tracking-[0.18em] text-ink-bright placeholder:text-ink-ghost focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>

        {code === undefined && (
          <p className="text-meta text-ink-dim">
            Run <code className="font-mono text-ink">mimir pair &lt;this host&gt;</code> on the
            device to get a code.
          </p>
        )}

        {code !== undefined && decided !== undefined && <OutcomeCard outcome={decided} />}

        {code !== undefined && decided === undefined && lookup.isPending && (
          <Skeleton className="h-40" />
        )}

        {code !== undefined && decided === undefined && lookup.isError && (
          <p className="text-xs text-status-blocked">Unreachable — is the Mimir host running?</p>
        )}

        {code !== undefined && decided === undefined && request === null && (
          <p className="text-sm text-ink-dim">No waiting request has this code.</p>
        )}

        {code !== undefined &&
          decided === undefined &&
          request !== undefined &&
          request !== null && (
            <ConfirmCard
              code={code}
              request={request}
              onDecided={(verdict) => {
                setOutcome({ code, device: request.device, verdict });
              }}
            />
          )}
      </main>
    </>
  );
}
