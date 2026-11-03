import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { T3CallbackReason, T3ConnectResult, T3Status } from '../api/fns/t3';
import { t3StatusQuery, useConnectT3 } from '../api/t3-queries';
import { until } from '../lib/time';
import { ActionButton } from './ui/action-button';

/*
 * The Devices page's T3 Code card (ADR 0040): the connection's state and the
 * Connect and Reconnect controls. It is absent while T3 is unconfigured. The
 * card words every state and callback outcome itself and never shows text
 * from T3.
 */

/** How the card words each callback outcome from `/devices?t3=<reason>`. */
export const T3_OUTCOME_TEXT: Record<T3CallbackReason, string> = {
  connected: 'Connected.',
  denied: 'You declined on T3.',
  failed: 'Connecting failed. Try again.',
  issuer: 'T3 answered as a different server.',
  misconfigured: 'T3 is not set up.',
  read_only: 'That access level cannot launch threads. Connect again and pick a launching level.',
  stale: 'That sign-in expired. Connect again.',
};

type Shown = Exclude<T3Status, { state: 'unconfigured' }>;

const DISCONNECTED_TEXT = {
  expired: 'The connection expired.',
  none: 'Not connected.',
  rejected: 'T3 refused the saved connection.',
} as const;

/** The sentence for a state. */
function stateText(status: Shown): string {
  if (status.state === 'connected') {
    return `Connected to ${status.label}. Expires ${until(status.expiresAt)}.`;
  }
  if (status.state === 'misconfigured') {
    return `T3 is not set up: ${status.setting} is ${status.problem}.`;
  }
  if (status.state === 'disconnected') {
    return DISCONNECTED_TEXT[status.reason];
  }
  return 'T3 did not answer.';
}

/** The control a state offers: Connect, Reconnect, or none. */
function controlLabel(status: Shown): string | undefined {
  if (status.state === 'connected') {
    return 'Reconnect T3';
  }
  if (status.state === 'disconnected') {
    return status.reason === 'none' ? 'Connect T3' : 'Reconnect T3';
  }
  return undefined;
}

type Refusal = Exclude<T3ConnectResult, { state: 'authorize' | 'unconfigured' }>;

export function T3Card({ outcome }: { outcome: T3CallbackReason | undefined }) {
  const status = useQuery(t3StatusQuery);
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  const connect = useConnectT3((answer) => {
    setRefusal(answer.state === 'unconfigured' ? undefined : answer);
  });
  const shown = status.data;
  if (shown === undefined || shown.state === 'unconfigured') {
    return null;
  }
  const control = controlLabel(shown);
  return (
    <section
      aria-label="T3 Code"
      className="overflow-hidden rounded-xl border border-line bg-well-850"
    >
      <h2 className="microlabel border-b border-line bg-well-950 px-4 py-2.5 text-ink-faint">
        T3 Code
      </h2>
      <div className="flex flex-col gap-2.5 px-4 py-4 text-xs text-ink-dim">
        {outcome !== undefined && (
          <p role="status" className="text-ink-bright">
            {T3_OUTCOME_TEXT[outcome]}
          </p>
        )}
        <p>{stateText(shown)}</p>
        {refusal !== undefined && <p role="alert">{stateText(refusal)}</p>}
        {control !== undefined && (
          <div className="flex flex-col items-start gap-1.5">
            <ActionButton
              size="sm"
              variant="outline"
              disabled={connect.isPending}
              onClick={() => {
                setRefusal(undefined);
                connect.mutate();
              }}
            >
              {control}
            </ActionButton>
            <p className="text-ink-faint">
              On T3&apos;s screen, pick full access if launched threads should run without approval
              prompts.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
