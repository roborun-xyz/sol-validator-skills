/**
 * Bounded polling for idempotent reads that follow a submitted transaction. A node that
 * trails the one that confirmed it, or a brief transport error, must not be reported as a
 * failed mutation. `read` returns undefined while the expected state is not yet visible and
 * any defined value, including a definitive failure, to stop. Never wrap a submission.
 */
export async function pollReadOnly<T>(
  read: () => Promise<T | undefined>, attempts = 20, intervalMs = 1_500,
): Promise<T | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, intervalMs));
    try {
      const value = await read();
      if (value !== undefined) return value;
      lastError = undefined;
    } catch (error) { lastError = error; }
  }
  if (lastError !== undefined) throw lastError;
  return undefined;
}
