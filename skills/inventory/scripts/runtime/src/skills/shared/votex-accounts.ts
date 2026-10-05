export const VOTEX_PROGRAM = "VotAjwzAEF9ZLNAYEB1ivXt51911EqYGVu9NeaEKRyy";
export const VAULT_CONFIG = "AAJ1TUeLfzyCrywCukTaehieCPe6bQtaNbNXpcMDLPeB";
export const VAULT_GAUGEMEISTER = "HniSajyYDYEfdbNfW8L5Eq8W1pxt8XsYDgc6TNsx7t6x";
export const VAULT_ALLOWED_MINTS = "5ArmEZ9iso7p91tZafCRsfNwmoWpCG1Sd7UGbqieKBZ9";
export const GAUGE_PROGRAM = "GaugesLJrnVjNNWLReiw3Q7xQhycSBRgeHGTMDUaX231";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type VaultEpochInfo = {
  epochDurationSeconds: number;
  currentRewardsEpoch: number;
  activeVoteBuyTargetEpoch: number;
  currentEpochStart: number;
  nextEpochStartsAt: number;
};

/** Shared Vault layout for status and ROI; transport and availability policies stay with callers. */
export function decodeVaultEpochInfo(data: Buffer): VaultEpochInfo {
  if (data.length < 185) throw new Error(`Vault gaugemeister data too short: ${data.length}`);
  const epochDurationSeconds = data.readUInt32LE(169);
  const currentRewardsEpoch = data.readUInt32LE(173);
  const nextEpochStartsAt = Number(data.readBigInt64LE(177));
  return {
    epochDurationSeconds,
    currentRewardsEpoch,
    activeVoteBuyTargetEpoch: currentRewardsEpoch + 1,
    currentEpochStart: nextEpochStartsAt - epochDurationSeconds,
    nextEpochStartsAt,
  };
}

/** Published vote-buy amounts are summed as USDC; another mint would corrupt those totals. */
export function assertUsdcVoteBuys(voteBuys: Array<{ mint?: unknown }>, epoch: number): void {
  const other = voteBuys.find((buy) => typeof buy.mint === "string" && buy.mint !== USDC_MINT);
  if (other) throw new Error(`Votex stats for epoch ${epoch} include a non-USDC vote buy (mint ${other.mint}); USDC totals do not cover it.`);
}

export function votexStatsUrl(epoch: number): string {
  return `https://raw.githubusercontent.com/VotaFi/tribeca-stats/refs/heads/main/the-vault/${epoch}/stats.json`;
}
