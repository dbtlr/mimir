import { z } from 'zod';

/** The `/health` wire response, shared by the host and the clients that read it. */
export const healthSchema = z.object({
  minClient: z.string(),
  schema: z.number().int().nonnegative(),
  status: z.literal('ok'),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;
