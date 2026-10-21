import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { approvePairing, denyPairing, unpairDevice } from './fns/devices';

/*
 * The device pages' writes (MMR-585): approve or deny a waiting request by its
 * code, and unpair a device. Each settles by invalidating every `devices`
 * read, and a refusal toasts verbatim and leaves the page as it was.
 */

function useInvalidateDevices(): () => Promise<void> {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['devices'] });
}

/** Approve the request a code names; its client finishes pairing on its next poll. */
export function useApprovePairing() {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: (code: string) => approvePairing({ data: { code } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/** Deny the request a code names. */
export function useDenyPairing() {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: (code: string) => denyPairing({ data: { code } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}

/** Unpair a device: its token stops working at once. */
export function useUnpairDevice() {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: (device: string) => unpairDevice({ data: { device } }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void invalidate(),
  });
}
