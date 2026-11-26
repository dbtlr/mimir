import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../components/ui/collapsible';
import { Tabs, TabsCount, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs';
import { Sample, Section } from './section';

const SHIPPED_ROWS = [
  ['MMR-219', 'Park a task from its card'],
  ['MMR-224', 'Show the verdict on the Work tab'],
  ['MMR-231', 'Fold finished work by day'],
] as const;

function ShippedRows() {
  return (
    <ul className="flex flex-col divide-y divide-line border-t border-line">
      {SHIPPED_ROWS.map(([id, title]) => (
        <li className="flex items-baseline gap-3 py-2" key={id}>
          <span className="text-mono-id font-mono text-ink-dim">{id}</span>
          <span className="text-title font-medium text-ink-bright">{title}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tabs and Collapsible. */
export function StructureKit() {
  return (
    <>
      <Section title="Tabs">
        <Sample label="tabs · record header">
          <Tabs className="w-full" defaultValue="overview">
            <TabsList aria-label="Record sections">
              <TabsTab value="overview">Overview</TabsTab>
              <TabsTab value="activity">Activity</TabsTab>
              <TabsTab value="artifacts">
                Artifacts <TabsCount>3</TabsCount>
              </TabsTab>
              <TabsTab disabled value="deliveries">
                Deliveries
              </TabsTab>
            </TabsList>
            <TabsPanel value="overview">
              MMR-219 is ready. Park it to take it off the queue.
            </TabsPanel>
            <TabsPanel value="activity">Started 2h ago; sent back once with a note.</TabsPanel>
            <TabsPanel value="artifacts">Three artifacts are attached to this task.</TabsPanel>
          </Tabs>
        </Sample>
        <Sample label="tabs · joined (Write and Preview on an editor's top edge)">
          <Tabs className="flex w-full max-w-[576px] flex-col" defaultValue="write">
            <TabsList joined aria-label="Write or preview">
              <TabsTab value="write">Write</TabsTab>
              <TabsTab value="preview">Preview</TabsTab>
            </TabsList>
            <TabsPanel
              value="write"
              className="min-h-22 rounded-b-md border border-ink-faint bg-well-950 px-3 py-2.5 pt-2.5"
            >
              The editor sits here, its top corners square under the row.
            </TabsPanel>
            <TabsPanel
              value="preview"
              className="min-h-22 rounded-b-md border border-line-bright bg-well-850 px-4 py-3 pt-3"
            >
              The rendered prose sits here.
            </TabsPanel>
          </Tabs>
        </Sample>
      </Section>
      <Section title="Collapsible">
        <Sample label="collapsible · day folds (latest open)">
          <div className="flex w-full flex-col">
            <Collapsible defaultOpen>
              <CollapsibleTrigger>Tuesday · 3 shipped</CollapsibleTrigger>
              <CollapsiblePanel>
                <ShippedRows />
              </CollapsiblePanel>
            </Collapsible>
            <Collapsible>
              <CollapsibleTrigger>Monday · 6 shipped</CollapsibleTrigger>
              <CollapsiblePanel>
                <ShippedRows />
              </CollapsiblePanel>
            </Collapsible>
          </div>
        </Sample>
      </Section>
    </>
  );
}
