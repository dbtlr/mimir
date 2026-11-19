import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { PushDevice } from '../api/fns/push';
import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import { SETTINGS_CARD, SettingsGroup, SettingsPage } from '../components/settings-page';
import { ActionButton, DESTRUCTIVE_OUTLINE } from '../components/ui/action-button';
import { ConfirmCard } from '../components/ui/confirm-card';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from '../components/ui/menu';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../components/ui/sheet';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import {
  healSettled,
  healThisBrowser,
  removeBrowser,
  resetKey,
  testBrowser,
} from '../lib/push-actions';
import { sameEndpoint } from '../lib/push-endpoint';
import { deviceLabel } from '../lib/push-identity';
import { deviceMeta, resetRefusalText, stateCaption, testResultText } from '../lib/push-text';
import { canTurnOn } from '../lib/push-this-device';
import { useMediaQuery } from '../lib/use-media-query';
import { usePushControl } from '../lib/use-push-control';
import { DESKTOP } from './shell';

/**
 * `/settings/notifications` — this browser's Web Push control and every
 * subscribed browser (ADR 0045, MMR-711). The row for this browser holds Turn
 * on or Turn off; its sentence, and the answer to each action, sit under the
 * group. Another browser's row opens its actions: a sheet on a phone, a menu
 * on a desktop, from Tailwind's `lg`, where Settings shows its sidebar. Turn
 * on and Turn off live in `usePushControl`; the page places their answers.
 */

const TEXT_BUTTON =
  'inline-flex min-h-11 items-center rounded px-1 text-meta text-ink-dim hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent';
const SHEET_ACTION =
  'flex min-h-11 w-full items-center rounded-lg px-3 text-left text-body text-ink-bright hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent';

function RowText({ label, meta, oldKey }: { label: string; meta: string; oldKey?: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-body font-medium text-ink-bright">{label}</span>
      {meta !== '' && (
        <span
          className={cn(
            'truncate text-meta text-ink-dim',
            oldKey === true && 'text-status-in-progress-foreground',
          )}
        >
          {meta}
        </span>
      )}
    </span>
  );
}

/** A confirmation sheet for resetting the push key. */
function ResetSheet({
  open,
  onOpenChange,
  onConfirm,
  pending,
  refusal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
  refusal: string | undefined;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="p-4">
        <ConfirmCard
          surface="bare"
          title="Reset the push key?"
          titleAs={SheetTitle}
          notice={refusal}
          cancel={{
            label: 'Cancel',
            onClick: () => {
              onOpenChange(false);
            },
          }}
          confirm={{
            disabled: pending,
            label: 'Reset',
            onClick: onConfirm,
            variant: 'destructiveOutline',
          }}
        >
          Every device stops receiving notifications until its console is opened again, and then
          subscribes again.
        </ConfirmCard>
      </SheetContent>
    </Sheet>
  );
}

