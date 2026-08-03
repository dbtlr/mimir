import { z } from 'zod';

/** The owned `/api/health` wire response, shared by its producer and consumer. */
export const healthSchema = z.object({
  schema: z.number().int().nonnegative(),
  status: z.literal('ok'),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;

/** A malformed or foreign responder is the same as no health response. */
export function parseHealth(value: unknown): Health | undefined {
  const parsed = healthSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
