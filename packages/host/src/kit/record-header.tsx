import type { ReactNode } from 'react';

import { GroomingBadge } from '../components/grooming-chip';
import type { ActionMenuEntry } from '../components/patterns/action-menu';
import { RecordHeader } from '../components/patterns/record-header';
import type { TrailStep } from '../components/patterns/record-header';
import { RecordMore, moreEntries } from '../components/record-head';
import { RecordTabs } from '../components/record-tabs';
import { StatusBadge } from '../components/status-badge';
import { ActionButton } from '../components/ui/action-button';
import { nodeLink } from '../lib/record-url';
import { Section } from './section';

/*
 * The record header (ADR 0019, MMR-726 refinement) and the record tabs, in the
 * states the design review named: a project, a task in review with a long
 * trail, a blocked task with More alone, a record with no summary, and a title
 * that is one long word.
 */

const project: TrailStep = {
  key: 'MMR',
  label: 'Mimir',
  to: { params: { key: 'MMR' }, to: '/p/$key' },
};
const step = (id: string, label: string): TrailStep => ({ key: id, label, to: nodeLink(id) });

const LONG_TRAIL = [
  project,
  step('MMR-356', 'Console usability, navigation, and operator workflows'),
  step('MMR-717', 'Console readability: one feed system for phone and desktop'),
];

const noop = () => {};

const TASK_MORE: ActionMenuEntry[] = moreEntries([
  [
    { key: 'edit', kind: 'action', label: 'Edit', onSelect: noop },
    { key: 'move', kind: 'action', label: 'Move…', onSelect: noop },
  ],
  [{ key: 'stage', kind: 'action', label: 'Stage', onSelect: noop }],
  [
    { key: 'park', kind: 'action', label: 'Park for later…', onSelect: noop },
    { key: 'block', kind: 'action', label: 'Mark blocked…', onSelect: noop },
  ],
  [{ destructive: true, key: 'abandon', kind: 'action', label: 'Abandon…', onSelect: noop }],
]);

function More({ title, id }: { title: string; id: string }) {
  return <RecordMore title={title} recordId={id} entries={TASK_MORE} />;
}

/** One header on the page surface, as a record page shows it. */
function Sample({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-well-900 p-4 max-md:px-3.5">
      <span className="font-mono text-mono-id text-ink-dim">{label}</span>
      {children}
    </div>
  );
}

export function RecordHeaderKit() {
  return (
    <Section title="Record header and tabs">
      <Sample label="project · New task and More · tabs">
        <RecordHeader
          title="Mimir"
          status={<StatusBadge status="in_progress" />}
          type="Project"
          recordId="MMR"
          summary="Agent first project and task management system: the work-state store, its CLI and MCP tools, and this console."
          actions={
            <>
              <ActionButton size="header">New task</ActionButton>
              <More title="Mimir" id="MMR" />
            </>
          }
        />
        <RecordTabs
          tabs={[
            { label: 'Work', value: 'work' },
            { label: 'Tasks', value: 'tasks' },
            { count: 24, label: 'Seeds', value: 'seeds' },
            { count: 418, label: 'Artifacts', value: 'artifacts' },
            { label: 'Details', value: 'details' },
          ]}
          value="work"
          onSelect={noop}
        >
          <p className="text-body text-ink">The Work tab's sections.</p>
        </RecordTabs>
      </Sample>
      <Sample label="task in review · long trail · three actions">
        <RecordHeader
          trail={LONG_TRAIL}
          title="Sidebar disclosure and seed composer close meet 44px phone targets"
          status={<StatusBadge status="under_review" />}
          type="Task"
          recordId="MMR-753"
          summary="The sidebar's disclosure and the seed composer's close drew 32px targets on a phone; both now take the 44px minimum, measured at 390 and 1280 in both themes, and /kit shows each one. The review checks every other phone control on those surfaces for the same miss, so the summary runs long enough to clamp."
          actions={
            <>
              <ActionButton size="header">Approve</ActionButton>
              <ActionButton size="header" variant="pageOutline">
                Send back…
              </ActionButton>
              <More title="Sidebar disclosure" id="MMR-753" />
            </>
          }
        />
      </Sample>
      <Sample label="ready task · grooming chip · Start">
        <RecordHeader
          trail={[project, step('MMR-717', 'Console readability')]}
          title="Record header, tabs, and the More menu"
          status={<StatusBadge status="ready" />}
          type="Task"
          recordId="MMR-726"
          summary="One header for project, initiative, phase, and task pages."
          chips={<GroomingBadge state="groomed" />}
          actions={
            <>
              <ActionButton size="header">Start</ActionButton>
              <More title="Record header" id="MMR-726" />
            </>
          }
        />
      </Sample>
      <Sample label="blocked task · no summary · More alone">
        <RecordHeader
          trail={[project]}
          title="Refuse to open an unmigrated store"
          status={<StatusBadge status="blocked" />}
          type="Task"
          recordId="MMR-681"
          actions={<More title="Refuse to open" id="MMR-681" />}
        />
      </Sample>
      <Sample label="done · a title that is one long word">
        <RecordHeader
          trail={[project]}
          title="Supercalifragilisticexpialidocious_configuration_loader_refactor_v2"
          status={<StatusBadge status="done" />}
          type="Task"
          recordId="MMR-700"
          actions={<More title="Loader refactor" id="MMR-700" />}
        />
      </Sample>
    </Section>
  );
}
