import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import { z } from 'zod';

/** "" → null; otherwise the trimmed string. */
const optionalText = z
  .string()
  .transform((s) => s.trim())
  .transform((s) => (s === '' ? null : s));

/** "" → null; otherwise must be one of the enum values. */
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => (s === '' ? null : s))
    .refine((v) => v === null || (values as readonly string[]).includes(v), {
      message: 'invalid value',
    })
    .transform((v) => v as (typeof values)[number] | null);

export const taskFormSchema = z.object({
  description: optionalText,
  external_ref: optionalText,
  priority: optionalEnum(PRIORITY_VALUES),
  size: optionalEnum(SIZE_VALUES),
  tags: z.array(z.string()).default([]),
  title: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: 'Title is required' }),
});

/** The raw (pre-parse) form shape — all strings, as the inputs hold them. */
export type TaskFormValues = {
  title: string;
  description: string;
  priority: string;
  size: string;
  external_ref: string;
  tags: string[];
};

export const emptyTaskForm: TaskFormValues = {
  description: '',
  external_ref: '',
  priority: '',
  size: '',
  tags: [],
  title: '',
};
