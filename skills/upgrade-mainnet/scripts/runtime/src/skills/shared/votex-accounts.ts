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

/**
 * Vote-buy amounts are summed as USDC, so a Vault vote buy in another mint would corrupt the
 * totals. Published stats and the on-chain scan reject it the same way.
 */
export class NonUsdcVoteBuyError extends Error {
  constructor(epoch: number, mint: unknown) {
    super(`Votex epoch ${epoch} includes a non-USDC vote buy (mint ${typeof mint === "string" ? mint : "missing or invalid"}); USDC totals do not cover it.`);
  }
}

/** Every published vote buy names its mint; an absent or non-string mint is not assumed to be USDC. */
export function assertUsdcVoteBuys(voteBuys: Array<{ mint?: unknown }>, epoch: number): void {
  const other = voteBuys.find((buy) => buy.mint !== USDC_MINT);
  if (other) throw new NonUsdcVoteBuyError(epoch, other.mint);
}

export function votexStatsUrl(epoch: number): string {
  return `https://raw.githubusercontent.com/VotaFi/tribeca-stats/refs/heads/main/the-vault/${epoch}/stats.json`;
}
