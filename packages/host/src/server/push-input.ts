// The contract, not core: the console's server-function module loads this file too.
import { parseEngineInput } from '@mimir/contract';
import { z } from 'zod';

import { PUSH_EVENT_KINDS } from './push-states';

/*
 * The Web Push server functions' inputs (ADR 0045, the MMR-709 refinement).
 * The structure is checked here; what the channel judges (the origin, the
 * key, the endpoint's allowlist, the browser keys, and the label's form) is
 * left well-formed so it answers a refusal rather than a thrown error.
 */

/*
 * Each field is bounded well above any value the channel accepts, so an
 * oversized request is refused before the channel parses or decodes it. The
 * label is still cut to 60 characters after normalization.
 */
const ENDPOINT_MAX = 2048;
const KEY_MAX = 256;
const LABEL_MAX = 1000;

/*
 * Subscribe's muted kinds are names the channel filters to the kinds it knows,
 * so a console build that knows another kind never fails a heal (ADR 0045,
 * the MMR-712 refinement). Only their size is bounded here.
 */
const MUTED_MAX = 16;
const KIND_NAME_MAX = 64;
const mutedSchema = z.array(z.string().max(KIND_NAME_MAX)).max(MUTED_MAX);

const subscribeSchema = z.strictObject({
  auth: z.string().max(KEY_MAX),
  endpoint: z.string().max(ENDPOINT_MAX),
  label: z.string().max(LABEL_MAX),
  /** The kinds to mute; absent keeps a known row's own (ADR 0045, MMR-712 refinement). */
  muted: mutedSchema.optional(),
  p256dh: z.string().max(KEY_MAX),
  /** The `applicationServerKey` the browser subscribed with, base64url. */
  serverKey: z.string().max(KEY_MAX),
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

const kindSchema = z.strictObject({
  endpoint: z.string(),
  kind: z.enum(PUSH_EVENT_KINDS),
  muted: z.boolean(),
});

/** What Set kind takes: one endpoint, one kind, and whether that kind is muted. */
export type PushKindInput = z.output<typeof kindSchema>;
export const parsePushKindInput = (input: unknown): PushKindInput =>
  parseEngineInput(kindSchema, input);
