import { fetchJson } from './http';

/**
 * Revenue and performance share one contiguous window ending at lastEpoch. Rows that begin
 * after firstEpoch shorten the window, and callers disclose the unavailable epochs. That is
 * expected for a newer validator, but upstream rows missing at the start of the window look
 * identical, so the disclosure states what was returned, not why. A gap after the first
 * available epoch is missing data and fails.
 */
export async function fetchSvtHistory<Row extends {epoch: number}>(
  voteAccount: string, firstEpoch: number, lastEpoch: number, epochCount: number,
): Promise<Row[]> {
  const params = new URLSearchParams({
    network:'mainnet', vote_id:voteAccount, epoch_count:String(epochCount), epoch_from:String(lastEpoch),
  });
  const payload = await fetchJson<{data: Row[]}>(`https://api.validators.svt.one/validators-history/history?${params}`);
  if (!Array.isArray(payload.data)) throw new Error('JPool/SVT history response did not include a data array.');
  const rows = payload.data.filter(row => row.epoch >= firstEpoch && row.epoch <= lastEpoch).sort((a,b) => a.epoch - b.epoch);
  if (!rows.length) throw new Error(`JPool/SVT history has no rows for epochs ${firstEpoch}-${lastEpoch}.`);
  const epochs = new Set(rows.map(row => row.epoch));
  const missing: number[] = [];
  for (let epoch = rows[0].epoch; epoch <= lastEpoch; epoch++) if (!epochs.has(epoch)) missing.push(epoch);
  if (missing.length) throw new Error(`JPool/SVT history missing epoch(s): ${missing.join(', ')}.`);
  return rows;
}

/** A non-negative safe integer from an upstream count; null when absent or invalid. */
export function toCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Block skip rate from leader-slot counts only; null without leader slots or without both
 * valid counts. SVT's `skippedSlots` is the vote-credit shortfall (1 - tvCredits / max),
 * not block production, so it is never a fallback.
 */
export function leaderSkipRatePct(leaderSlotsTotal: unknown, leaderSlotsDone: unknown): number | null {
  const leaderSlots = toCount(leaderSlotsTotal);
  const blocksDone = toCount(leaderSlotsDone);
  if (leaderSlots === null || blocksDone === null || leaderSlots === 0 || blocksDone > leaderSlots) return null;
  return ((leaderSlots - blocksDone) / leaderSlots) * 100;
}

/** One disclosure for a window with no rows for its first requested epochs; empty when complete. */
export function unavailableEpochsNote(requestedFirstEpoch: number, firstEpoch: number, lastEpoch: number): string[] {
  if (requestedFirstEpoch >= firstEpoch) return [];
  return [`Requested epochs \`${requestedFirstEpoch}-${lastEpoch}\`; JPool/SVT returned no rows before epoch \`${firstEpoch}\`, so epochs \`${requestedFirstEpoch}-${firstEpoch - 1}\` are unavailable and excluded. A validator that started later and rows missing upstream look the same here.`];
}
