// The contract, not core: the console's server-function module loads this file too.
import { parseEngineInput } from '@mimir/contract';
import { z } from 'zod';

/*
 * The Web Push server functions' inputs (ADR 0045, the MMR-709 refinement).
 * The structure is checked here; what the channel judges (the origin, the
 * key, the endpoint's allowlist, the browser keys, and the label's form) is
 * left well-formed so it answers a refusal rather than a thrown error.
 */

const subscribeSchema = z.strictObject({
  auth: z.string(),
  endpoint: z.string(),
  label: z.string(),
  p256dh: z.string(),
  /** The `applicationServerKey` the browser subscribed with, base64url. */
  serverKey: z.string(),
});

/** What Subscribe takes: the browser's subscription, the key it used, and a label. */
export type PushSubscribeInput = z.output<typeof subscribeSchema>;
export const parsePushSubscribeInput = (input: unknown): PushSubscribeInput =>
  parseEngineInput(subscribeSchema, input);

const endpointSchema = z.strictObject({ endpoint: z.string() });

/** What Unsubscribe and Send test take: one endpoint. */
export type PushEndpointInput = z.output<typeof endpointSchema>;
export const parsePushEndpointInput = (input: unknown): PushEndpointInput =>
  parseEngineInput(endpointSchema, input);
