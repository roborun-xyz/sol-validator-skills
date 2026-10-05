import { fetchJson } from './http';

/**
 * Revenue and performance share one contiguous window ending at lastEpoch. History that
 * begins after firstEpoch (a newer validator) shortens the window, and callers disclose
 * the unavailable epochs. A gap after the first available epoch is missing data and fails.
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

/** One disclosure for a window shortened by late-starting history; empty when complete. */
export function unavailableEpochsNote(requestedFirstEpoch: number, firstEpoch: number, lastEpoch: number): string[] {
  if (requestedFirstEpoch >= firstEpoch) return [];
  return [`Requested epochs \`${requestedFirstEpoch}-${lastEpoch}\`; JPool/SVT history starts at epoch \`${firstEpoch}\`, so epochs \`${requestedFirstEpoch}-${firstEpoch - 1}\` are unavailable and excluded.`];
}
