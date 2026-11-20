import type { EngineInput } from '@mimir/contract';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { toast } from '../components/patterns/notice';
import { announceWake } from '../components/t3-wake-answers';
import { newAttempt } from '../lib/t3-attempt';
import {
  answerDecisions,
  confirm,
  deliveryAbandon,
  deliveryPark,
  deliveryReturn,
  deliveryUnblock,
  deliveryUnpark,
  deliveryUpdate,
  overturn,
  wakeT3,
} from './fns/deliveries';
import type { AnswerDecisionsInput, T3WakeInput, T3WakeState } from './fns/deliveries';
import { useInvalidateOnWrite } from './mutations';
import { t3OriginQuery, useConnectT3 } from './t3-queries';

/*
 * The operator's delivery and decision writes (ADR 0040, the wake). Each
 * waking write makes one attempt id for the action, sends it with the write,
 * and announces the wake's answer; a Retry goes through `wakeT3` with the
 * state's own `retry`, which carries that attempt. The write refreshes the
 * shared read keys.
 */

/** The wake's toasts, wired to the console: Retry, Reconnect T3, and the Connections page. */
function useWakeAnnouncer() {
  const { data } = useQuery(t3OriginQuery);
  const navigate = useNavigate();
  const connect = useConnectT3((answer) => {
    toast.error(
      answer.state === 'misconfigured'
        ? `T3 is not set up: ${answer.setting} is ${answer.problem}.`
        : 'T3 could not be reached to reconnect.',
    );
  });
  const retryWake = useMutation({
    mutationFn: (input: T3WakeInput) => wakeT3({ data: input }),
    onError: (err: Error) => toast.error(err.message),
    onSuccess: (wake) => {
      announce(wake);
    },
  });
  function announce(wake: T3WakeState) {
    announceWake(wake, {
      openConnections: () => {
        void navigate({ to: '/settings/connections' });
      },
      origin: data?.origin ?? null,
      reconnect: () => {
        connect.mutate();
      },
      retry: (input) => {
        retryWake.mutate(input);
      },
    });
  }
  return announce;
}

/**
 * One waking write: the server function takes the input plus a fresh attempt
 * id, and answers its wake beside the write's own answer. The wake is
 * announced before the refetches land, since they may unmount the control
 * that wrote.
 */
function useWakingWrite<Fields extends object, Answer extends { wake: T3WakeState }>(
  write: (options: { data: Fields & { attempt: string } }) => Promise<Answer>,
) {
  const invalidate = useInvalidateOnWrite();
  const announce = useWakeAnnouncer();
  return useMutation({
    mutationFn: (input: Fields) => write({ data: { ...input, attempt: newAttempt() } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
    onSuccess: (answer) => {
      announce(answer.wake);
    },
  });
}

/** Clear a delivery's stop and wake its thread. */
export const useDeliveryUnblock = () =>
  useWakingWrite<EngineInput<'deliveryUnblock'>, Awaited<ReturnType<typeof deliveryUnblock>>>(
    deliveryUnblock,
  );

/** Pause a delivery and wake its thread. */
export const useDeliveryPark = () =>
  useWakingWrite<EngineInput<'deliveryPark'>, Awaited<ReturnType<typeof deliveryPark>>>(
    deliveryPark,
  );

/** Resume a paused delivery and wake its thread. */
export const useDeliveryUnpark = () =>
  useWakingWrite<EngineInput<'deliveryUnpark'>, Awaited<ReturnType<typeof deliveryUnpark>>>(
    deliveryUnpark,
  );

/** Send a delivery's milestone back and wake its thread. */
export const useDeliveryReturn = () =>
  useWakingWrite<EngineInput<'deliveryReturn'>, Awaited<ReturnType<typeof deliveryReturn>>>(
    deliveryReturn,
  );

/** Abandon a delivery and wake its thread. */
export const useDeliveryAbandon = () =>
  useWakingWrite<EngineInput<'deliveryAbandon'>, Awaited<ReturnType<typeof deliveryAbandon>>>(
    deliveryAbandon,
  );

/** Edit a delivery and wake the thread its handles name after the edit. */
export const useDeliveryUpdate = () =>
  useWakingWrite<EngineInput<'deliveryUpdate'>, Awaited<ReturnType<typeof deliveryUpdate>>>(
    deliveryUpdate,
  );

/** Overturn a decision and wake the thread of the delivery it names. */
export const useOverturn = () =>
  useWakingWrite<EngineInput<'overturn'>, Awaited<ReturnType<typeof overturn>>>(overturn);

/** Confirm a decision. A confirm never wakes. */
export function useConfirm() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: (input: EngineInput<'confirm'>) => confirm({ data: input }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  });
}

/**
 * The decisions walkthrough's Send: the answers written in order and the one
 * wake. The answer's per-decision results are for the caller's done screen.
 */
export const useAnswerDecisions = () =>
  useWakingWrite<
    Omit<AnswerDecisionsInput, 'attempt'>,
    Awaited<ReturnType<typeof answerDecisions>>
  >(answerDecisions);
