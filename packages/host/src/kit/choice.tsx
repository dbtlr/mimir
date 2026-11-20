import { useState } from 'react';

import { Checkbox } from '../components/ui/checkbox';
import { Radio, RadioGroup } from '../components/ui/radio';
import { SegmentedControl } from '../components/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Sample, Section } from './section';

type Theme = 'system' | 'light' | 'dark';

const THEMES = [
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
] as const;

const STATUSES = [
  { label: 'New', value: 'new' },
  { label: 'Ready', value: 'ready' },
  { label: 'In progress', value: 'in-progress' },
  { label: 'Under review', value: 'under-review' },
  { label: 'Staged', value: 'staged' },
  { label: 'Blocked', value: 'blocked' },
  { disabled: true, label: 'Parked', value: 'parked' },
  { label: 'Done', value: 'done' },
];

const LABEL_CLASS = 'flex items-center gap-2 text-meta text-ink';

/** Segmented Control, Radio, Checkbox, Switch, and Select: the Choice primitives. */
export function ChoiceKit() {
  const [theme, setTheme] = useState<Theme>('system');
  return (
    <>
      <Section title="Segmented Control">
        <Sample label="segmented control · Appearance theme">
          <SegmentedControl ariaLabel="Theme" options={THEMES} value={theme} onChange={setTheme} />
        </Sample>
      </Section>
      <Section title="Radio">
        <Sample label="radio · labelled group (checked, unchecked, disabled)">
          <RadioGroup
            aria-label="Grooming mode"
            defaultValue="note"
            className="flex flex-col gap-2"
          >
            <label htmlFor="kit-radio-note" className={LABEL_CLASS}>
              <Radio id="kit-radio-note" value="note" />
              Leave a note on MMR-219
            </label>
            <label htmlFor="kit-radio-split" className={LABEL_CLASS}>
              <Radio id="kit-radio-split" value="split" />
              Split it into two tasks
            </label>
            <label htmlFor="kit-radio-park" className={`${LABEL_CLASS} opacity-60`}>
              <Radio id="kit-radio-park" value="park" disabled />
              Park until the release
            </label>
          </RadioGroup>
        </Sample>
      </Section>
      <Section title="Checkbox">
        <Sample label="checkbox · unchecked, checked, indeterminate, disabled">
          <label htmlFor="kit-check-off" className={LABEL_CLASS}>
            <Checkbox id="kit-check-off" />
            Create another
          </label>
          <label htmlFor="kit-check-on" className={LABEL_CLASS}>
            <Checkbox id="kit-check-on" defaultChecked />
            Create another
          </label>
          <label htmlFor="kit-check-mixed" className={LABEL_CLASS}>
            <Checkbox id="kit-check-mixed" defaultChecked="indeterminate" />
            Select all in MMR-700
          </label>
          <label htmlFor="kit-check-disabled" className={`${LABEL_CLASS} opacity-60`}>
            <Checkbox id="kit-check-disabled" disabled />
            Create another
          </label>
        </Sample>
      </Section>
      <Section title="Switch">
        <Sample label="switch · notification kinds (on, off, disabled)">
          <label htmlFor="kit-switch-needs-you" className={LABEL_CLASS}>
            <Switch id="kit-switch-needs-you" defaultChecked />
            Needs you
          </label>
          <label htmlFor="kit-switch-shipped" className={LABEL_CLASS}>
            <Switch id="kit-switch-shipped" />
            Shipped
          </label>
          <label htmlFor="kit-switch-disabled" className={`${LABEL_CLASS} opacity-60`}>
            <Switch id="kit-switch-disabled" disabled />
            Blocked
          </label>
        </Sample>
      </Section>
      <Section title="Select">
        <Sample label="select · task status (closed, with value)">
          <Select items={STATUSES} defaultValue="in-progress">
            <SelectTrigger aria-label="Status" />
            <SelectContent>
              {STATUSES.slice(0, 3).map((status) => (
                <SelectItem key={status.value} value={status.value} disabled={status.disabled}>
                  {status.label}
                </SelectItem>
              ))}
              <SelectSeparator />
              {STATUSES.slice(3).map((status) => (
                <SelectItem key={status.value} value={status.value} disabled={status.disabled}>
                  {status.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Sample>
        <Sample label="select · placeholder">
          <Select items={STATUSES} placeholder="Sort by">
            <SelectTrigger aria-label="Sort order" />
            <SelectContent>
              {STATUSES.slice(0, 4).map((status) => (
                <SelectItem key={status.value} value={status.value}>
                  {status.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Sample>
        <Sample label="select · disabled">
          <Select items={STATUSES} defaultValue="done" disabled>
            <SelectTrigger aria-label="Status" />
            <SelectContent>
              <SelectItem value="done">Done</SelectItem>
            </SelectContent>
          </Select>
        </Sample>
      </Section>
    </>
  );
}
