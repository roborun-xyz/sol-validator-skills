#!/usr/bin/env bun

import { localIso } from "../../shared/time";

import { fetchSvtHistory, unavailableEpochsNote } from "../../shared/epoch-history";
import { lamportsToSol, LAMPORTS_PER_SOL } from "../../shared/amounts";

import { fetchJson, fetchOptionalJson } from "../../shared/http";
import { rpcCall as rpc, resolveOperator, isPublicKey } from "../../shared/operator-config";

import {
  verifyBamBoostClaimStatusAccount,
  deriveBamBoostClaimStatusAddress,
  BAM_MERKLE_BASE as BAM_BOOST_MERKLE_BASE_URL,
  JITOSOL_RATIO_URL as JITOSOL_SOL_RATIO_URL,
  type RpcAccount,
} from "../../shared/bam-accounts";
export { verifyBamBoostClaimStatusAccount, deriveBamBoostClaimStatusAddress } from "../../shared/bam-accounts";

import { parseEpochQueryArgs, EPOCH_QUERY_HELP, type EpochQueryOptions as Options } from "../../shared/cli";



type TrilliumRow = {
  identity_pubkey?: string;
  vote_account_pubkey: string;
  epoch: number;
};

type BamBoostMerkleEntry = {
  pubkey: string;
  amount: string | number;
};

type BamBoostAllocationStatus =
  | "allocated"
  | "not_allocated"
  | "not_published"
  | "identity_missing";

type BamBoostClaimStatus =
  | "claimed"
  | "unclaimed"
  | "not_applicable"
  | "not_available";

type BamBoostIdentitySource = "trillium" | "svt-history";

type BamBoostReward = {
  earningEpoch: number;
  claimEpoch: number;
  identityAccount: string | null;
  identitySource: BamBoostIdentitySource | null;
  amount: bigint;
  status: BamBoostAllocationStatus;
};

type BamBoostClaim = {
  earningEpoch: number;
  claimEpoch: number;
  claimStatusAccount: string | null;
  status: BamBoostClaimStatus;
};

type BamBoostConversionStatus = "converted" | "not_needed";

type BamBoostConversion = {
  earningEpoch: number;
  claimEpoch: number;
  jitoSolToSolRate: number | null;
  rateTimestampUtc: string | null;
  rateTimestampLocal: string | null;
  rewardSol: number;
  status: BamBoostConversionStatus;
};

type JitoSolRatioResponse = {
  ratios: JitoSolRatioRecord[];
};

type JitoSolRatioRecord = {
  data: number;
  date: string;
};

type EpochSchedule = {
  slotsPerEpoch: number;
  firstNormalEpoch: number;
  firstNormalSlot: number;
};

type JitoValidatorHistoryRecord = {
  epoch: number;
  mev_rewards: string | number;
  mev_commission_bps: string | number;
};

type JitoCommissionRewardStatus = "reported" | "not_reported";

type JitoCommissionReward = {
  epoch: number;
  mevRevenue: bigint;
  commissionBps: number | null;
  operatorCommission: bigint;
  status: JitoCommissionRewardStatus;
};

type MarinadeBondsResponse = {
  bonds: MarinadeBondRecord[];
};

type MarinadeBondRecord = {
  pubkey: string;
  vote_account: string;
  bond_type?: string;
};

type MarinadeProtectedEventsResponse = {
  protected_events: MarinadeProtectedEventRecord[];
};

type MarinadeProtectedEventRecord = {
  epoch: number;
  amount: string | number;
  vote_account: string;
  meta?: {
    funder?: string;
  };
  reason?: unknown;
};

type MarinadeBondCosts = {
  hasBond: boolean;
  bondAccounts: MarinadeBondRecord[];
  paymentsByEpoch: Map<number, bigint>;
  estimatesByEpoch: Map<number, MarinadeEstimate>;
};

type MarinadeEstimate = {
  paymentSol: number;
  effectiveBid: number;
  activatedStakeSol: number;
  source: string;
};

const MARINADE_SAM_URL = "https://scoring.marinade.finance/api/v1/scores/sam";

