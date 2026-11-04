import { Dialog } from '@base-ui-components/react/dialog';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { T3System } from '../api/fns/t3';
import { broadestMode, defaultOptions, startingChoice } from '../lib/t3-defaults';
import type { LaunchChoice, RememberedChoice } from '../lib/t3-defaults';
import { T3_RUNTIME_MODES } from '../server/t3-states';
import type { T3Model, T3OptionChoice, T3RuntimeMode } from '../server/t3-states';
import { ActionButton } from './ui/action-button';
import { SegmentedControl } from './ui/segmented-control';

type ReachableSystem = Extract<T3System, { status: 'reachable' }>;

const FIELD_CLASS =
  'min-w-0 rounded border border-line bg-well-850 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-accent';

const RUNTIME_LABELS: Record<T3RuntimeMode, string> = {
  'approval-required': 'Approval required',
  auto: 'Auto',
  'auto-accept-edits': 'Auto-accept edits',
  'full-access': 'Full access',
};

/** One labelled row of the form's two-column grid (one column on a phone). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="microlabel pt-1.5 text-ink-faint sm:text-right">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </>
  );
}

const modelValue = (instanceId: string, model: string) => JSON.stringify([instanceId, model]);

/** The chosen options in the model's own order, with `chosen` replacing or removing one. */
function withOption(
  model: T3Model | undefined,
  current: T3OptionChoice[],
  id: string,
  value: T3OptionChoice['value'] | undefined,
): T3OptionChoice[] {
  const next = new Map(current.map((option) => [option.id, option.value]));
  if (value === undefined) {
    next.delete(id);
  } else {
    next.set(id, value);
  }
  return (model?.options ?? []).flatMap((option) => {
    const chosen = next.get(option.id);
    return chosen === undefined ? [] : [{ id: option.id, value: chosen }];
  });
}

