import { Dialog } from '@base-ui-components/react/dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { PushDevice, PushDeviceList, PushEventKind } from '../api/fns/push';
import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import { KindSwitches } from '../components/push-kind-switches';
import type { KindSwitchesProps } from '../components/push-kind-switches';
import { SETTINGS_CARD, SettingsGroup, SettingsPage } from '../components/settings-page';
import { ActionButton, DESTRUCTIVE_OUTLINE } from '../components/ui/action-button';
import { ConfirmCard } from '../components/ui/confirm-card';
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from '../components/ui/menu';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../components/ui/sheet';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/cn';
import { focusMain } from '../lib/focus-main';
import {
  healSettled,
  healThisBrowser,
  removeBrowser,
  resetKey,
  testBrowser,
} from '../lib/push-actions';
import { sameEndpoint } from '../lib/push-endpoint';
import { deviceLabel } from '../lib/push-identity';
import {
  deviceMeta,
  EVERY_KIND_OFF_TEXT,
  resetRefusalText,
  stateCaption,
  testResultText,
  THAT_BROWSER_GONE_TEXT,
  THAT_EVERY_KIND_OFF_TEXT,
  THIS_BROWSER_GONE_TEXT,
} from '../lib/push-text';
import { canTurnOn } from '../lib/push-this-device';
import { useMediaQuery } from '../lib/use-media-query';
import { usePushControl } from '../lib/use-push-control';
import { withKind } from '../server/push-states';
import { DESKTOP } from './shell';

