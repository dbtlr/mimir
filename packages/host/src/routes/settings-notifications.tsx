import { CancelledError, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';

import type { PushDevice, PushDeviceList, PushEventKind } from '../api/fns/push';
import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import { ACTION_MENU_ANCHORED_QUERY, ActionMenu } from '../components/patterns/action-menu';
import type { ActionMenuEntry } from '../components/patterns/action-menu';
import { ContentSheet } from '../components/patterns/content-sheet';
import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import { KindSwitches } from '../components/push-kind-switches';
import type { KindSwitchesProps } from '../components/push-kind-switches';
import { SETTINGS_CARD, SettingsGroup, SettingsPage } from '../components/settings-page';
import { ActionButton } from '../components/ui/action-button';
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

/**
 * `/settings/notifications` — this browser's Web Push control and every
 * subscribed browser (ADR 0045, MMR-711). The row for this browser holds Turn
 * on or Turn off; its sentence, and the answer to each action, sit under the
 * group. While this browser is on, "Notify this device about" holds a switch
 * per event kind (ADR 0045, MMR-712). Another browser's row opens its Action
 * menu: below `md` the row is a full-width button and the menu a sheet; from
 * `md` up the row has a ••• button and the menu is anchored to it, switching
 * where the pattern does. On a current-key row, "Choose what notifies…" opens
 * that row's switches in their own sheet. Turn on and Turn off live in
 * `usePushControl`; the page places their answers.
 */

const TEXT_BUTTON =
  'inline-flex min-h-11 items-center rounded px-1 text-meta text-ink-dim hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent';

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

/** The Destructive confirm for resetting the push key. */
function ResetConfirm({
  open,
  onOpenChange,
  onConfirm,
  commitDisabled,
  refusal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
  commitDisabled: boolean;
  refusal: string | undefined;
}) {
  return (
    <DestructiveConfirm
      open={open}
      onClose={() => {
        onOpenChange(false);
      }}
      title="Reset the push key?"
      commitLabel="Reset"
      commitDisabled={commitDisabled}
      notice={refusal}
      // A reset closes the dialog itself; a refusal stays, as the notice.
      closeOnCommit={false}
      onConfirm={onConfirm}
    >
      Every device stops receiving notifications until its console is opened again, and then
      subscribes again.
    </DestructiveConfirm>
  );
}

/**
 * The Action menu of one other browser (ADR 0019, MMR-736): a bottom sheet on
 * a phone, headed by the row's label and meta, and an anchored menu on a
 * desktop. `trigger` is the row on a phone and the ••• button on a desktop.
 * The menu returns focus to its trigger; Choose's switches and Remove's
 * confirm take it from there and send it back to the row when they close.
 */
function RowActions({
  device,
  trigger,
  open,
  onOpenChange,
  onChoose,
  onTest,
  onRemove,
}: {
  device: PushDevice;
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (device: PushDevice) => void;
  onTest: (device: PushDevice) => void;
  onRemove: (device: PushDevice) => void;
}) {
  const entries: ActionMenuEntry[] = [];
  if (device.currentKey) {
    entries.push(
      {
        key: 'choose',
        kind: 'action',
        label: 'Choose what notifies…',
        onSelect: () => {
          onChoose(device);
        },
      },
      {
        key: 'test',
        kind: 'action',
        label: 'Send test notification',
        onSelect: () => {
          onTest(device);
        },
      },
    );
  }
  entries.push({
    destructive: true,
    key: 'remove',
    kind: 'action',
    label: 'Remove this browser',
    onSelect: () => {
      onRemove(device);
    },
  });
  return (
    <ActionMenu
      title={device.label}
      description={deviceMeta(device, { thisDevice: false }).text}
      trigger={trigger}
      entries={entries}
      finalFocus={afterRemoveFocus(device.endpoint)}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

/** Move focus to the page's `<main>` and name it, for a `finalFocus` whose row is gone. */
const focusPage = (): HTMLElement | null => {
  focusMain();
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
};

/** Whether a dialog, such as a confirm still closing, holds focus: it returns focus itself. */
const focusInDialog = () =>
  document.activeElement?.closest('[role="dialog"], [role="alertdialog"]') != null;

/**
 * Give focus back to a row once the list has `settled` after an action, as a
 * fallback. An action's reread redraws the rows and hides their triggers, so
 * the trigger that held focus, or that a closing surface returned it to, is
 * gone meanwhile, and focus falls to `<body>`, or UI SDK moves it to a nearby
 * control. When the list settles, focus goes to the row, or the page when the
 * row is gone, unless a dialog holds it. Request it as the action is chosen:
 * a press or key from then on cancels it, so focus the operator moved stays.
 * The request returns `land`, to call once the action's reread has started.
 */
function useFocusBackToRow(settled: boolean) {
  const request = useRef<{ endpoint: string; landing: boolean } | undefined>(undefined);
  const stop = useRef<() => void>(() => undefined);
  // A landing request renders again, so the effect below sees it.
  const [, setLandings] = useState(0);
  useEffect(() => {
    if (settled && request.current?.landing === true) {
      if (!focusInDialog()) {
        const row = rowOpener(request.current.endpoint);
        if (row === null) {
          focusMain();
        } else {
          row.focus();
        }
      }
      stop.current();
    }
  });
  return (endpoint: string) => {
    stop.current();
    const own = { endpoint, landing: false };
    request.current = own;
    const release = () => {
      if (request.current === own) {
        request.current = undefined;
      }
      document.removeEventListener('pointerdown', release, true);
      document.removeEventListener('keydown', release, true);
    };
    document.addEventListener('pointerdown', release, true);
    document.addEventListener('keydown', release, true);
    stop.current = release;
    return () => {
      if (request.current === own) {
        own.landing = true;
        setLandings((count) => count + 1);
      }
    };
  };
}

/** Where focus goes when another browser's menu or its Remove confirm closes: its row, or the page once the row is gone. */
const afterRemoveFocus = (endpoint: string) => () => {
  const row = rowOpener(endpoint);
  return row ?? focusPage();
};

/** The Destructive confirm for removing another browser (ADR 0019, rule 5): its subscription cannot be restored from here. */
function RemoveConfirm({
  device,
  onClose,
  onConfirm,
}: {
  device: PushDevice | undefined;
  onClose: () => void;
  onConfirm: (device: PushDevice) => Promise<void>;
}) {
  // The last device stays through the close, so the dialog keeps its text while it leaves.
  const [shown, setShown] = useState(device);
  if (device !== undefined && device !== shown) {
    setShown(device);
  }
  return (
    <DestructiveConfirm
      open={device !== undefined}
      onClose={onClose}
      title={`Remove ${shown?.label ?? 'this browser'}?`}
      commitLabel="Remove this browser"
      finalFocus={shown === undefined ? undefined : afterRemoveFocus(shown.endpoint)}
      onConfirm={async () => {
        if (device !== undefined) {
          await onConfirm(device);
        }
      }}
    >
      It stops receiving notifications from this console, and this cannot be undone from here.
    </DestructiveConfirm>
  );
}

// Hairline-separated rows on the sheet itself, never a card inside it (ADR 0019, MMR-743),
// their text on the sheet's own edge. The list scrolls on a short screen, so every switch
// stays reachable above Done.
const KINDS_BLOCK = 'min-h-0 overflow-y-auto [&_label]:px-0';

/** The row that opened another browser's switches, for Done to return focus to. */
const rowOpener = (endpoint: string) =>
  document.querySelector<HTMLElement>(`[data-push-row="${CSS.escape(endpoint)}"]`);

/** Which opening of the switches this is, the row it was for, and whether the host answered that it is gone. */
type KindsOpener = { id: number; endpoint: string; gone: boolean };

/**
 * Another browser's switches (ADR 0045, MMR-712): a Sheet titled with the
 * row's label, from the bottom on a phone and a panel from the right on a
 * desktop (ADR 0019's MMR-736 refinement). Done closes it and
 * returns focus to the row that opened it; after `not_found` focus goes to
 * the page's `<main>`. `opener` outlives the close, when `device` is gone.
 */
function KindsSurface({
  device,
  opener,
  onClose,
  switches,
}: {
  device: PushDevice | undefined;
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
      // The page's main takes focus; hand it back as the target, so the sheet's close keeps it there.
      focusMain();
      return document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    return row;
  };
  // The title stays through the close, while `device` is already gone.
  const [title, setTitle] = useState(device?.label ?? '');
  if (device !== undefined && device.label !== title) {
    setTitle(device.label);
  }
  return (
    <ContentSheet
      open={device !== undefined}
      onClose={onClose}
      title={title}
      finalFocus={finalFocus}
    >
      {device !== undefined && (
        <KindSwitches
          {...switches}
          device={device}
          own={false}
          everyOffText={THAT_EVERY_KIND_OFF_TEXT}
          className={KINDS_BLOCK}
        />
      )}
    </ContentSheet>
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

/** How many times a heal reads the device list when saves keep cancelling the read. */
const DEVICES_READ_ATTEMPTS = 3;

export function NotificationsPage() {
  const client = useQueryClient();
  // The row's shape follows the Action menu's: a ••• button where the menu is anchored, the row itself where it is a sheet.
  const desktop = useMediaQuery(ACTION_MENU_ANCHORED_QUERY);
  const control = usePushControl();
  const { browser, busy, devices, identity, notice, reload, setNotice, state, status } = control;
  const { devicesFailed, retryDevices, subscription, subscriptionPending, whileBusy } = control;
  const [rowNotes, setRowNotes] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<PushDevice | undefined>();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetRefusal, setResetRefusal] = useState<string | undefined>();
  const [kindsFor, setKindsFor] = useState<PushDevice | undefined>();
  // Each opening of the switches gets its own id, so a late answer to a save closes only its own opening.
  const [kindsOpening, setKindsOpening] = useState(0);
  // Read when the switches have closed, so it keeps the row they were for.
  const kindsOpener = useRef<KindsOpener | undefined>(undefined);
  const [removing, setRemoving] = useState<PushDevice | undefined>();
  // Set from Confirm until the Remove confirm closes: its own reread must not close it as stale.
  const [removeRunning, setRemoveRunning] = useState(false);
  // The list redraws after a Send test or a failed Remove, which can drop focus from the row, so focus
  // goes back to it once the redraw settles, unless the operator has moved on by then.
  const returnFocusToRow = useFocusBackToRow(!subscriptionPending);
  const [ownSaving, setOwnSaving] = useState(false);
  // A pending reread may answer another endpoint: until it settles, no row is this browser's.
  const heldEndpoint = subscriptionPending ? undefined : subscription?.endpoint;
  const isMine = (row: PushDevice) =>
    heldEndpoint !== undefined && sameEndpoint(row.endpoint, heldEndpoint);
  // A reread may change which row is this browser's, so a row's open sheet closes rather than act on a stale
  // match; one whose row turned out to be this browser's closes too, as those surfaces are for other browsers.
  const staleRow = (row: PushDevice) =>
    subscriptionPending || isMine(row) || status?.state !== 'ready';
  if (opened !== undefined && staleRow(opened)) {
    setOpened(undefined);
  }
  // The Remove confirm closes on the same reads, except while its own commit runs and rereads.
  if (removing !== undefined && !removeRunning && staleRow(removing)) {
    setRemoving(undefined);
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
  const onThatGone = (opening: number) => {
    // Only the opening the save came from closes: a save that answers after Done leaves a later opening alone,
    // another row's or the same row's. Focus then goes to <main> as the surface closes, not while it is open.
    const opener = kindsOpener.current;
    if (opener?.id === opening) {
      kindsOpener.current = { ...opener, gone: true };
      setKindsFor(undefined);
    }
    setNotice({ text: THAT_BROWSER_GONE_TEXT });
    // Only the list changed: this browser's own subscription did not, so this is no action that rereads it.
    void client.invalidateQueries({ queryKey: pushDevicesQuery.queryKey });
  };
  const onChoose = (device: PushDevice) => {
    const opening = kindsOpening + 1;
    setKindsOpening(opening);
    kindsOpener.current = { endpoint: device.endpoint, gone: false, id: opening };
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
    const land = returnFocusToRow(device.endpoint);
    setOpened(undefined);
    note(device.endpoint, 'Sending a test…');
    const result = await runTest(device.endpoint);
    land();
    note(device.endpoint, result);
  };
  const onRemoveRow = async (device: PushDevice) => {
    setRemoveRunning(true);
    let failed = false;
    try {
      await removeBrowser(device.endpoint);
    } catch {
      failed = true;
      note(device.endpoint, "That browser couldn't be removed. Try again.");
    }
    await reload();
    // The row stays, but the reread hides its trigger as the confirm closes, so focus comes back to it.
    // The confirm holds focus until then, so the request starts here and lands at once.
    if (failed) {
      returnFocusToRow(device.endpoint)();
    }
  };

  /**
   * A fresh device list. A saved kind cancels the read in flight with revert and starts another
   * (onKindSaved). TanStack resolves a cancelled read that started here with the list the query held, when
   * it held one; only a read joined here, one a poll or an action started, rejects with a CancelledError.
   * That read is read again, up to DEVICES_READ_ATTEMPTS times; any other error is thrown at once.
   */
  const readDevicesFresh = async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- a read starts only after the one before it was cancelled
        return await client.fetchQuery({ ...pushDevicesQuery, staleTime: 0 });
      } catch (error) {
        if (!(error instanceof CancelledError) || attempt === DEVICES_READ_ATTEMPTS) {
          throw error;
        }
      }
    }
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
        readDevicesFresh(),
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
                const rowActions = (trigger: ReactElement) => (
                  <RowActions
                    device={device}
                    trigger={trigger}
                    open={opened?.endpoint === device.endpoint}
                    onOpenChange={(next) => {
                      setOpened(next ? device : undefined);
                    }}
                    onChoose={onChoose}
                    onTest={(row) => void onTestRow(row)}
                    onRemove={setRemoving}
                  />
                );
                return (
                  <li key={device.endpoint}>
                    {desktop ? (
                      <div className="flex min-h-14 items-center gap-3 py-2.5 pr-3 pl-4">
                        {text}
                        {rowActions(
                          <button
                            type="button"
                            data-push-row={device.endpoint}
                            aria-label={`Actions for ${device.label}`}
                            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-dim hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            <span aria-hidden>•••</span>
                          </button>,
                        )}
                      </div>
                    ) : (
                      rowActions(
                        <button
                          type="button"
                          data-push-row={device.endpoint}
                          aria-label={`${device.label}, ${meta.text}`}
                          className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-well-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                        >
                          {text}
                          <span aria-hidden className="text-ink-faint">
                            ›
                          </span>
                        </button>,
                      )
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

      <RemoveConfirm
        device={removing}
        onClose={() => {
          setRemoving(undefined);
          setRemoveRunning(false);
        }}
        onConfirm={onRemoveRow}
      />
      <KindsSurface
        device={
          kindsFor === undefined
            ? undefined
            : (listed?.find((row) => row.endpoint === kindsFor.endpoint) ?? kindsFor)
        }
        opener={kindsOpener}
        onClose={() => {
          setKindsFor(undefined);
        }}
        switches={{
          onGone: () => {
            onThatGone(kindsOpening);
          },
          onSaved: onKindSaved,
        }}
      />
      <ResetConfirm
        open={resetOpen}
        onOpenChange={(open) => {
          setResetOpen(open);
          if (!open) {
            setResetRefusal(undefined);
          }
        }}
        onConfirm={onReset}
        commitDisabled={busy}
        refusal={resetRefusal}
      />
    </SettingsPage>
  );
}
