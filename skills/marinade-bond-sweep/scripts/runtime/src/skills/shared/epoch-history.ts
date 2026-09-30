import { fetchJson } from './http';

/** The same complete epoch window is required by revenue and performance reports. */
export async function fetchSvtHistory<Row extends {epoch: number}>(
  voteAccount: string, firstEpoch: number, lastEpoch: number, epochCount: number,
): Promise<Row[]> {
  const params = new URLSearchParams({
    network:'mainnet', vote_id:voteAccount, epoch_count:String(epochCount), epoch_from:String(lastEpoch),
  });
  const payload = await fetchJson<{data: Row[]}>(`https://api.validators.svt.one/validators-history/history?${params}`);
  if (!Array.isArray(payload.data)) throw new Error('JPool/SVT history response did not include a data array.');
  const rows = payload.data.filter(row => row.epoch >= firstEpoch && row.epoch <= lastEpoch).sort((a,b) => a.epoch - b.epoch);
  const epochs = new Set(rows.map(row => row.epoch));
  const missing: number[] = [];
  for (let epoch = firstEpoch; epoch <= lastEpoch; epoch++) if (!epochs.has(epoch)) missing.push(epoch);
  if (missing.length) throw new Error(`JPool/SVT history missing epoch(s): ${missing.join(', ')}.`);
  return rows;
}