/**
 * `/settings/notifications` — this browser's Web Push control and every
 * subscribed browser (ADR 0045, MMR-711). The row for this browser holds Turn
 * on or Turn off; its sentence, and the answer to each action, sit under the
 * group. While this browser is on, "Notify this device about" holds a switch
 * per event kind (ADR 0045, MMR-712). Another browser's row opens its actions:
 * a sheet on a phone, a menu on a desktop, from Tailwind's `lg`, where Settings
 * shows its sidebar; on a current-key row, "Choose what notifies…" opens that
 * row's switches in their own sheet or dialog. Turn on and Turn off live in
 * `usePushControl`; the page places their answers.
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
  opener,
  onClose,
  onChoose,
  onTest,
  onRemove,
}: {
  device: PushDevice | undefined;
  /** The endpoint of the row that opened the sheet, set when it opens; it outlives the close. */
  opener: RefObject<string | undefined>;
  onClose: () => void;
  onChoose: (device: PushDevice) => void;
  onTest: (device: PushDevice) => void;
  onRemove: (device: PushDevice) => void;
}) {
  const meta = device === undefined ? undefined : deviceMeta(device, { thisDevice: false });
  // Focus returns to the row that opened the sheet, or to the page when that row is gone.
  const finalFocus = () => {
    const row = opener.current === undefined ? null : rowOpener(opener.current);
    if (row === null) {
      focusMain();
      return false;
    }
    return row;
  };
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
        finalFocus={finalFocus}
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
              <>
                <button
                  type="button"
                  className={SHEET_ACTION}
                  onClick={() => {
                    onChoose(device);
                  }}
                >
                  Choose what notifies…
                </button>
                <button
                  type="button"
                  className={SHEET_ACTION}
                  onClick={() => {
                    onTest(device);
                  }}
                >
                  Send test notification
                </button>
              </>
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
  onChoose,
  onTest,
  onRemove,
}: {
  device: PushDevice;
  onChoose: (device: PushDevice) => void;
  onTest: (device: PushDevice) => void;
  onRemove: (device: PushDevice) => void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        data-push-row={device.endpoint}
        aria-label={`Actions for ${device.label}`}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-dim hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden>•••</span>
      </MenuTrigger>
      <MenuContent>
        {device.currentKey && (
          <>
            <MenuItem
              onClick={() => {
                onChoose(device);
              }}
            >
              Choose what notifies…
            </MenuItem>
            <MenuItem
              onClick={() => {
                onTest(device);
              }}
            >
              Send test notification
            </MenuItem>
          </>
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

const KINDS_DIALOG =
  'fixed top-1/2 left-1/2 z-[60] flex max-h-[90dvh] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none light:shadow-overlay';
// The list scrolls on a short screen, so every switch stays reachable above Done.
const KINDS_BLOCK = 'min-h-0 overflow-y-auto rounded-lg border border-line bg-well-850';

/** The row that opened another browser's switches, for Done to return focus to. */
const rowOpener = (endpoint: string) =>
  document.querySelector<HTMLElement>(`[data-push-row="${CSS.escape(endpoint)}"]`);

/** Which row the switches were opened for, and whether the host answered that it is gone. */
type KindsOpener = { endpoint: string; gone: boolean };

/**
 * Another browser's switches (ADR 0045, MMR-712): a sheet on a phone, a
 * dialog on a desktop, titled with the row's label. Done closes it and
 * returns focus to the row that opened it; after `not_found` focus goes to
 * the page's `<main>`. `opener` outlives the close, when `device` is gone.
 */
function KindsSurface({
  device,
  desktop,
  opener,
  onClose,
  switches,
}: {
  device: PushDevice | undefined;
  desktop: boolean;
  opener: RefObject<KindsOpener | undefined>;
  onClose: () => void;
  switches: Omit<KindSwitchesProps, 'device' | 'own' | 'everyOffText'>;
}) {
  const finalFocus = () => {
    const last = opener.current;
    if (last === undefined) {
      return null;
    }
    // A row that is gone, or a list that is no longer shown, leaves the page itself to take focus.
    const row = last.gone ? null : rowOpener(last.endpoint);
    if (row === null) {
      focusMain();
      return false;
    }
    return row;
  };
  const body = device !== undefined && (
    <>
      <Dialog.Title className="text-body font-semibold text-ink-bright">
        {device.label}
      </Dialog.Title>
      <KindSwitches
        {...switches}
        device={device}
        own={false}
        everyOffText={THAT_EVERY_KIND_OFF_TEXT}
        className={KINDS_BLOCK}
      />
      <div className="flex justify-end">
        <Dialog.Close render={<ActionButton variant="outline" className="min-h-11 px-4" />}>
          Done
        </Dialog.Close>
      </div>
    </>
  );
  const onOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };
  if (desktop) {
    return (
      <Dialog.Root open={device !== undefined} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px]" />
          <Dialog.Popup className={KINDS_DIALOG} finalFocus={finalFocus}>
            {body}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return (
    <Sheet open={device !== undefined} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        finalFocus={finalFocus}
      >
        {body}
      </SheetContent>
    </Sheet>
  );
}

/** `list` with one kind's change applied to the row for `endpoint`, every other row kept. */
const withSavedKind =
  (endpoint: string, kind: PushEventKind, muted: boolean) =>
  (list: PushDeviceList | undefined): PushDeviceList | undefined =>
    list?.state === 'listed'
      ? {
          ...list,
          devices: list.devices.map((row) =>
            row.endpoint === endpoint ? { ...row, muted: withKind(row.muted, kind, muted) } : row,
          ),
        }
      : list;

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
  const [kindsFor, setKindsFor] = useState<PushDevice | undefined>();
  // Read when the switches have closed, so it keeps the row they were for.
  const kindsOpener = useRef<KindsOpener | undefined>(undefined);
  const rowSheetOpener = useRef<string | undefined>(undefined);
  const [ownSaving, setOwnSaving] = useState(false);
  // A pending reread may answer another endpoint: until it settles, no row is this browser's.
  const heldEndpoint = subscriptionPending ? undefined : subscription?.endpoint;
  const isMine = (row: PushDevice) =>
    heldEndpoint !== undefined && sameEndpoint(row.endpoint, heldEndpoint);
  // A reread may change which row is this browser's, so a row's open sheet closes rather than act on a stale
  // match; one whose row turned out to be this browser's closes too, as those surfaces are for other browsers.
  if (
    opened !== undefined &&
    (subscriptionPending || isMine(opened) || status?.state !== 'ready')
  ) {
    setOpened(undefined);
  }
  // Another row's kinds are offered only while it is on the current key (ADR 0045, MMR-712), so they close
  // when a read shows it on an old key, or the host no longer serves a usable key.
  const onOldKey = (row: PushDevice) =>
    status?.state !== 'ready' ||
    (devices?.state === 'listed' &&
      devices.devices.some(
        (listedRow) => listedRow.endpoint === row.endpoint && !listedRow.currentKey,
      ));
  if (kindsFor !== undefined && (subscriptionPending || isMine(kindsFor) || onOldKey(kindsFor))) {
    setKindsFor(undefined);
  }

  // A save changes its row in the cached list, from the list as it is now, so saves in flight compose.
  // A list read in flight may have read before the save wrote, so it is cancelled, which reverts the
  // query at once, rather than land over the patch; a fresh read then takes its place, so the result of
  // an action's reread (a Remove, a Turn off) still arrives and includes the save. The read time stays:
  // the patch is not a list read, so it starts no needless reread of this browser's subscription.
  const onKindSaved = (endpoint: string, kind: PushEventKind, muted: boolean) => {
    const { queryKey } = pushDevicesQuery;
    const reading = client.isFetching({ queryKey }) > 0;
    void client.cancelQueries({ queryKey });
    client.setQueryData(queryKey, withSavedKind(endpoint, kind, muted), {
      updatedAt: client.getQueryState(queryKey)?.dataUpdatedAt,
    });
    if (reading) {
      void client.refetchQueries({ queryKey });
    }
  };
  const onThisGone = () => {
    setNotice({ text: THIS_BROWSER_GONE_TEXT });
    void reload();
  };
  const onThatGone = (endpoint: string) => {
    // Only the switches the save came from close: a save that answers after Done leaves another row's open.
    // The closing surface moves focus to <main>; focusing it while the surface is still open would be undone.
    const opener = kindsOpener.current;
    if (opener !== undefined && sameEndpoint(opener.endpoint, endpoint)) {
      kindsOpener.current = { ...opener, gone: true };
      setKindsFor(undefined);
    }
    setNotice({ text: THAT_BROWSER_GONE_TEXT });
    // Only the list changed: this browser's own subscription did not, so this is no action that rereads it.
    void client.invalidateQueries({ queryKey: pushDevicesQuery.queryKey });
  };
  const onChoose = (device: PushDevice) => {
    kindsOpener.current = { endpoint: device.endpoint, gone: false };
    setOpened(undefined);
    setKindsFor(device);
  };

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
  const ownRow = state.kind === 'on' && state.device.currentKey ? state.device : undefined;
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
                disabled={busy || ownSaving}
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
              disabled={ownSaving}
              onClick={() => {
                setResetOpen(true);
              }}
            >
              Reset push key…
            </ActionButton>
          </div>
        )}
      </SettingsGroup>

      {ownRow !== undefined && (
        <SettingsGroup title="Notify this device about">
          <KindSwitches
            device={ownRow}
            own
            disabled={busy}
            className={SETTINGS_CARD}
            footnote="The badge still counts everything that needs you."
            everyOffText={EVERY_KIND_OFF_TEXT}
            onSaved={onKindSaved}
            onGone={() => {
              onThisGone();
            }}
            onSavingChange={setOwnSaving}
          />
        </SettingsGroup>
      )}

      {listed !== undefined && (
        <SettingsGroup title={`Subscribed browsers · ${String(listed.length)}`}>
          {listed.length === 0 ? (
            <p className="px-1 text-xs text-ink-dim">No browser is subscribed.</p>
          ) : (
            <ul className={SETTINGS_CARD}>
              {listed.map((device) => {
                const mine = isMine(device);
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
                          onChoose={onChoose}
                          onTest={(row) => void onTestRow(row)}
                          onRemove={(row) => void onRemoveRow(row)}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-push-row={device.endpoint}
                        aria-label={`${device.label}, ${meta.text}`}
                        className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-well-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                        onClick={() => {
                          rowSheetOpener.current = device.endpoint;
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
            disabled={ownSaving}
            onClick={() => {
              setResetOpen(true);
            }}
          >
            Reset push key…
          </button>
        </div>
      )}

      <RowSheet
        opener={rowSheetOpener}
        device={
          desktop || opened === undefined
            ? undefined
            : (listed?.find((row) => row.endpoint === opened.endpoint) ?? opened)
        }
        onClose={() => {
          setOpened(undefined);
        }}
        onChoose={onChoose}
        onTest={(row) => void onTestRow(row)}
        onRemove={(row) => void onRemoveRow(row)}
      />
      <KindsSurface
        device={
          kindsFor === undefined
            ? undefined
            : (listed?.find((row) => row.endpoint === kindsFor.endpoint) ?? kindsFor)
        }
        desktop={desktop}
        opener={kindsOpener}
        onClose={() => {
          setKindsFor(undefined);
        }}
        switches={{ onGone: onThatGone, onSaved: onKindSaved }}
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
