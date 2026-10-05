import { TransportError } from './http';

/**
 * Bounded polling for idempotent reads that follow a submitted transaction. A node that
 * trails the one that confirmed it, or a brief transport error, must not be reported as a
 * failed mutation. `read` returns undefined while the expected state is not yet visible and
 * any defined value, including a definitive failure, to stop. Only errors that `retryable`
 * accepts (by default the shared transport errors) are retried; any other error is a real
 * failure and surfaces at once. Keep `read` narrow, and never wrap a submission.
 */
export async function pollReadOnly<T>(
  read: () => Promise<T | undefined>, attempts = 20, intervalMs = 1_500,
  retryable: (error: unknown) => boolean = error => error instanceof TransportError,
): Promise<T | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, intervalMs));
    try {
      const value = await read();
      if (value !== undefined) return value;
      lastError = undefined;
    } catch (error) {
      if (!retryable(error)) throw error;
      lastError = error;
    }
  }
  if (lastError !== undefined) throw lastError;
  return undefined;
}
