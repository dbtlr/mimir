import {
  Field as SdkField,
  FieldDescription as SdkFieldDescription,
  FieldError as SdkFieldError,
  FieldLabel as SdkFieldLabel,
} from '@ui-sdk/react/field';
import type { ComponentProps } from 'react';

import { mergeClassName } from './class-name';

/*
 * The Field primitive (ADR 0046): the label, control, hint, and error of one
 * form value, wired together by UI SDK (`for`, `aria-describedby`, invalid
 * state). Reason dialogs, the Form sheet, and inline Composers put their
 * Input, Textarea, and Token Input inside one (ADR 0019, MMR-736).
 */

/**
 * One value's label, control, hint, and error, stacked 8 apart: close enough
 * that they read as one field, where fields sit 24 apart (DESIGN.md, A form).
 */
export function Field({ className, ...props }: ComponentProps<typeof SdkField>) {
  return <SdkField className={mergeClassName('flex flex-col gap-2', className)} {...props} />;
}

/**
 * A form value's label: 14/20 ink at 500, so it reads before its control and a
 * step above its 13px help. Picker labels (Combobox) wear it too.
 */
export const FIELD_LABEL_CLASS =
  'text-label font-medium text-ink data-[disabled]:text-ink-dim data-[invalid]:text-status-blocked-foreground';

/** The prose measure of a form: help and a group's explanation wrap at 440 (DESIGN.md, Type). */
export const FORM_PROSE_CLASS = 'max-w-[440px] text-meta leading-5 text-ink-dim text-pretty';

/** The "optional" beside a label, 8 after it on the label's baseline, in the help's voice. */
export function FieldOptional() {
  return <span className="ml-2 text-meta font-normal text-ink-dim">optional</span>;
}

/** Names the control. */
export function FieldLabel({ className, ...props }: ComponentProps<typeof SdkFieldLabel>) {
  return <SdkFieldLabel className={mergeClassName(FIELD_LABEL_CLASS, className)} {...props} />;
}

/**
 * A hint that helps fill the control in; read with it. Only a surprising input
 * has one (DESIGN.md, Color roles): a format, or behavior its label does not say.
 */
export function FieldDescription({
  className,
  ...props
}: ComponentProps<typeof SdkFieldDescription>) {
  return <SdkFieldDescription className={mergeClassName(FORM_PROSE_CLASS, className)} {...props} />;
}

/** Says what is wrong with the value; shows only while the field is invalid. */
export function FieldError({ className, ...props }: ComponentProps<typeof SdkFieldError>) {
  return (
    <SdkFieldError
      className={mergeClassName('text-meta leading-5 text-status-blocked-foreground', className)}
      {...props}
    />
  );
}
