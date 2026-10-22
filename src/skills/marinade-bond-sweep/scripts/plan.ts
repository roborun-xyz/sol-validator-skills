#!/usr/bin/env bun

import { optionValue } from "../../shared/cli";

import { formatSol, LAMPORTS_PER_SOL } from "../../shared/amounts";

import { localIso as formatLocalTime, localTimeZone as selectedTimeZone } from "../../shared/time";

import { resolveRpc, rpcOptions, rpcCall as rpc } from "../../shared/operator-config";

// Smallest vote-account excess worth a withdrawal transaction.
export const VOTE_WITHDRAW_THRESHOLD = 100_000_000n;
export const IDENTITY_HARD_FLOOR = 5n * LAMPORTS_PER_SOL;
// Hard floor plus headroom for identity-signed operations; the fee payer pays sweep fees.
export const IDENTITY_EXECUTION_RESERVE = 5_001_000_000n;
// Alpenglow validator admission tax debited from the vote account at each epoch start.
export const ALPENGLOW_VAT_LAMPORTS = 800_000_000n;
// Required margin above rent exemption plus one epoch's VAT for any configured vote reserve.
export const VOTE_RESERVE_MARGIN_LAMPORTS = 100_000_000n;
export const DEFAULT_VOTE_RESERVE = 3n * LAMPORTS_PER_SOL;
const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

type AccountInfo = {
  data: [string, string];
  executable: boolean;
  lamports: number;
  owner: string;
};

type VoteAccountRow = {
  nodePubkey: string;
  votePubkey: string;
};

export type VoteAction =
  | "top-up"
  | "top-up-partial"
  | "shortfall-no-surplus"
  | "skip-below-threshold"
  | "withdraw-excess";
export type IdentityAction = "skip-below-threshold" | "no-op-at-target" | "fund-bond";

export type Plan = {
  checkedAtUtc: string;
  checkedAtLocal: string;
  localTimeZone: string;
  voteAccount: string;
  identityAccount: string;
  voteBalanceLamports: string;
  voteBalanceSol: string;
  voteDataLength: number;
  voteRentExemptLamports: string;
  voteRentExemptSol: string;
  voteReserveLamports: string;
  voteReserveSol: string;
  minimumVoteReserveLamports: string;
  minimumVoteReserveSol: string;
  voteAction: VoteAction;
  voteTopUpLamports: string;
  voteTopUpSol: string;
  voteShortfallLamports: string;
  voteShortfallSol: string;
  voteTransferLamports: string;
  voteTransferSol: string;
  identityBalanceLamports: string;
  identityBalanceSol: string;
  identityTransferLamports: string;
  identityTransferSol: string;
  identityAction: IdentityAction;
  projectedIdentityAfterVoteLamports: string;
  projectedIdentityAfterVoteSol: string;
  bondFundLamports: string;
  bondFundSol: string;
  expectedFinalIdentityLamports: string;
  expectedFinalIdentitySol: string;
};

export type SweepActions = {
  voteAction: VoteAction;
  /** Lamports moved identity -> vote account by a System transfer. */
  voteTopUp: bigint;
  /** Reserve deficit that remains after the planned top-up. */
  voteShortfall: bigint;
  /** Explicit lamports withdrawn vote -> identity; only ever the excess above the reserve. */
  voteTransfer: bigint;
  identityAction: IdentityAction;
  /** Identity surplus left for the bond after any vote top-up. */
  identityTransfer: bigint;
  projectedIdentityAfterVote: bigint;
  bondFund: bigint;
  expectedFinalIdentity: bigint;
};

export function minimumVoteReserve(voteRent: bigint): bigint {
  return voteRent + ALPENGLOW_VAT_LAMPORTS + VOTE_RESERVE_MARGIN_LAMPORTS;
}

/** Refuse a vote reserve that cannot cover rent exemption, one epoch's VAT and a margin. */
export function assertVoteReserve(voteReserve: bigint, voteRent: bigint): void {
  const minimum = minimumVoteReserve(voteRent);
  if (voteReserve < minimum) {
    throw new Error(
      `vote reserve ${formatSol(voteReserve)} SOL is below the minimum ${formatSol(minimum)} SOL (rent exemption ${formatSol(voteRent)} + Alpenglow VAT ${formatSol(ALPENGLOW_VAT_LAMPORTS)} + margin ${formatSol(VOTE_RESERVE_MARGIN_LAMPORTS)})`,
    );
  }
}