// SAM's effectiveBid includes the auction's static and dynamic bid components.
// It is already denominated in SOL per 1,000 SOL per epoch, not lamports.
export function estimateMarinadePayment(
  payload: unknown,
  voteAccount: string,
  epoch: number,
): MarinadeEstimate {
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid Marinade SAM data for epoch ${epoch}.`);
  }
  const matches = payload.filter(row => row?.voteAccount === voteAccount);
  const row = matches[0];
  const bid = row?.effectiveBid;
  const stake = row?.values?.marinadeActivatedStakeSol;
  if (
    matches.length !== 1 || row?.epoch !== epoch ||
    typeof bid !== "number" || !Number.isFinite(bid) || bid < 0 ||
    typeof stake !== "number" || !Number.isFinite(stake) || stake < 0
  ) {
    throw new Error(`Cannot estimate Marinade payment: missing, ambiguous or invalid SAM bid/stake for epoch ${epoch}.`);
  }
  const paymentSol = roundSol(stake * bid / 1000);
  if (!Number.isFinite(paymentSol)) throw new Error(`Invalid Marinade estimate for epoch ${epoch}.`);
  return {
    paymentSol,
    effectiveBid: bid,
    activatedStakeSol: stake,
    source: `${MARINADE_SAM_URL}?epoch=${epoch}`,
  };
}

type SvtHistoryRow = {
  validatorId: string;
  voteId: string;
  epoch: number;
  apy?: number;
  jitoApy?: number;
  commissionReward: string | number;
  votingReward: string | number;
  jitoReward: string | number;
  votingFee: string | number;
  votingCompensation: string | number;
  tvCredits?: number;
  tvcRank?: number;
  leaderSlotsTotal?: number;
  leaderSlotsDone?: number;
  fee?: number;
  mevCommission?: number;
  totalStake?: string | number;
  skippedSlots?: string | number;
};

type RevenueRow = {
  epoch: number;
  stakeSol: number;
  commissionPct: number | null;
  votingRewardSol: number;
  commissionRewardSol: number;
  jitoMevRevenueSol: number;
  jitoCommissionBps: number | null;
  jitoRewardSol: number;
  svtJitoInflowSol: number;
  excludedSvtJitoInflowSol: number;
  jitoRewardStatus: JitoCommissionRewardStatus | "";
  bamBoostClaimEpoch: number;
  bamBoostAllocatedJitoSol: number;
  bamBoostJitoSolToSolRate: number | null;
  bamBoostRateTimestampUtc: string;
  bamBoostRateTimestampLocal: string;
  bamBoostAllocatedSolEquivalent: number;
  bamBoostConversionStatus: BamBoostConversionStatus | "";
  bamBoostAllocationStatus: BamBoostAllocationStatus | "";
  bamBoostIdentitySource: BamBoostIdentitySource | "";
  bamBoostClaimStatus: BamBoostClaimStatus | "";
  bamBoostClaimStatusAccount: string;
  bamBoostClaimedJitoSol: number;
  bamBoostClaimedSolEquivalent: number;
  votingCompensationSol: number;
  grossRevenueSol: number;
  votingFeeSol: number;
  marinadeBondPaymentSol: number;
  marinadeBondEstimatedPaymentSol: number;
  marinadeBondPaymentStatus: string;
  marinadeEffectiveBid: number | null;
  marinadeActivatedStakeSol: number | null;
  marinadeEstimateSource: string;
  netRevenueSol: number;
  preCompLamportsPerKiloStake: number;
  blocksProduced: number;
  leaderSlots: number;
  skipRate: string;
};

const TRILLIUM_BASE_URL = "https://api.trillium.so/validator_rewards";

const JITO_VALIDATOR_HISTORY_BASE_URL =
  "https://kobe.mainnet.jito.network/api/v1/validators";

const MARINADE_BONDS_BASE_URL = "https://validator-bonds-api.marinade.finance";

const MARINADE_BOND_TYPES = ["bidding", "institutional"] as const;
const BASIS_POINTS_DENOMINATOR = 10_000n;

function usage(): never {
  console.log(`Usage:
  bun src/skills/validator-revenue/scripts/revenue.ts --vote-account <VOTE_ACCOUNT> [--epochs 30]
  bun src/skills/validator-revenue/scripts/revenue.ts --validator <VOTE_OR_IDENTITY> [--epochs 30]

${EPOCH_QUERY_HELP}
`);
  process.exit(0);
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return fallback;
}

function toLamports(value: string | number | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.trunc(value));
  }
  const trimmed = value.trim();
  if (trimmed === "") return 0n;
  return BigInt(trimmed);
}

function stakeLamportsToSol(value: string | number | undefined): number {
  return lamportsToSol(toLamports(value));
}

function roundSol(value: number): number {
  return Number(value.toFixed(9));
}

async function fetchJitoCommissionRewards(
  voteAccount: string,
  firstEpoch: number,
  lastEpoch: number,
): Promise<Map<number, JitoCommissionReward>> {
  const payload = await fetchJson<JitoValidatorHistoryRecord[]>(
    `${JITO_VALIDATOR_HISTORY_BASE_URL}/${voteAccount}`,
  );
  if (!Array.isArray(payload)) {
    throw new Error("Jito validator history response was not an array.");
  }
  const rowsByEpoch = new Map(
    payload
      .filter((row) => row.epoch >= firstEpoch && row.epoch <= lastEpoch)
      .map((row) => [row.epoch, row]),
  );
  const epochs = Array.from(
    { length: lastEpoch - firstEpoch + 1 },
    (_, index) => firstEpoch + index,
  );
  const rewards = epochs.map((epoch): JitoCommissionReward => {
    const row = rowsByEpoch.get(epoch);
    if (!row) {
      return {
        epoch,
        mevRevenue: 0n,
        commissionBps: null,
        operatorCommission: 0n,
        status: "not_reported",
      };
    }

    const commissionBps = toNumber(row.mev_commission_bps, Number.NaN);
    if (
      !Number.isInteger(commissionBps) ||
      commissionBps < 0 ||
      commissionBps > Number(BASIS_POINTS_DENOMINATOR)
    ) {
      throw new Error(
        `Jito returned invalid MEV commission '${row.mev_commission_bps}' for epoch ${epoch}.`,
      );
    }
    const mevRevenue = toLamports(row.mev_rewards);
    const operatorCommission =
      (mevRevenue * BigInt(commissionBps)) / BASIS_POINTS_DENOMINATOR;

    return {
      epoch,
      mevRevenue,
      commissionBps,
      operatorCommission,
      status: "reported",
    };
  });

  return new Map(rewards.map((reward) => [reward.epoch, reward]));
}

export async function fetchBamBoostRewards(
  voteAccount: string,
  firstEpoch: number,
  lastEpoch: number,
  fallbackIdentityByEpoch: Map<number, string> = new Map(),
): Promise<Map<number, BamBoostReward>> {
  const history = await fetchJson<TrilliumRow[]>(
    `${TRILLIUM_BASE_URL}/${voteAccount}`,
  );
  if (!Array.isArray(history)) {
    throw new Error("Trillium validator history response was not an array.");
  }

  const identityByEpoch = new Map<number, string>();
  for (const row of history) {
    if (row.vote_account_pubkey !== voteAccount || !row.identity_pubkey)
      continue;
    identityByEpoch.set(row.epoch, row.identity_pubkey);
  }

  const earningEpochs = Array.from(
    { length: lastEpoch - firstEpoch + 1 },
    (_, index) => firstEpoch + index,
  );
  const rewards: BamBoostReward[] = [];
  const batchSize = 6;
  for (let offset = 0; offset < earningEpochs.length; offset += batchSize) {
    const batch = earningEpochs.slice(offset, offset + batchSize);
    const batchRewards = await Promise.all(
      batch.map(async (earningEpoch): Promise<BamBoostReward> => {
        // JIP-31 publishes rewards earned in epoch N under the epoch N+1 distributor.
        const claimEpoch = earningEpoch + 1;
        // Trillium serves only recent epochs; otherwise use the identity that the
        // JPool/SVT history row records for the same epoch.
        const trilliumIdentity = identityByEpoch.get(earningEpoch);
        const identityAccount = trilliumIdentity ?? fallbackIdentityByEpoch.get(earningEpoch) ?? null;
        const identitySource: BamBoostIdentitySource | null =
          trilliumIdentity ? "trillium" : identityAccount ? "svt-history" : null;
        const entries = await fetchOptionalJson<BamBoostMerkleEntry[]>(
          `${BAM_BOOST_MERKLE_BASE_URL}/${claimEpoch}/merkle_tree.json`,
        );
        if (entries === null) {
          return {
            earningEpoch,
            claimEpoch,
            identityAccount,
            identitySource,
            amount: 0n,
            status: "not_published" as const,
          };
        }
        if (!Array.isArray(entries)) {
          throw new Error(
            `BAM Boost Merkle file for claim epoch ${claimEpoch} was not an array.`,
          );
        }
        if (!identityAccount) {
          return {
            earningEpoch,
            claimEpoch,
            identityAccount,
            identitySource,
            amount: 0n,
            status: "identity_missing" as const,
          };
        }

        const amount = entries.reduce(
          (sum, entry) =>
            entry.pubkey === identityAccount
              ? sum + toLamports(entry.amount)
              : sum,
          0n,
        );
        return {
          earningEpoch,
          claimEpoch,
          identityAccount,
          identitySource,
          amount,
          status:
            amount > 0n ? ("allocated" as const) : ("not_allocated" as const),
        };
      }),
    );
    rewards.push(...batchRewards);
  }

  return new Map(rewards.map((reward) => [reward.earningEpoch, reward]));
}

async function fetchBamBoostClaims(
  rpcUrl: string,
  rewardsByEpoch: Map<number, BamBoostReward>,
): Promise<Map<number, BamBoostClaim>> {
  const claims = new Map<number, BamBoostClaim>();
  const allocated: Array<{
    reward: BamBoostReward;
    claimStatusAccount: string;
  }> = [];

  for (const reward of rewardsByEpoch.values()) {
    if (reward.status !== "allocated" || reward.amount === 0n) {
      claims.set(reward.earningEpoch, {
        earningEpoch: reward.earningEpoch,
        claimEpoch: reward.claimEpoch,
        claimStatusAccount: null,
        status:
          reward.status === "not_allocated"
            ? "not_applicable"
            : "not_available",
      });
      continue;
    }
    if (!reward.identityAccount) {
      throw new Error(
        `BAM Boost allocation for earning epoch ${reward.earningEpoch} had no identity account.`,
      );
    }
    allocated.push({
      reward,
      claimStatusAccount: deriveBamBoostClaimStatusAddress(
        reward.identityAccount,
        reward.claimEpoch,
      ),
    });
  }

  for (let offset = 0; offset < allocated.length; offset += 100) {
    const batch = allocated.slice(offset, offset + 100);
    const response = await rpc<{ value: Array<RpcAccount | null> }>(
      rpcUrl,
      "getMultipleAccounts",
      [
        batch.map((item) => item.claimStatusAccount),
        { encoding: "base64", commitment: "finalized" },
      ],
    );
    if (
      !Array.isArray(response.value) ||
      response.value.length !== batch.length
    ) {
      throw new Error(
        "BAM Boost Claim Status RPC response length did not match the request.",
      );
    }

    batch.forEach((item, index) => {
      const account = response.value[index];
      if (account) {
        verifyBamBoostClaimStatusAccount(
          account,
          item.reward.identityAccount!,
          item.reward.amount,
        );
      }
      claims.set(item.reward.earningEpoch, {
        earningEpoch: item.reward.earningEpoch,
        claimEpoch: item.reward.claimEpoch,
        claimStatusAccount: item.claimStatusAccount,
        status: account ? "claimed" : "unclaimed",
      });
    });
  }

  return claims;
}

function firstSlotForEpoch(epoch: number, schedule: EpochSchedule): number {
  if (epoch < schedule.firstNormalEpoch) {
    throw new Error(
      `Cannot derive the first slot for warmup epoch ${epoch}; BAM Boost should only exist after epoch ${schedule.firstNormalEpoch}.`,
    );
  }
  return (
    schedule.firstNormalSlot +
    (epoch - schedule.firstNormalEpoch) * schedule.slotsPerEpoch
  );
}

async function fetchEpochBoundaryTimes(
  rpcUrl: string,
  epochs: number[],
): Promise<Map<number, number>> {
  const schedule = await rpc<EpochSchedule>(rpcUrl, "getEpochSchedule");
  const uniqueEpochs = [...new Set(epochs)].sort((a, b) => a - b);
  const boundaries: Array<[number, number]> = [];
  const batchSize = 6;

  for (let offset = 0; offset < uniqueEpochs.length; offset += batchSize) {
    const batch = uniqueEpochs.slice(offset, offset + batchSize);
    const batchBoundaries = await Promise.all(
      batch.map(async (epoch): Promise<[number, number]> => {
        const firstSlot = firstSlotForEpoch(epoch, schedule);
        const blocks = await rpc<number[]>(rpcUrl, "getBlocks", [
          firstSlot,
          firstSlot + 512,
          { commitment: "finalized" },
        ]);
        const firstConfirmedBlock = blocks[0];
        if (firstConfirmedBlock === undefined) {
          throw new Error(
            `No confirmed block found near the start of epoch ${epoch}.`,
          );
        }
        const blockTime = await rpc<number | null>(rpcUrl, "getBlockTime", [
          firstConfirmedBlock,
        ]);
        if (blockTime === null) {
          throw new Error(
            `No block time found for first confirmed block ${firstConfirmedBlock} of epoch ${epoch}.`,
          );
        }
        return [epoch, blockTime];
      }),
    );
    boundaries.push(...batchBoundaries);
  }

  return new Map(boundaries);
}

async function fetchBamBoostConversions(
  rpcUrl: string,
  rewardsByEpoch: Map<number, BamBoostReward>,
): Promise<Map<number, BamBoostConversion>> {
  const allocatedRewards = [...rewardsByEpoch.values()].filter(
    (reward) => reward.status === "allocated" && reward.amount > 0n,
  );
  const conversions = new Map<number, BamBoostConversion>();

  for (const reward of rewardsByEpoch.values()) {
    if (reward.status !== "allocated" || reward.amount === 0n) {
      conversions.set(reward.earningEpoch, {
        earningEpoch: reward.earningEpoch,
        claimEpoch: reward.claimEpoch,
        jitoSolToSolRate: null,
        rateTimestampUtc: null,
        rateTimestampLocal: null,
        rewardSol: 0,
        status: "not_needed",
      });
    }
  }
  if (allocatedRewards.length === 0) return conversions;

  // Claim epoch N+1 begins when earning epoch N ends. Use the latest official
  // JitoSOL/SOL ratio at or before that boundary to value the earned reward.
  const boundaryTimes = await fetchEpochBoundaryTimes(
    rpcUrl,
    allocatedRewards.map((reward) => reward.claimEpoch),
  );
  const timestamps = [...boundaryTimes.values()];
  const dayMs = 24 * 60 * 60 * 1000;
  const start = new Date(
    Math.min(...timestamps) * 1000 - 3 * dayMs,
  ).toISOString();
  const end = new Date(Math.max(...timestamps) * 1000 + dayMs).toISOString();
  const payload = await fetchJson<JitoSolRatioResponse>(JITOSOL_SOL_RATIO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ range_filter: { start, end } }),
  });
  if (!Array.isArray(payload.ratios)) {
    throw new Error(
      "JitoSOL/SOL ratio response did not include a ratios array.",
    );
  }
  const ratios = payload.ratios
    .map((record) => ({ ...record, timestamp: Date.parse(record.date) / 1000 }))
    .filter(
      (record) =>
        Number.isFinite(record.data) &&
        record.data > 0 &&
        Number.isFinite(record.timestamp),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  if (ratios.length === 0) {
    throw new Error(
      `Jito returned no valid JitoSOL/SOL ratios for ${start} through ${end}.`,
    );
  }

  for (const reward of allocatedRewards) {
    const boundaryTime = boundaryTimes.get(reward.claimEpoch);
    if (boundaryTime === undefined) {
      throw new Error(
        `Missing epoch-boundary time for claim epoch ${reward.claimEpoch}.`,
      );
    }
    const ratio = [...ratios]
      .reverse()
      .find((record) => record.timestamp <= boundaryTime);
    if (!ratio) {
      throw new Error(
        `Jito returned no JitoSOL/SOL ratio at or before claim epoch ${reward.claimEpoch}.`,
      );
    }
    conversions.set(reward.earningEpoch, {
      earningEpoch: reward.earningEpoch,
      claimEpoch: reward.claimEpoch,
      jitoSolToSolRate: ratio.data,
      rateTimestampUtc: ratio.date,
      rateTimestampLocal: localIso(new Date(ratio.date)),
      rewardSol: roundSol(lamportsToSol(reward.amount) * ratio.data),
      status: "converted",
    });
  }

  return conversions;
}

async function fetchMarinadeBonds(
  voteAccount: string,
): Promise<MarinadeBondRecord[]> {
  const payloads = await Promise.all(
    MARINADE_BOND_TYPES.map((type) =>
      fetchJson<MarinadeBondsResponse>(
        `${MARINADE_BONDS_BASE_URL}/bonds/${type}`,
      ),
    ),
  );

  return payloads.flatMap((payload) => {
    if (!Array.isArray(payload.bonds)) {
      throw new Error(
        "Marinade Validator Bonds API response did not include a bonds array.",
      );
    }
    return payload.bonds.filter((bond) => bond.vote_account === voteAccount);
  });
}

export async function fetchMarinadeBondCosts(
  voteAccount: string,
  firstEpoch: number,
  lastEpoch: number,
): Promise<MarinadeBondCosts> {
  const bondAccounts = await fetchMarinadeBonds(voteAccount);
  if (bondAccounts.length === 0) {
    return { hasBond: false, bondAccounts, paymentsByEpoch: new Map(), estimatesByEpoch: new Map() };
  }

  const payload = await fetchJson<MarinadeProtectedEventsResponse>(
    `${MARINADE_BONDS_BASE_URL}/protected-events`,
  );
  if (!Array.isArray(payload.protected_events)) {
    throw new Error(
      "Marinade Validator Bonds API response did not include a protected_events array.",
    );
  }

  const paymentsByEpoch = new Map<number, bigint>();
  for (const event of payload.protected_events) {
    if (event.vote_account !== voteAccount) continue;
    if (event.epoch < firstEpoch || event.epoch > lastEpoch) continue;
    if (event.meta?.funder !== "ValidatorBond") continue;

    paymentsByEpoch.set(
      event.epoch,
      (paymentsByEpoch.get(event.epoch) ?? 0n) + toLamports(event.amount),
    );
  }

  const estimatesByEpoch = new Map<number, MarinadeEstimate>();
  // Global Bidding publication is a proxy for availability, not proof that
  // every validator has settled. PSR/DAO events alone do not establish it.
  const biddingPublished = new Set(payload.protected_events
    .filter(event => event.reason === "Bidding" && event.meta?.funder === "ValidatorBond")
    .map(event => event.epoch));
  if (bondAccounts.some(bond => bond.bond_type === "bidding")) {
    for (let epoch = firstEpoch; epoch <= lastEpoch; epoch++) {
      if (biddingPublished.has(epoch)) continue;
      const sam = await fetchJson<unknown>(`${MARINADE_SAM_URL}?epoch=${epoch}`);
      estimatesByEpoch.set(epoch, estimateMarinadePayment(sam, voteAccount, epoch));
    }
  }
  return { hasBond: true, bondAccounts, paymentsByEpoch, estimatesByEpoch };
}

async function collectRows(
  opts: Options,
  voteAccount: string,
): Promise<{
  currentEpoch: number;
  requestedFirstEpoch: number;
  firstEpoch: number;
  lastEpoch: number;
  rows: RevenueRow[];
  hasMarinadeBond: boolean;
  marinadeBondAccounts: MarinadeBondRecord[];
}> {
  const epochInfo = await rpc<{ epoch: number }>(opts.rpcUrl, "getEpochInfo");
  const currentEpoch = epochInfo.epoch;
  const lastEpoch = opts.includeCurrent ? currentEpoch : currentEpoch - 1;
  const requestedFirstEpoch = lastEpoch - opts.epochs + 1;

  // History that starts after the requested first epoch shortens every source's window.
  const svtRows = await fetchSvtHistory<SvtHistoryRow>(voteAccount, requestedFirstEpoch, lastEpoch, opts.epochs);
  const firstEpoch = svtRows[0].epoch;
  const svtIdentityByEpoch = new Map(
    svtRows.filter((row) => isPublicKey(row.validatorId)).map((row) => [row.epoch, row.validatorId]),
  );
  const [marinadeBondCosts, bamBoostRewards, jitoCommissionRewards] =
    await Promise.all([
      fetchMarinadeBondCosts(voteAccount, firstEpoch, lastEpoch),
      fetchBamBoostRewards(voteAccount, firstEpoch, lastEpoch, svtIdentityByEpoch),
      fetchJitoCommissionRewards(voteAccount, firstEpoch, lastEpoch),
    ]);
  const [bamBoostConversions, bamBoostClaims] = await Promise.all([
    fetchBamBoostConversions(opts.rpcUrl, bamBoostRewards),
    fetchBamBoostClaims(opts.rpcUrl, bamBoostRewards),
  ]);
  const rows = svtRows.map((row): RevenueRow => {
    const votingReward = toLamports(row.votingReward);
    const commissionReward = toLamports(row.commissionReward);
    const svtJitoInflow = toLamports(row.jitoReward);
    const jitoCommissionReward = jitoCommissionRewards.get(row.epoch);
    if (!jitoCommissionReward) {
      throw new Error(`Missing Jito commission result for epoch ${row.epoch}.`);
    }
    const jitoReward = jitoCommissionReward.operatorCommission;
    const votingCompensation = toLamports(row.votingCompensation);
    const votingFee = toLamports(row.votingFee);
    const marinadeBondPayment =
      marinadeBondCosts.paymentsByEpoch.get(row.epoch) ?? 0n;
    const marinadeEstimate = marinadeBondCosts.estimatesByEpoch.get(row.epoch);
    const bamBoostReward = bamBoostRewards.get(row.epoch);
    const bamBoostConversion = bamBoostConversions.get(row.epoch);
    const bamBoostClaim = bamBoostClaims.get(row.epoch);
    if (!bamBoostConversion) {
      throw new Error(
        `Missing BAM Boost conversion result for epoch ${row.epoch}.`,
      );
    }
    if (!bamBoostClaim) {
      throw new Error(`Missing BAM Boost claim result for epoch ${row.epoch}.`);
    }
    const baseGrossRevenue =
      votingReward + commissionReward + jitoReward + votingCompensation;
    const grossRevenueSol =
      lamportsToSol(baseGrossRevenue) + bamBoostConversion.rewardSol;
    const netRevenueSol =
      grossRevenueSol -
      lamportsToSol(votingFee) -
      lamportsToSol(marinadeBondPayment) -
      (marinadeEstimate?.paymentSol ?? 0);
    const stakeSol = stakeLamportsToSol(row.totalStake);
    const blocksProduced = Math.round(toNumber(row.leaderSlotsDone));
    const leaderSlots = Math.round(toNumber(row.leaderSlotsTotal));
    const revenueBeforeComp = votingReward + commissionReward + jitoReward;
    const revenueBeforeCompSol =
      lamportsToSol(revenueBeforeComp) + bamBoostConversion.rewardSol;
    const preCompLamportsPerKiloStake =
      stakeSol > 0
        ? (revenueBeforeCompSol * Number(LAMPORTS_PER_SOL) * 1000) / stakeSol
        : 0;

    return {
      epoch: row.epoch,
      stakeSol,
      commissionPct: row.fee === undefined ? null : toNumber(row.fee),
      votingRewardSol: roundSol(lamportsToSol(votingReward)),
      commissionRewardSol: roundSol(lamportsToSol(commissionReward)),
      jitoMevRevenueSol: roundSol(
        lamportsToSol(jitoCommissionReward.mevRevenue),
      ),
      jitoCommissionBps: jitoCommissionReward.commissionBps,
      jitoRewardSol: roundSol(lamportsToSol(jitoReward)),
      svtJitoInflowSol: roundSol(lamportsToSol(svtJitoInflow)),
      excludedSvtJitoInflowSol: roundSol(
        lamportsToSol(svtJitoInflow - jitoReward),
      ),
      jitoRewardStatus: jitoCommissionReward.status,
      bamBoostClaimEpoch: bamBoostReward?.claimEpoch ?? row.epoch + 1,
      bamBoostAllocatedJitoSol: roundSol(
        lamportsToSol(bamBoostReward?.amount ?? 0n),
      ),
      bamBoostJitoSolToSolRate: bamBoostConversion.jitoSolToSolRate,
      bamBoostRateTimestampUtc: bamBoostConversion.rateTimestampUtc ?? "",
      bamBoostRateTimestampLocal: bamBoostConversion.rateTimestampLocal ?? "",
      bamBoostAllocatedSolEquivalent: bamBoostConversion.rewardSol,
      bamBoostConversionStatus: bamBoostConversion.status,
      bamBoostAllocationStatus: bamBoostReward?.status ?? "identity_missing",
      bamBoostIdentitySource: bamBoostReward?.identitySource ?? "",
      bamBoostClaimStatus: bamBoostClaim.status,
      bamBoostClaimStatusAccount: bamBoostClaim.claimStatusAccount ?? "",
      bamBoostClaimedJitoSol:
        bamBoostClaim.status === "claimed"
          ? roundSol(lamportsToSol(bamBoostReward?.amount ?? 0n))
          : 0,
      bamBoostClaimedSolEquivalent:
        bamBoostClaim.status === "claimed" ? bamBoostConversion.rewardSol : 0,
      votingCompensationSol: roundSol(lamportsToSol(votingCompensation)),
      grossRevenueSol: roundSol(grossRevenueSol),
      votingFeeSol: roundSol(lamportsToSol(votingFee)),
      marinadeBondPaymentSol: roundSol(lamportsToSol(marinadeBondPayment)),
      marinadeBondEstimatedPaymentSol: marinadeEstimate?.paymentSol ?? 0,
      marinadeBondPaymentStatus: marinadeEstimate ? "estimated"
        : marinadeBondCosts.paymentsByEpoch.has(row.epoch) ? "reported"
        : marinadeBondCosts.hasBond ? "no_record" : "not_applicable",
      marinadeEffectiveBid: marinadeEstimate?.effectiveBid ?? null,
      marinadeActivatedStakeSol: marinadeEstimate?.activatedStakeSol ?? null,
      marinadeEstimateSource: marinadeEstimate?.source ?? "",
      netRevenueSol: roundSol(netRevenueSol),
      preCompLamportsPerKiloStake: Math.round(preCompLamportsPerKiloStake),
      blocksProduced,
      leaderSlots,
      // SVT's skippedSlots is the vote-credit shortfall, not block production.
      skipRate:
        leaderSlots > 0 && blocksProduced <= leaderSlots
          ? (((leaderSlots - blocksProduced) / leaderSlots) * 100).toFixed(4)
          : "",
    };
  });

  return {
    currentEpoch,
    requestedFirstEpoch,
    firstEpoch,
    lastEpoch,
    rows,
    hasMarinadeBond: marinadeBondCosts.hasBond,
    marinadeBondAccounts: marinadeBondCosts.bondAccounts,
  };
}

export function totals(rows: RevenueRow[]): RevenueRow {
  const total = rows.reduce(
    (acc, row) => {
      acc.stakeSol = row.stakeSol;
      acc.votingRewardSol += row.votingRewardSol;
      acc.commissionRewardSol += row.commissionRewardSol;
      acc.jitoMevRevenueSol += row.jitoMevRevenueSol;
      acc.jitoRewardSol += row.jitoRewardSol;
      acc.svtJitoInflowSol += row.svtJitoInflowSol;
      acc.excludedSvtJitoInflowSol += row.excludedSvtJitoInflowSol;
      acc.bamBoostAllocatedJitoSol += row.bamBoostAllocatedJitoSol;
      acc.bamBoostAllocatedSolEquivalent += row.bamBoostAllocatedSolEquivalent;
      acc.bamBoostClaimedJitoSol += row.bamBoostClaimedJitoSol;
      acc.bamBoostClaimedSolEquivalent += row.bamBoostClaimedSolEquivalent;
      acc.votingCompensationSol += row.votingCompensationSol;
      acc.grossRevenueSol += row.grossRevenueSol;
      acc.votingFeeSol += row.votingFeeSol;
      acc.marinadeBondPaymentSol += row.marinadeBondPaymentSol;
      acc.marinadeBondEstimatedPaymentSol += row.marinadeBondEstimatedPaymentSol;
      if (row.marinadeBondPaymentStatus === "estimated") acc.marinadeBondPaymentStatus = "estimated";
      acc.netRevenueSol += row.netRevenueSol;
      acc.preCompLamportsPerKiloStake += row.preCompLamportsPerKiloStake;
      acc.blocksProduced += row.blocksProduced;
      acc.leaderSlots += row.leaderSlots;
      return acc;
    },
    {
      epoch: 0,
      stakeSol: 0,
      commissionPct: null,
      votingRewardSol: 0,
      commissionRewardSol: 0,
      jitoMevRevenueSol: 0,
      jitoCommissionBps: null,
      jitoRewardSol: 0,
      svtJitoInflowSol: 0,
      excludedSvtJitoInflowSol: 0,
      jitoRewardStatus: "",
      bamBoostClaimEpoch: 0,
      bamBoostAllocatedJitoSol: 0,
      bamBoostJitoSolToSolRate: null,
      bamBoostRateTimestampUtc: "",
      bamBoostRateTimestampLocal: "",
      bamBoostAllocatedSolEquivalent: 0,
      bamBoostConversionStatus: "",
      bamBoostAllocationStatus: "",
      bamBoostIdentitySource: "",
      bamBoostClaimStatus: "",
      bamBoostClaimStatusAccount: "",
      bamBoostClaimedJitoSol: 0,
      bamBoostClaimedSolEquivalent: 0,
      votingCompensationSol: 0,
      grossRevenueSol: 0,
      votingFeeSol: 0,
      marinadeBondPaymentSol: 0,
      marinadeBondEstimatedPaymentSol: 0,
      marinadeBondPaymentStatus: "aggregate",
      marinadeEffectiveBid: null,
      marinadeActivatedStakeSol: null,
      marinadeEstimateSource: "",
      netRevenueSol: 0,
      preCompLamportsPerKiloStake: 0,
      blocksProduced: 0,
      leaderSlots: 0,
      skipRate: "",
    },
  );

  return {
    ...total,
    votingRewardSol: roundSol(total.votingRewardSol),
    commissionRewardSol: roundSol(total.commissionRewardSol),
    jitoMevRevenueSol: roundSol(total.jitoMevRevenueSol),
    jitoRewardSol: roundSol(total.jitoRewardSol),
    svtJitoInflowSol: roundSol(total.svtJitoInflowSol),
    excludedSvtJitoInflowSol: roundSol(total.excludedSvtJitoInflowSol),
    bamBoostAllocatedJitoSol: roundSol(total.bamBoostAllocatedJitoSol),
    bamBoostAllocatedSolEquivalent: roundSol(
      total.bamBoostAllocatedSolEquivalent,
    ),
    bamBoostClaimedJitoSol: roundSol(total.bamBoostClaimedJitoSol),
    bamBoostClaimedSolEquivalent: roundSol(total.bamBoostClaimedSolEquivalent),
    votingCompensationSol: roundSol(total.votingCompensationSol),
    grossRevenueSol: roundSol(total.grossRevenueSol),
    votingFeeSol: roundSol(total.votingFeeSol),
    marinadeBondPaymentSol: roundSol(total.marinadeBondPaymentSol),
    marinadeBondEstimatedPaymentSol: roundSol(total.marinadeBondEstimatedPaymentSol),
    netRevenueSol: roundSol(total.netRevenueSol),
  };
}

function fmtSol(value: number, digits = 6): string {
  return value.toFixed(digits);
}

function fmtTotal(value: number): string {
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, ".0");
}

function fmtInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function renderMarkdown(result: {
  voteAccount: string;
  currentEpoch: number;
  requestedFirstEpoch?: number;
  firstEpoch: number;
  lastEpoch: number;
  rows: RevenueRow[];
  hasMarinadeBond: boolean;
  marinadeBondAccounts: MarinadeBondRecord[];
}): string {
  const total = totals(result.rows);
  const epochCoverage =
    result.lastEpoch === result.currentEpoch
      ? `this covers epochs \`${result.firstEpoch}-${result.lastEpoch}\`, including current in-progress epoch \`${result.currentEpoch}\``
      : `this covers completed epochs \`${result.firstEpoch}-${result.lastEpoch}\``;
  const bamBoostDefinition =
    "BAM Boost is reported by earning epoch. JIP-31 publishes epoch N rewards under the epoch N+1 claim distributor. Allocation means the identity appears in Jito's Merkle tree; claimed means a matching Claim Status PDA exists at finalized commitment. Raw allocated JitoSOL is converted to SOL with Jito's latest official daily JitoSOL/SOL ratio at or before the first confirmed block of claim epoch N+1, and that allocated SOL value is included in gross and net revenue. Claimed amounts are shown separately using the same historical rate and are not added to revenue again.";
  const jitoDefinition =
    "Jito operator revenue is calculated from Jito's official validator rewards as floor(mevRevenue × mevCommissionBps / 10,000). The raw JPool/SVT jitoReward inflow is retained for reconciliation only; any difference is excluded from gross and net because it can include returned Tip Distribution Account rent.";
  const revenueDefinition = result.hasMarinadeBond
    ? "SOL revenue definition used: gross = votingReward + commissionReward + Jito operator commission + votingCompensation + BAM Boost converted SOL; net = gross - votingFee - reported Marinade bond payment - estimated Marinade payment. Reported payments sum ValidatorBond-funded protected-events. When an epoch has no published ValidatorBond-funded Bidding events globally, bidding-bond costs are estimated from that epoch's SAM effectiveBid × marinadeActivatedStakeSol / 1000. Estimates use auction snapshots, exclude additional penalties/PSR and can differ from final settlement. no_record means no matching published payment, not verified zero liability; global publication can be partial. This excludes other off-chain payments, infrastructure costs, and other operating costs."
    : "SOL revenue definition used: gross = votingReward + commissionReward + Jito operator commission + votingCompensation + BAM Boost converted SOL; net = gross - votingFee. No Marinade validator bond was found, so bond payments are not included. This excludes off-chain payments, infrastructure costs, and other operating costs.";
  const tableHeader = result.hasMarinadeBond
    ? "| Epoch | Stake SOL | Voting Reward | Commission | Jito Commission | Excluded SVT Jito Inflow | BAM Allocated JitoSOL | JitoSOL/SOL | BAM Allocated SOL Eq. | BAM Claimed SOL Eq. | BAM Status | Voting Comp | Gross SOL | Voting Fee | Marinade Bond Payment | Net SOL | Pre-Comp Lamports / 1k Stake | Blocks |"
    : "| Epoch | Stake SOL | Voting Reward | Commission | Jito Commission | Excluded SVT Jito Inflow | BAM Allocated JitoSOL | JitoSOL/SOL | BAM Allocated SOL Eq. | BAM Claimed SOL Eq. | BAM Status | Voting Comp | Gross SOL | Voting Fee | Net SOL | Pre-Comp Lamports / 1k Stake | Blocks |";
  const tableDivider = result.hasMarinadeBond
    ? "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|---:|---:|---:|---:|---:|---:|---:|"
    : "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|---:|---:|---:|---:|---:|---:|";
  const lines = [
    `As of current epoch \`${result.currentEpoch}\`, ${epochCoverage}.`,
    "",
    ...unavailableEpochsNote(result.requestedFirstEpoch ?? result.firstEpoch, result.firstEpoch, result.lastEpoch).flatMap((note) => [note, ""]),
    revenueDefinition,
    "",
    jitoDefinition,
    "",
    bamBoostDefinition,
    "",
    tableHeader,
    tableDivider,
  ];

  for (const row of result.rows) {
    const bondCell = result.hasMarinadeBond
      ? row.marinadeBondPaymentStatus === "estimated"
        ? ` | ${fmtSol(row.marinadeBondPaymentSol)} reported + ${fmtSol(row.marinadeBondEstimatedPaymentSol)} estimated`
        : ` | ${fmtSol(row.marinadeBondPaymentSol)} (${row.marinadeBondPaymentStatus})`
      : "";
    const jitoCommission =
      row.jitoCommissionBps === null
        ? `${fmtSol(row.jitoRewardSol)} (${row.jitoRewardStatus})`
        : `${fmtSol(row.jitoRewardSol)} (${row.jitoCommissionBps} bps)`;
    const bamRate =
      row.bamBoostJitoSolToSolRate === null
        ? "-"
        : `${row.bamBoostJitoSolToSolRate.toFixed(9)} @ ${row.bamBoostRateTimestampUtc} UTC / ${row.bamBoostRateTimestampLocal} local`;
    lines.push(
      `| ${row.epoch} | ${fmtInt(row.stakeSol)} | ${fmtSol(row.votingRewardSol)} | ${fmtSol(row.commissionRewardSol)} | ${jitoCommission} | ${fmtSol(row.excludedSvtJitoInflowSol)} | ${fmtSol(row.bamBoostAllocatedJitoSol)} | ${bamRate} | ${fmtSol(row.bamBoostAllocatedSolEquivalent)} | ${fmtSol(row.bamBoostClaimedSolEquivalent)} | ${row.bamBoostClaimEpoch} ${row.bamBoostAllocationStatus}/${row.bamBoostClaimStatus} | ${fmtSol(row.votingCompensationSol)} | ${fmtSol(row.grossRevenueSol)} | ${fmtSol(row.votingFeeSol)}${bondCell} | ${fmtSol(row.netRevenueSol)} | ${fmtInt(row.preCompLamportsPerKiloStake)} | ${row.blocksProduced}/${row.leaderSlots} |`,
    );
  }

  for (const row of result.rows.filter(row => row.marinadeBondPaymentStatus === "estimated")) {
    lines.push("", `Epoch ${row.epoch} Marinade estimate: ${row.marinadeActivatedStakeSol} SOL activated stake × effective bid ${row.marinadeEffectiveBid} (SOL per 1,000 SOL) / 1,000 = ${row.marinadeBondEstimatedPaymentSol} SOL. Source: ${row.marinadeEstimateSource}`);
  }

  lines.push(
    "",
    `Totals for epochs \`${result.firstEpoch}-${result.lastEpoch}\`:`,
    "",
    `- Voting reward: \`${fmtTotal(total.votingRewardSol)} SOL\``,
    `- Commission reward: \`${fmtTotal(total.commissionRewardSol)} SOL\``,
    `- Jito operator commission reward: \`${fmtTotal(total.jitoRewardSol)} SOL\``,
    `- Excluded SVT Jito inflow: \`${fmtTotal(total.excludedSvtJitoInflowSol)} SOL\``,
    `- BAM Boost allocated: \`${fmtTotal(total.bamBoostAllocatedJitoSol)} JitoSOL\` = \`${fmtTotal(total.bamBoostAllocatedSolEquivalent)} SOL equivalent\` at the per-epoch historical ratios above`,
    `- BAM Boost claimed: \`${fmtTotal(total.bamBoostClaimedJitoSol)} JitoSOL\` = \`${fmtTotal(total.bamBoostClaimedSolEquivalent)} SOL equivalent\` at the same historical ratios`,
    `- Voting compensation: \`${fmtTotal(total.votingCompensationSol)} SOL\``,
    `- Gross revenue: \`${fmtTotal(total.grossRevenueSol)} SOL\``,
    `- Voting fee: \`${fmtTotal(total.votingFeeSol)} SOL\``,
  );

  if (result.hasMarinadeBond) {
    lines.push(
      `- Marinade bond payment: \`${fmtTotal(total.marinadeBondPaymentSol)} SOL\``,
      `- Marinade estimated payment: \`${fmtTotal(total.marinadeBondEstimatedPaymentSol)} SOL\``,
    );
  }

  lines.push(
    `- Net revenue${total.marinadeBondPaymentStatus === "estimated" ? " (includes estimated Marinade costs)" : ""}: \`${fmtTotal(total.netRevenueSol)} SOL\``,
    `- Lamports per 1k stake before voting comp (sum across window): \`${fmtInt(total.preCompLamportsPerKiloStake)}\``,
    `- Blocks produced: \`${fmtInt(total.blocksProduced)} / ${fmtInt(total.leaderSlots)}\` leader slots`,
  );

  return lines.join("\n");
}

