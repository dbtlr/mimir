import {
  Field as SdkField,
  FieldDescription as SdkFieldDescription,
  FieldError as SdkFieldError,
  FieldLabel as SdkFieldLabel,
} from '@ui-sdk/react/field';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';

/*
 * The Field primitive (ADR 0046): the label, control, hint, and error of one
 * form value, wired together by UI SDK (`for`, `aria-describedby`, invalid
 * state). Reason dialogs, the Form sheet, and inline Composers put their
 * Input, Textarea, and Token Input inside one (ADR 0019, MMR-736).
 */

/** One value's label, control, hint, and error, stacked. */
export function Field({ className, ...props }: ComponentProps<typeof SdkField>) {
  return <SdkField className={cn('flex flex-col gap-1.5', className)} {...props} />;
}

/** A form value's label; picker labels (Combobox) wear it too, so every label reads alike. */
export const FIELD_LABEL_CLASS =
  'text-xs font-medium text-ink-dim data-[disabled]:text-ink-faint data-[invalid]:text-status-blocked-foreground';

/** Names the control. */
export function FieldLabel({ className, ...props }: ComponentProps<typeof SdkFieldLabel>) {
  return <SdkFieldLabel className={cn(FIELD_LABEL_CLASS, className)} {...props} />;
}

/** A hint that helps fill the control in; read with it. */
export function FieldDescription({
  className,
  ...props
}: ComponentProps<typeof SdkFieldDescription>) {
  return <SdkFieldDescription className={cn('text-xs text-ink-faint', className)} {...props} />;
}

/** Says what is wrong with the value; shows only while the field is invalid. */
export function FieldError({ className, ...props }: ComponentProps<typeof SdkFieldError>) {
  return (
    <SdkFieldError className={cn('text-xs text-status-blocked-foreground', className)} {...props} />
  );
}