/** A phone's sheet of actions for one other browser. */
function RowSheet({
  device,
  onClose,
  onTest,
  onRemove,
}: {
  device: PushDevice | undefined;
  onClose: () => void;
  onTest: (device: PushDevice) => void;
  onRemove: (device: PushDevice) => void;
}) {
  const meta = device === undefined ? undefined : deviceMeta(device, { thisDevice: false });
  return (
    <Sheet
      open={device !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent
        side="bottom"
        className="gap-1 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        {device !== undefined && meta !== undefined && (
          <>
            <div className="px-3 pb-2">
              <SheetTitle className="text-body font-semibold text-ink-bright">
                {device.label}
              </SheetTitle>
              <p className="text-meta text-ink-dim">{meta.text}</p>
            </div>
            {device.currentKey && (
              <button
                type="button"
                className={SHEET_ACTION}
                onClick={() => {
                  onTest(device);
                }}
              >
                Send test notification
              </button>
            )}
            <ActionButton
              variant="destructiveOutline"
              className="min-h-11 w-full justify-start"
              onClick={() => {
                onRemove(device);
              }}
            >
              Remove this browser
            </ActionButton>
            <SheetClose className={cn(SHEET_ACTION, 'text-ink-dim')}>Cancel</SheetClose>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The ••• menu of one other browser, on a desktop. */
function RowMenu({
  device,
  onTest,
  onRemove,
}: {
  device: PushDevice;
  onTest: (device: PushDevice) => void;
  onRemove: (device: PushDevice) => void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        aria-label={`Actions for ${device.label}`}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-dim hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden>•••</span>
      </MenuTrigger>
      <MenuContent>
        {device.currentKey && (
          <MenuItem
            onClick={() => {
              onTest(device);
            }}
          >
            Send test notification
          </MenuItem>
        )}
        <MenuItem
          className={cn(
            DESTRUCTIVE_OUTLINE,
            'data-[highlighted]:bg-line/50 data-[highlighted]:text-status-blocked-foreground',
          )}
          onClick={() => {
            onRemove(device);
          }}
        >
          Remove this browser
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}

export function NotificationsPage() {
  const client = useQueryClient();
  const desktop = useMediaQuery(DESKTOP);
  const control = usePushControl();
  const { browser, busy, devices, identity, notice, reload, setNotice, state, status } = control;
  const { devicesFailed, retryDevices, subscription, subscriptionPending, whileBusy } = control;
  const [rowNotes, setRowNotes] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<PushDevice | undefined>();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetRefusal, setResetRefusal] = useState<string | undefined>();
  // A reread may change which row is this browser's, so a row's open sheet closes rather than act on a stale match.
  if (subscriptionPending && opened !== undefined) {
    setOpened(undefined);
  }

  const caption = stateCaption(state, identity);

  const runTest = async (endpoint: string): Promise<string> => {
    let text: string;
    try {
      text = testResultText(await testBrowser(endpoint));
    } catch {
      text = "The test couldn't be sent. Try again.";
    }
    await reload();
    return text;
  };

  const onTestThis = async () => {
    if (state.kind !== 'on') {
      return;
    }
    setNotice(undefined);
    setNotice({ text: await runTest(state.device.endpoint) });
  };
  const note = (endpoint: string, text: string) => {
    setRowNotes((notes) => ({ ...notes, [endpoint]: text }));
  };
  const onTestRow = async (device: PushDevice) => {
    setOpened(undefined);
    note(device.endpoint, 'Sending a test…');
    note(device.endpoint, await runTest(device.endpoint));
  };
  const onRemoveRow = async (device: PushDevice) => {
    setOpened(undefined);
    try {
      await removeBrowser(device.endpoint);
    } catch {
      note(device.endpoint, "That browser couldn't be removed. Try again.");
    }
    await reload();
  };

  /**
   * Subscribe this browser again with `publicKey`, the key the reset answered;
   * the others do when their console opens. A heal already running finishes
   * first, so this one reads what it left, and again after the reads, for a
   * heal that started during them; one that outlasts the bounded wait, or a
   * status that is no longer ready, leaves this browser to the next load.
   */
  const healAfterReset = async (publicKey: string) => {
    try {
      if (!(await healSettled())) {
        return;
      }
      const [fresh, listed] = await Promise.all([
        client.fetchQuery({ ...pushStatusQuery, staleTime: 0 }),
        client.fetchQuery({ ...pushDevicesQuery, staleTime: 0 }),
      ]);
      // A heal can start while the reads run; wait for it again, so this one never joins it with an older key.
      if (fresh.state !== 'ready' || !(await healSettled())) {
        return;
      }
      // A status read that started before the reset can answer the old key; the reset's is newer.
      await healThisBrowser(browser, { ...fresh, publicKey }, listed, async () =>
        client.fetchQuery({ ...pushStatusQuery, staleTime: 0 }),
      );
    } catch {
      setNotice({
        text: "The push key was reset, but this page couldn't reload. Reload it to see where this browser stands.",
      });
    }
  };

  const onReset = async () => {
    setResetRefusal(undefined);
    await whileBusy(async () => {
      let answer: Awaited<ReturnType<typeof resetKey>> | undefined;
      try {
        answer = await resetKey();
      } catch {
        // Said below.
      }
      if (answer?.state !== 'reset') {
        setResetRefusal(
          answer === undefined
            ? "The push key couldn't be reset. Try again."
            : resetRefusalText(answer),
        );
        return;
      }
      setResetOpen(false);
      await healAfterReset(answer.publicKey);
    });
  };

  const showReset = status?.state === 'ready' || status?.state === 'key_unusable';
  const listed =
    status?.state === 'ready' && devices?.state === 'listed' ? devices.devices : undefined;
  // A pending reread may answer another endpoint: until it settles, no row is this browser's.
  const heldEndpoint = subscriptionPending ? undefined : subscription?.endpoint;
  const label = deviceLabel(identity);

  return (
    <SettingsPage title="Notifications">
      <SettingsGroup title="This device">
        <ul className={SETTINGS_CARD}>
          <li className="flex min-h-14 items-center gap-3 px-4 py-2.5">
            <RowText label="Notifications" meta={label} />
            {canTurnOn(state) && (
              <ActionButton disabled={busy} onClick={() => void control.turnOn()}>
                Turn on
              </ActionButton>
            )}
            {state.kind === 'on' && (
              <ActionButton
                variant="outline"
                disabled={busy}
                onClick={() => void control.turnOff()}
              >
                Turn off
              </ActionButton>
            )}
          </li>
          {state.kind === 'on' && (
            <li>
              <button
                type="button"
                className="flex min-h-11 w-full items-center px-4 py-2.5 text-left text-meta text-accent hover:bg-well-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                onClick={() => void onTestThis()}
              >
                Send test notification
              </button>
            </li>
          )}
        </ul>
        <div aria-live="polite" className="flex flex-col gap-1.5 px-1 text-xs text-ink-dim">
          {state.kind === 'loading' && <Skeleton className="h-4 w-2/3" />}
          {notice !== undefined && (
            <p className="font-medium text-ink-bright">
              {notice.text}
              {notice.link !== undefined && (
                <>
                  {' '}
                  <a href={notice.link} className="text-accent underline">
                    {notice.link}
                  </a>
                </>
              )}
            </p>
          )}
          {caption.text !== '' && <p>{caption.text}</p>}
          {caption.steps.length > 0 && (
            <ol className="ml-4 list-decimal">
              {caption.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </div>
        {showReset && state.kind === 'key_unusable' && (
          <div>
            <ActionButton
              variant="outline"
              onClick={() => {
                setResetOpen(true);
              }}
            >
              Reset push key…
            </ActionButton>
          </div>
        )}
      </SettingsGroup>

      {listed !== undefined && (
        <SettingsGroup title={`Subscribed browsers · ${String(listed.length)}`}>
          {listed.length === 0 ? (
            <p className="px-1 text-xs text-ink-dim">No browser is subscribed.</p>
          ) : (
            <ul className={SETTINGS_CARD}>
              {listed.map((device) => {
                const mine =
                  heldEndpoint !== undefined && sameEndpoint(device.endpoint, heldEndpoint);
                const meta = deviceMeta(device, { thisDevice: mine });
                const rowNote = rowNotes[device.endpoint];
                const text = (
                  <>
                    <RowText label={device.label} meta={meta.text} oldKey={meta.oldKey} />
                  </>
                );
                const noteLine = (
                  <p aria-live="polite" className="px-4 pb-2.5 text-xs text-ink-dim empty:hidden">
                    {rowNote}
                  </p>
                );
                // Until the browser's read settles, any row may be this browser's: none offers actions.
                if (mine || subscriptionPending) {
                  return (
                    <li key={device.endpoint}>
                      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">{text}</div>
                    </li>
                  );
                }
                return (
                  <li key={device.endpoint}>
                    {desktop ? (
                      <div className="flex min-h-14 items-center gap-3 py-2.5 pr-3 pl-4">
                        {text}
                        <RowMenu
                          device={device}
                          onTest={(row) => void onTestRow(row)}
                          onRemove={(row) => void onRemoveRow(row)}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`${device.label}, ${meta.text}`}
                        className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-well-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                        onClick={() => {
                          setOpened(device);
                        }}
                      >
                        {text}
                        <span aria-hidden className="text-ink-faint">
                          ›
                        </span>
                      </button>
                    )}
                    {noteLine}
                  </li>
                );
              })}
            </ul>
          )}
        </SettingsGroup>
      )}
      {listed === undefined && status?.state === 'ready' && !devicesFailed && (
        <Skeleton className="h-14" />
      )}
      {listed === undefined && status?.state === 'ready' && devicesFailed && (
        <div className="flex items-center gap-3 px-1 text-xs text-ink-dim">
          <p>The subscribed browsers couldn't be loaded.</p>
          <ActionButton size="sm" variant="outline" onClick={retryDevices}>
            Retry
          </ActionButton>
        </div>
      )}

      {showReset && state.kind !== 'key_unusable' && (
        <div>
          <button
            type="button"
            className={TEXT_BUTTON}
            onClick={() => {
              setResetOpen(true);
            }}
          >
            Reset push key…
          </button>
        </div>
      )}

      <RowSheet
        device={desktop ? undefined : opened}
        onClose={() => {
          setOpened(undefined);
        }}
        onTest={(row) => void onTestRow(row)}
        onRemove={(row) => void onRemoveRow(row)}
      />
      <ResetSheet
        open={resetOpen}
        onOpenChange={(open) => {
          setResetOpen(open);
          if (!open) {
            setResetRefusal(undefined);
          }
        }}
        onConfirm={() => void onReset()}
        pending={busy}
        refusal={resetRefusal}
      />
    </SettingsPage>
  );
}