export function renderCsv(rows: RevenueRow[], includeMarinadeBond: boolean): string {
  const header = [
    "epoch",
    "stake_sol",
    "commission_pct",
    "voting_reward_sol",
    "commission_reward_sol",
    "jito_mev_revenue_sol",
    "jito_commission_bps",
    "jito_reward_sol",
    "svt_jito_inflow_sol",
    "excluded_svt_jito_inflow_sol",
    "jito_reward_status",
    "bam_boost_allocated_jitosol",
    "bam_boost_jitosol_to_sol_rate",
    "bam_boost_rate_timestamp_utc",
    "bam_boost_rate_timestamp_local",
    "bam_boost_allocated_sol_equivalent",
    "bam_boost_conversion_status",
    "bam_boost_claim_epoch",
    "bam_boost_allocation_status",
    "bam_boost_identity_source",
    "bam_boost_claim_status",
    "bam_boost_claim_status_account",
    "bam_boost_claimed_jitosol",
    "bam_boost_claimed_sol_equivalent",
    "voting_compensation_sol",
    "gross_revenue_sol",
    "voting_fee_sol",
    ...(includeMarinadeBond ? ["marinade_bond_payment_sol", "marinade_bond_estimated_payment_sol", "marinade_bond_payment_status", "marinade_effective_bid", "marinade_activated_stake_sol", "marinade_estimate_source"] : []),
    "net_revenue_sol",
    "lamports_per_kilo_stake_before_voting_comp",
    "blocks",
    "leader_slots",
    "skip_rate_pct",
  ];
  const body = rows.map((row) =>
    [
      row.epoch,
      row.stakeSol,
      row.commissionPct ?? "",
      row.votingRewardSol.toFixed(9),
      row.commissionRewardSol.toFixed(9),
      row.jitoMevRevenueSol.toFixed(9),
      row.jitoCommissionBps ?? "",
      row.jitoRewardSol.toFixed(9),
      row.svtJitoInflowSol.toFixed(9),
      row.excludedSvtJitoInflowSol.toFixed(9),
      row.jitoRewardStatus,
      row.bamBoostAllocatedJitoSol.toFixed(9),
      row.bamBoostJitoSolToSolRate ?? "",
      row.bamBoostRateTimestampUtc,
      row.bamBoostRateTimestampLocal,
      row.bamBoostAllocatedSolEquivalent.toFixed(9),
      row.bamBoostConversionStatus,
      row.bamBoostClaimEpoch,
      row.bamBoostAllocationStatus,
      row.bamBoostIdentitySource,
      row.bamBoostClaimStatus,
      row.bamBoostClaimStatusAccount,
      row.bamBoostClaimedJitoSol.toFixed(9),
      row.bamBoostClaimedSolEquivalent.toFixed(9),
      row.votingCompensationSol.toFixed(9),
      row.grossRevenueSol.toFixed(9),
      row.votingFeeSol.toFixed(9),
      ...(includeMarinadeBond ? [row.marinadeBondPaymentSol.toFixed(9), row.marinadeBondEstimatedPaymentSol.toFixed(9), row.marinadeBondPaymentStatus, row.marinadeEffectiveBid ?? "", row.marinadeActivatedStakeSol ?? "", row.marinadeEstimateSource] : []),
      row.netRevenueSol.toFixed(9),
      row.preCompLamportsPerKiloStake,
      row.blocksProduced,
      row.leaderSlots,
      row.skipRate,
    ].join(","),
  );
  return [header.join(","), ...body].join("\n");
}

async function main() {
  const opts = parseEpochQueryArgs(Bun.argv.slice(2), usage);
  const operator = await resolveOperator(opts);
  opts.rpcUrl = operator.rpcUrl;
  opts.voteAccount = operator.voteAccount;
  const voteAccount = operator.voteAccount;
  const result = await collectRows(opts, voteAccount);
  const payload = { voteAccount, ...result, totals: totals(result.rows) };

  if (opts.format === "json") console.log(JSON.stringify(payload, null, 2));
  else if (opts.format === "csv") {
    // CSV has no place for scope notes; keep them off stdout.
    for (const note of unavailableEpochsNote(result.requestedFirstEpoch, result.firstEpoch, result.lastEpoch)) console.error(note);
    console.log(renderCsv(result.rows, result.hasMarinadeBond));
  } else console.log(renderMarkdown({ voteAccount, ...result }));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