/** Parse a non-negative decimal SOL amount with at most nine decimals into lamports. */
export function parseSolAmount(value: string, label = "SOL amount"): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,9}))?$/);
  if (!match) throw new Error(`${label} must be a decimal SOL amount with at most 9 decimals: ${value}`);
  return BigInt(match[1]) * LAMPORTS_PER_SOL + BigInt((match[2] ?? "").padEnd(9, "0") || "0");
}

/** Identity lamports above the execution reserve; zero below it. */
export function identitySurplus(identityBalance: bigint): bigint {
  return identityBalance > IDENTITY_EXECUTION_RESERVE ? identityBalance - IDENTITY_EXECUTION_RESERVE : 0n;
}

/** Top-up that restores the vote reserve from identity surplus: min(deficit, surplus). */
export function calculateTopUp(voteBalance: bigint, voteReserve: bigint, identityBalance: bigint) {
  const deficit = voteBalance < voteReserve ? voteReserve - voteBalance : 0n;
  const surplus = identitySurplus(identityBalance);
  const topUp = deficit < surplus ? deficit : surplus;
  return { deficit, topUp, shortfall: deficit - topUp };
}

/** Explicit vote withdrawal: the excess above the reserve, never more, never `ALL`. */
export function calculateVoteExcess(voteBalance: bigint, voteReserve: bigint): bigint {
  return voteBalance > voteReserve ? voteBalance - voteReserve : 0n;
}

export function calculateActions(
  voteBalance: bigint,
  voteRent: bigint,
  identityBalance: bigint,
  voteReserve: bigint = DEFAULT_VOTE_RESERVE,
): SweepActions {
  if (voteBalance < 0n || voteRent < 0n || identityBalance < 0n) {
    throw new Error("balances and rent must be non-negative");
  }
  assertVoteReserve(voteReserve, voteRent);

  const identityAction: IdentityAction =
    identityBalance < IDENTITY_HARD_FLOOR
      ? "skip-below-threshold"
      : identityBalance <= IDENTITY_EXECUTION_RESERVE
        ? "no-op-at-target"
        : "fund-bond";
  const surplus = identityAction === "fund-bond" ? identitySurplus(identityBalance) : 0n;

  let voteAction: VoteAction;
  let voteTopUp = 0n;
  let voteShortfall = 0n;
  let voteTransfer = 0n;
  if (voteBalance < voteReserve) {
    // Step 1: the vote reserve has priority over the bond.
    const topUp = calculateTopUp(voteBalance, voteReserve, identityBalance);
    voteTopUp = identityAction === "fund-bond" ? topUp.topUp : 0n;
    voteShortfall = topUp.deficit - voteTopUp;
    voteAction = voteTopUp === 0n ? "shortfall-no-surplus" : voteShortfall > 0n ? "top-up-partial" : "top-up";
  } else {
    const excess = calculateVoteExcess(voteBalance, voteReserve);
    voteAction = excess < VOTE_WITHDRAW_THRESHOLD ? "skip-below-threshold" : "withdraw-excess";
    voteTransfer = voteAction === "withdraw-excess" ? excess : 0n;
  }

  // Step 2: only surplus that remains after the top-up may fund the bond.
  const identityTransfer = surplus - voteTopUp;
  const projectedIdentityAfterVote = identityBalance + voteTransfer - voteTopUp;
  const bondFund = voteTransfer + identityTransfer;
  const expectedFinalIdentity = projectedIdentityAfterVote - bondFund;
  if (voteTopUp > 0n && identityBalance - voteTopUp < IDENTITY_EXECUTION_RESERVE) {
    throw new Error("vote top-up would leave the identity below its execution reserve");
  }
  assertFundingFloor(projectedIdentityAfterVote, bondFund);
  return {
    voteAction,
    voteTopUp,
    voteShortfall,
    voteTransfer,
    identityAction,
    identityTransfer,
    projectedIdentityAfterVote,
    bondFund,
    expectedFinalIdentity,
  };
}