/** A model option's id as words: T3 names options in camelCase (`reasoningEffort` → "Reasoning effort"). */
export function optionLabel(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One model option with values: a checkbox for a boolean one, else a segmented
 * choice. Only an option with no usable default offers "Unset", which leaves it
 * out of the launch; an option with one starts on it (ADR 0040, Defaults).
 */
function OptionField({
  option,
  chosen,
  onChange,
}: {
  option: T3Model['options'][number];
  chosen: T3OptionChoice['value'] | undefined;
  onChange: (value: T3OptionChoice['value'] | undefined) => void;
}) {
  if (option.values.every((value) => typeof value === 'boolean') && option.values.includes(true)) {
    return (
      <Row label={optionLabel(option.id)}>
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            aria-label={optionLabel(option.id)}
            checked={chosen === true}
            onChange={(e) => {
              const off = option.values.includes(false) ? false : undefined;
              onChange(e.target.checked ? true : off);
            }}
          />
          On
        </label>
      </Row>
    );
  }
  const index = chosen === undefined ? -1 : option.values.indexOf(chosen);
  const hasDefault = option.default !== null && option.values.includes(option.default);
  return (
    <Row label={optionLabel(option.id)}>
      <SegmentedControl
        ariaLabel={optionLabel(option.id)}
        value={index === -1 ? '' : String(index)}
        onChange={(next) => {
          onChange(next === '' ? undefined : option.values[Number(next)]);
        }}
        options={[
          ...(hasDefault ? [] : [{ label: 'Unset', value: '' }]),
          ...option.values.map((value, i) => ({ label: String(value), value: String(i) })),
        ]}
      />
    </Row>
  );
}

/**
 * The launch's settings (ADR 0040, Defaults): every choice a launch takes,
 * started from the chosen system's defaults. Workspace and plan mode sit under
 * Advanced. It hands back a complete choice; the caller adds the task and the
 * attempt.
 */
export function T3LaunchDialog({
  taskId,
  systems,
  remembered,
  initialEnvironmentId,
  onLaunch,
  onClose,
}: {
  taskId: string;
  systems: readonly ReachableSystem[];
  remembered: RememberedChoice | null;
  initialEnvironmentId?: string;
  onLaunch: (choice: LaunchChoice) => void;
  onClose: () => void;
}) {
  // The menu's pick, else the configured server, else the first reachable system.
  const first =
    systems.find((s) => s.environmentId === initialEnvironmentId) ??
    systems.find((s) => s.configured) ??
    systems[0];
  const [choice, setChoice] = useState<LaunchChoice | null>(
    first === undefined ? null : startingChoice(first, remembered),
  );
  const [environmentId, setEnvironmentId] = useState(first?.environmentId ?? '');
  const [branch, setBranch] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const system = systems.find((s) => s.environmentId === environmentId);
  const provider = system?.providers.find((p) => p.providerInstanceId === choice?.model.instanceId);
  const model = provider?.models.find((m) => m.id === choice?.model.model);
  const complete =
    choice !== null &&
    choice.projectId !== '' &&
    model !== undefined &&
    provider?.runtimeModes.includes(choice.runtimeMode) === true;

  function chooseSystem(next: string) {
    const target = systems.find((s) => s.environmentId === next);
    setEnvironmentId(next);
    setChoice(target === undefined ? null : startingChoice(target, remembered));
  }

  function chooseModel(value: string) {
    const nextProvider = system?.providers.find((p) =>
      p.models.some((m) => modelValue(p.providerInstanceId, m.id) === value),
    );
    const id = nextProvider?.models.find(
      (m) => modelValue(nextProvider.providerInstanceId, m.id) === value,
    )?.id;
    if (choice === null || system === undefined || nextProvider === undefined || id === undefined) {
      return;
    }
    const instanceId = nextProvider.providerInstanceId;
    setChoice({
      ...choice,
      model: { instanceId, model: id, options: defaultOptions(system, { instanceId, model: id }) },
      runtimeMode: nextProvider.runtimeModes.includes(choice.runtimeMode)
        ? choice.runtimeMode
        : (broadestMode(nextProvider) ?? choice.runtimeMode),
    });
  }

  function submit() {
    if (choice === null || !complete) {
      return;
    }
    const trimmed = branch.trim();
    onLaunch({
      ...choice,
      workspace:
        choice.workspace.type === 'worktree' && trimmed !== ''
          ? { branch: trimmed, type: 'worktree' }
          : choice.workspace,
    });
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-well-950/70 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[92vh] w-[min(94vw,460px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-well-900 p-4 shadow-2xl outline-none">
          <Dialog.Title className="text-sm font-semibold text-ink-bright">
            Launch {taskId} in T3
          </Dialog.Title>
          <div className="grid grid-cols-1 items-start gap-x-3 gap-y-2.5 sm:grid-cols-[96px_1fr]">
            <Row label="System">
              <select
                aria-label="System"
                className={FIELD_CLASS}
                value={environmentId}
                onChange={(e) => {
                  chooseSystem(e.target.value);
                }}
              >
                {systems.map((s) => (
                  <option key={s.environmentId} value={s.environmentId}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Row>
            {system !== undefined && system.projects.length > 1 && choice !== null && (
              <Row label="Project">
                <select
                  aria-label="Project"
                  className={FIELD_CLASS}
                  value={choice.projectId}
                  onChange={(e) => {
                    setChoice({ ...choice, projectId: e.target.value });
                  }}
                >
                  <option value="">Choose a project…</option>
                  {system.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </Row>
            )}
            {system !== undefined && choice === null && (
              <p className="col-span-full text-xs text-ink-dim">
                {system.label} offers no model to launch with.
              </p>
            )}
            {system !== undefined && choice !== null && (
              <>
                <Row label="Model">
                  <select
                    aria-label="Model"
                    className={FIELD_CLASS}
                    value={modelValue(choice.model.instanceId, choice.model.model)}
                    onChange={(e) => {
                      chooseModel(e.target.value);
                    }}
                  >
                    {system.providers.map((p) => (
                      <optgroup key={p.providerInstanceId} label={p.displayName}>
                        {p.models.map((m) => (
                          <option key={m.id} value={modelValue(p.providerInstanceId, m.id)}>
                            {m.label ?? m.id}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Row>
                {(model?.options ?? [])
                  .filter((option) => option.values.length > 0)
                  .map((option) => (
                    <OptionField
                      key={option.id}
                      option={option}
                      chosen={choice.model.options.find((o) => o.id === option.id)?.value}
                      onChange={(value) => {
                        setChoice({
                          ...choice,
                          model: {
                            ...choice.model,
                            options: withOption(model, choice.model.options, option.id, value),
                          },
                        });
                      }}
                    />
                  ))}
                <Row label="Runtime">
                  <select
                    aria-label="Runtime mode"
                    className={FIELD_CLASS}
                    value={choice.runtimeMode}
                    onChange={(e) => {
                      setChoice({
                        ...choice,
                        runtimeMode:
                          T3_RUNTIME_MODES.find((m) => m === e.target.value) ?? choice.runtimeMode,
                      });
                    }}
                  >
                    {T3_RUNTIME_MODES.filter((mode) => provider?.runtimeModes.includes(mode)).map(
                      (mode) => (
                        <option key={mode} value={mode}>
                          {RUNTIME_LABELS[mode]}
                        </option>
                      ),
                    )}
                  </select>
                </Row>
              </>
            )}
          </div>
          {choice !== null && (
            <div className="flex flex-col gap-2.5 border-t border-dashed border-line-bright pt-2.5">
              <button
                type="button"
                aria-expanded={advanced}
                onClick={() => {
                  setAdvanced(!advanced);
                }}
                className="microlabel self-start text-ink-dim hover:text-ink"
              >
                Advanced
              </button>
              {advanced && (
                <div className="grid grid-cols-1 items-start gap-x-3 gap-y-2.5 sm:grid-cols-[96px_1fr]">
                  <Row label="Workspace">
                    <SegmentedControl
                      ariaLabel="Workspace"
                      value={choice.workspace.type}
                      onChange={(type) => {
                        setChoice({ ...choice, workspace: { type } });
                      }}
                      options={[
                        { label: 'Project checkout', value: 'root' },
                        { label: 'New worktree', value: 'worktree' },
                      ]}
                    />
                  </Row>
                  {choice.workspace.type === 'worktree' && (
                    <Row label="Branch">
                      <input
                        aria-label="Branch"
                        value={branch}
                        placeholder="Optional new branch"
                        onChange={(e) => {
                          setBranch(e.target.value);
                        }}
                        className={`${FIELD_CLASS} w-full font-mono`}
                      />
                    </Row>
                  )}
                  <Row label="Mode">
                    <label className="flex items-center gap-2 text-xs text-ink">
                      <input
                        type="checkbox"
                        checked={choice.interactionMode === 'plan'}
                        onChange={(e) => {
                          setChoice({
                            ...choice,
                            interactionMode: e.target.checked ? 'plan' : 'default',
                          });
                        }}
                      />
                      Plan first
                    </label>
                  </Row>
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close className="rounded px-3 py-1.5 text-xs text-ink-dim hover:text-ink">
              Cancel
            </Dialog.Close>
            <ActionButton size="sm" disabled={!complete} onClick={submit}>
              Launch
            </ActionButton>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
