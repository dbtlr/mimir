import { Field, FieldDescription, FieldError, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { TokenInput } from '../components/ui/token-input';
import { Sample, Section } from './section';

const NOTES =
  'Parked until the console ships\nWaiting on MMR-219\nRevisit after review\nBlocks MMR-740';

/** Field, Input, Textarea, and Token Input. */
export function TextKit() {
  return (
    <Section title="Text">
      <Sample label="field · input">
        <Field className="w-80">
          <FieldLabel>Title</FieldLabel>
          <Input placeholder="What needs doing" defaultValue="Add the Dialog primitive" />
          <FieldDescription>Shown on the board and in the queue.</FieldDescription>
        </Field>
      </Sample>
      <Sample label="field · invalid">
        <Field invalid className="w-80">
          <FieldLabel>Title</FieldLabel>
          <Input placeholder="What needs doing" />
          <FieldError match>A task needs a title.</FieldError>
        </Field>
      </Sample>
      <Sample label="input · disabled">
        <Field disabled className="w-80">
          <FieldLabel>Task id</FieldLabel>
          <Input defaultValue="MMR-739" />
        </Field>
      </Sample>
      <Sample label="textarea · default">
        <Field className="w-80">
          <FieldLabel>Reason</FieldLabel>
          <Textarea placeholder="Why park MMR-219?" />
        </Field>
      </Sample>
      <Sample label="textarea · grow (prefilled with five lines, then scrolls)">
        <Field className="w-80">
          <FieldLabel>Note for the agent</FieldLabel>
          <Textarea grow defaultValue={`${NOTES}\nAsk before unparking`} />
        </Field>
      </Sample>
      <Sample label="textarea · grow (empty, one line)">
        <Textarea
          grow
          aria-label="Your own answer"
          placeholder="The answer you want"
          className="w-80"
        />
      </Sample>
      <Sample label="token input · tags (Enter or comma adds, x removes)">
        <Field className="w-80">
          <FieldLabel>Tags</FieldLabel>
          <TokenInput defaultValue={['console', 'ui']} placeholder="Add a tag" />
          <FieldDescription>Press Enter or comma after each tag.</FieldDescription>
        </Field>
      </Sample>
      <Sample label="token input · field (a form's tags: 32 chips, 44 remove targets and rows on a phone)">
        <Field className="w-full max-w-[576px]">
          <FieldLabel>Tags</FieldLabel>
          <TokenInput
            size="field"
            defaultValue={['navigation', 'console', 'release:v0.30', 'feed', 'phone', 'ui']}
          />
          <FieldDescription>Press Enter or type a comma to add a tag.</FieldDescription>
        </Field>
      </Sample>
    </Section>
  );
}