export function assertFundingFloor(identityBalance: bigint, funding: bigint): void {
  if (funding < 0n || identityBalance < 0n) throw new Error("funding and identity balance must be non-negative");
  if (funding > 0n && identityBalance - funding < IDENTITY_HARD_FLOOR) {
    throw new Error("sweep would leave the identity below the 5 SOL hard floor; no funds may be moved under this plan");
  }
}

function usage(code = 2): never {
  console.error(
    "Usage: bun plan.ts --vote-account <PUBKEY> [--identity <EXPECTED_PUBKEY>] [--vote-reserve-sol SOL (default 3)] [--json] [--rpc URL] [--config PATH] [--profile NAME] [--field <PLAN_FIELD>]",
  );
  process.exit(code);
}

function readArg(name: string): string | undefined {
  try { return optionValue(process.argv.slice(2), name); } catch { return usage(); }
}

function safeLamports(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a safe non-negative lamport integer: ${value}`);
  }
  return BigInt(value);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage(0);

  const voteAccount = readArg("--vote-account");
  const expectedIdentity = readArg("--identity");
  const selectedField = readArg("--field");
  const asJson = process.argv.includes("--json");
  const voteReserveArg = readArg("--vote-reserve-sol");
  let voteReserve = DEFAULT_VOTE_RESERVE;
  try { if (voteReserveArg !== undefined) voteReserve = parseSolAmount(voteReserveArg, "--vote-reserve-sol"); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); usage(); }
  if (!voteAccount) usage();
  const localTimeZone = selectedTimeZone(); // Reject an invalid zone before any network call.

  const rpcUrl = (await resolveRpc(rpcOptions(process.argv.slice(2)))).rpcUrl;

  const voteInfoResult = await rpc<{ context: { slot: number }; value: AccountInfo | null }>(
    rpcUrl,
    "getAccountInfo",
    [voteAccount, { encoding: "base64", commitment: "finalized" }],
  );
  const voteInfo = voteInfoResult.value;
  if (!voteInfo) throw new Error(`vote account does not exist: ${voteAccount}`);
  if (voteInfo.owner !== VOTE_PROGRAM_ID || voteInfo.executable) {
    throw new Error(`${voteAccount} is not a non-executable Solana vote account`);
  }
  if (!Array.isArray(voteInfo.data) || voteInfo.data[1] !== "base64") {
    throw new Error("vote account RPC response did not contain base64 data");
  }
  const voteDataLength = Buffer.from(voteInfo.data[0], "base64").byteLength;

  const voteAccounts = await rpc<{
    current: VoteAccountRow[];
    delinquent: VoteAccountRow[];
  }>(rpcUrl, "getVoteAccounts", [
    { votePubkey: voteAccount, commitment: "finalized", keepUnstakedDelinquents: true },
  ]);
  const matchingVotes = [...voteAccounts.current, ...voteAccounts.delinquent].filter(
    (row) => row.votePubkey === voteAccount,
  );
  if (matchingVotes.length !== 1) {
    throw new Error(`expected one vote-account record for ${voteAccount}, found ${matchingVotes.length}`);
  }
  const identityAccount = matchingVotes[0].nodePubkey;
  if (expectedIdentity && expectedIdentity !== identityAccount) {
    throw new Error(`identity mismatch: expected ${expectedIdentity}, finalized vote state reports ${identityAccount}`);
  }

  const [rentLamportsNumber, identityInfoResult] = await Promise.all([
    rpc<number>(rpcUrl, "getMinimumBalanceForRentExemption", [
      voteDataLength,
      { commitment: "finalized" },
    ]),
    rpc<{ context: { slot: number }; value: AccountInfo | null }>(rpcUrl, "getAccountInfo", [
      identityAccount,
      { encoding: "base64", commitment: "finalized" },
    ]),
  ]);
  const identityInfo = identityInfoResult.value;
  if (!identityInfo) throw new Error(`identity account does not exist: ${identityAccount}`);
  if (identityInfo.owner !== SYSTEM_PROGRAM_ID || identityInfo.executable) {
    throw new Error(`${identityAccount} is not a non-executable system account`);
  }

  const voteBalance = safeLamports(voteInfo.lamports, "vote balance");
  const voteRent = safeLamports(rentLamportsNumber, "vote rent exemption");
  const identityBalance = safeLamports(identityInfo.lamports, "identity balance");
  let actions: SweepActions;
  try {
    actions = calculateActions(voteBalance, voteRent, identityBalance, voteReserve);
  } catch (error) {
    // A rejected plan still reports the finalized balances it was decided on.
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (finalized vote balance ${formatSol(voteBalance)} SOL, vote rent exemption ${formatSol(voteRent)} SOL, vote reserve ${formatSol(voteReserve)} SOL, identity balance ${formatSol(identityBalance)} SOL)`,
    );
  }
  const now = new Date();

  const plan: Plan = {
    checkedAtUtc: now.toISOString(),
    checkedAtLocal: formatLocalTime(now, localTimeZone),
    localTimeZone,
    voteAccount,
    identityAccount,
    voteBalanceLamports: voteBalance.toString(),
    voteBalanceSol: formatSol(voteBalance),
    voteDataLength,
    voteRentExemptLamports: voteRent.toString(),
    voteRentExemptSol: formatSol(voteRent),
    voteReserveLamports: voteReserve.toString(),
    voteReserveSol: formatSol(voteReserve),
    minimumVoteReserveLamports: minimumVoteReserve(voteRent).toString(),
    minimumVoteReserveSol: formatSol(minimumVoteReserve(voteRent)),
    voteAction: actions.voteAction,
    voteTopUpLamports: actions.voteTopUp.toString(),
    voteTopUpSol: formatSol(actions.voteTopUp),
    voteShortfallLamports: actions.voteShortfall.toString(),
    voteShortfallSol: formatSol(actions.voteShortfall),
    voteTransferLamports: actions.voteTransfer.toString(),
    voteTransferSol: formatSol(actions.voteTransfer),
    identityBalanceLamports: identityBalance.toString(),
    identityBalanceSol: formatSol(identityBalance),
    identityTransferLamports: actions.identityTransfer.toString(),
    identityTransferSol: formatSol(actions.identityTransfer),
    identityAction: actions.identityAction,
    projectedIdentityAfterVoteLamports: actions.projectedIdentityAfterVote.toString(),
    projectedIdentityAfterVoteSol: formatSol(actions.projectedIdentityAfterVote),
    bondFundLamports: actions.bondFund.toString(),
    bondFundSol: formatSol(actions.bondFund),
    expectedFinalIdentityLamports: actions.expectedFinalIdentity.toString(),
    expectedFinalIdentitySol: formatSol(actions.expectedFinalIdentity),
  };

  if (selectedField) {
    if (!(selectedField in plan)) throw new Error(`unknown plan field: ${selectedField}`);
    process.stdout.write(`${plan[selectedField as keyof Plan]}\n`);
    return;
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  console.log("# Marinade bond sweep plan");
  console.log(`Checked: ${plan.checkedAtUtc} UTC / ${plan.checkedAtLocal} local (${localTimeZone})`);
  console.log(`Vote: ${voteAccount}`);
  console.log(`Identity: ${identityAccount}`);
  console.log(`Vote balance: ${plan.voteBalanceLamports} lamports (${plan.voteBalanceSol} SOL)`);
  console.log(`Vote rent exemption: ${plan.voteRentExemptLamports} lamports (${plan.voteRentExemptSol} SOL)`);
  console.log(`Vote reserve: ${plan.voteReserveSol} SOL (minimum ${plan.minimumVoteReserveSol} SOL = rent + 0.8 SOL VAT + margin)`);
  console.log(`Vote action: ${plan.voteAction}; top up ${plan.voteTopUpSol} SOL; withdraw ${plan.voteTransferSol} SOL`);
  if (actions.voteShortfall > 0n) console.log(`WARNING: vote reserve shortfall ${plan.voteShortfallSol} SOL remains; identity surplus cannot cover it`);
  console.log(`Identity balance: ${plan.identityBalanceLamports} lamports (${plan.identityBalanceSol} SOL)`);
  console.log(`Identity action: ${plan.identityAction}; contribute ${plan.identityTransferSol} SOL`);
  console.log(`Projected identity after vote step: ${plan.projectedIdentityAfterVoteSol} SOL`);
  console.log(`Combined bond funding: ${plan.bondFundSol} SOL`);
  console.log(`Expected final identity: ${plan.expectedFinalIdentitySol} SOL`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
