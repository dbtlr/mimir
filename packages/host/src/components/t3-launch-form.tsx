import { useState } from 'react';

import type { T3System } from '../api/fns/t3';
import { broadestMode, defaultOptions, startingChoice } from '../lib/t3-defaults';
import type { LaunchChoice, RememberedChoice } from '../lib/t3-defaults';
import { T3_RUNTIME_MODES } from '../server/t3-states';
import type { T3Model, T3OptionChoice, T3RuntimeMode } from '../server/t3-states';
import {
  FormCheckRow,
  FormField,
  FormGroup,
  FormSheet,
  FormTextInput,
} from './patterns/form-sheet';
import type { FinalFocus } from './patterns/opener';
import { SegmentedControl } from './ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
} from './ui/select';

type ReachableSystem = Extract<T3System, { status: 'reachable' }>;

const RUNTIME_LABELS: Record<T3RuntimeMode, string> = {
  'approval-required': 'Approval required',
  auto: 'Auto',
  'auto-accept-edits': 'Auto-accept edits',
  'full-access': 'Full access',
};

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
 * A model shown as T3 names it: its product name in sans ("Sonnet 5.5"), or,
 * with none, its identifier in mono (`gpt-6.1-sol`), as identifiers always are.
 */
function ModelName({ model }: { model: T3Model }) {
  return model.label === null ? (
    <span className="font-mono [font-size-adjust:var(--mono-adjust)]">{model.id}</span>
  ) : (
    <>{model.label}</>
  );
}

/** A system's label is its host's name, an identifier, so it is mono. */
function SystemName({ label }: { label: string }) {
  return <span className="font-mono [font-size-adjust:var(--mono-adjust)]">{label}</span>;
}

/**
 * One model option with values: a checkbox row for a boolean one, else a
 * Segmented Control of the provider's values, verbatim (`low`, `medium`,
 * `high`). Only an option with no usable default offers "Unset", which leaves
 * it out of the launch; an option with one starts on it (ADR 0040, Defaults).
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
  const label = optionLabel(option.id);
  if (option.values.every((value) => typeof value === 'boolean') && option.values.includes(true)) {
    return (
      <FormCheckRow
        label={label}
        checked={chosen === true}
        onCheckedChange={(checked) => {
          const off = option.values.includes(false) ? false : undefined;
          onChange(checked ? true : off);
        }}
      />
    );
  }
  const index = chosen === undefined ? -1 : option.values.indexOf(chosen);
  const hasDefault = option.default !== null && option.values.includes(option.default);
  return (
    <FormField label={label}>
      <SegmentedControl
        size="field"
        ariaLabel={label}
        value={index === -1 ? '' : String(index)}
        onChange={(next) => {
          onChange(next === '' ? undefined : option.values[Number(next)]);
        }}
        options={[
          ...(hasDefault ? [] : [{ label: 'Unset', value: '' }]),
          ...option.values.map((value, i) => ({ label: String(value), value: String(i) })),
        ]}
      />
    </FormField>
  );
}

export type T3LaunchFormProps = {
  open: boolean;
  taskId: string;
  /** The task's title, after its id in the context line. */
  taskTitle: string;
  systems: readonly ReachableSystem[];
  remembered: RememberedChoice | null;
  initialEnvironmentId?: string;
  onLaunch: (choice: LaunchChoice) => void;
  onClose: () => void;
  /** Where focus returns on close: the control that asked for the settings. */
  finalFocus?: FinalFocus;
};

/**
 * The T3 launch form (ADR 0040, Defaults; MMR-743): every choice a launch
 * takes, started from the chosen system's defaults, in the Form sheet. The
 * common fields fit above the commit; Workspace, Branch (for a new worktree
 * only), and plan mode sit under Advanced, folded at first. It hands back a
 * complete choice; the caller adds the task and the attempt.
 */
