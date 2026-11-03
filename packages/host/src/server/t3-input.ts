// The contract, not core: the console's server-function module loads this file too.
import { parseEngineInput } from '@mimir/contract';
import { z } from 'zod';

const catalogSchema = z.strictObject({ project: z.string().min(1) });

/** What the T3 catalog function takes: the Mimir project to list launch systems for. */
export type T3CatalogInput = z.output<typeof catalogSchema>;
export const parseT3CatalogInput = (input: unknown): T3CatalogInput =>
  parseEngineInput(catalogSchema, input);
