import { toast } from 'sonner';

/**
 * Copy text and say whether it worked. The success toast waits for the
 * clipboard write to resolve; a rejection or an absent `navigator.clipboard`
 * (an insecure off-loopback context) toasts the failure instead of falsely
 * announcing a copy.
 */
export async function copyText(text: string, messages: { copied: string; failed: string }) {
  try {
    if (navigator.clipboard === undefined) {
      throw new Error('clipboard unavailable');
    }
    await navigator.clipboard.writeText(text);
    toast.success(messages.copied);
  } catch {
    toast.error(messages.failed);
  }
}