export function T3LaunchForm({
  open,
  taskId,
  taskTitle,
  systems,
  remembered,
  initialEnvironmentId,
  onLaunch,
  onClose,
  finalFocus,
}: T3LaunchFormProps) {
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

  const system = systems.find((s) => s.environmentId === environmentId);
  const provider = system?.providers.find((p) => p.providerInstanceId === choice?.model.instanceId);
  const model = provider?.models.find((m) => m.id === choice?.model.model);
  const project = system?.projects.find((p) => p.id === choice?.projectId);
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

  function launch() {
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
    <FormSheet
      open={open}
      onClose={onClose}
      title="Launch in T3"
      context={
        <>
          <span className="mr-2 font-mono">{taskId}</span>
          {taskTitle}
        </>
      }
      commitLabel="Launch"
      commitDisabled={!complete}
      finalFocus={finalFocus}
      onCommit={launch}
    >
      <FormField label="System">
        <Select<string>
          value={environmentId}
          onValueChange={(next) => {
            if (next !== null) {
              chooseSystem(next);
            }
          }}
        >
          <SelectTrigger>
            {system === undefined ? null : <SystemName label={system.label} />}
          </SelectTrigger>
          <SelectContent label="System">
            {systems.map((s) => (
              <SelectItem key={s.environmentId} value={s.environmentId} label={s.label}>
                <SystemName label={s.label} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {system !== undefined && system.projects.length > 1 && choice !== null && (
        <FormField label="Project">
          <Select<string>
            value={choice.projectId === '' ? null : choice.projectId}
            onValueChange={(next) => {
              if (next !== null) {
                setChoice({ ...choice, projectId: next });
              }
            }}
          >
            <SelectTrigger>
              {project?.title ?? <span className="text-ink-dim">Choose a project…</span>}
            </SelectTrigger>
            <SelectContent label="Project">
              {system.projects.map((p) => (
                <SelectItem key={p.id} value={p.id} label={p.title}>
                  {p.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}
      {system !== undefined && choice === null && (
        <p className="text-meta text-ink-dim">{system.label} offers no model to launch with.</p>
      )}
      {system !== undefined && choice !== null && (
        <>
          <FormField label="Model">
            <Select<string>
              value={modelValue(choice.model.instanceId, choice.model.model)}
              onValueChange={(next) => {
                if (next !== null) {
                  chooseModel(next);
                }
              }}
            >
              <SelectTrigger>
                {model === undefined ? null : <ModelName model={model} />}
              </SelectTrigger>
              <SelectContent label="Model">
                {system.providers.map((p) => (
                  <SelectGroup key={p.providerInstanceId}>
                    <SelectGroupLabel>{p.displayName}</SelectGroupLabel>
                    {p.models.map((m) => (
                      <SelectItem
                        key={m.id}
                        value={modelValue(p.providerInstanceId, m.id)}
                        label={m.label ?? m.id}
                      >
                        <ModelName model={m} />
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </FormField>
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
          <FormField label="Runtime">
            <Select<string>
              value={choice.runtimeMode}
              onValueChange={(next) => {
                const mode = T3_RUNTIME_MODES.find((m) => m === next);
                if (mode !== undefined) {
                  setChoice({ ...choice, runtimeMode: mode });
                }
              }}
            >
              <SelectTrigger>
                {RUNTIME_LABELS[choice.runtimeMode]}
              </SelectTrigger>
              <SelectContent label="Runtime">
                {T3_RUNTIME_MODES.filter((mode) => provider?.runtimeModes.includes(mode)).map(
                  (mode) => (
                    <SelectItem key={mode} value={mode} label={RUNTIME_LABELS[mode]}>
                      {RUNTIME_LABELS[mode]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </FormField>
          <FormGroup title="Advanced" collapsible>
            <FormField label="Workspace">
              <SegmentedControl
                size="field"
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
            </FormField>
            {choice.workspace.type === 'worktree' && (
              <FormField label="Branch" optional>
                <FormTextInput
                  value={branch}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setBranch(event.target.value);
                  }}
                  className="font-mono"
                />
              </FormField>
            )}
            <FormCheckRow
              label="Plan first"
              checked={choice.interactionMode === 'plan'}
              onCheckedChange={(checked) => {
                setChoice({ ...choice, interactionMode: checked ? 'plan' : 'default' });
              }}
            />
          </FormGroup>
        </>
      )}
    </FormSheet>
  );
}
