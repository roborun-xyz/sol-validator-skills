#!/usr/bin/env bun

import { optionValue } from "../../shared/cli";

import { formatSol, LAMPORTS_PER_SOL } from "../../shared/amounts";

import { localIso as formatLocalTime, localTimeZone as selectedTimeZone } from "../../shared/time";

import { resolveRpc, rpcOptions, rpcCall as rpc } from "../../shared/operator-config";

const VOTE_THRESHOLD = 1n * LAMPORTS_PER_SOL;
export const IDENTITY_HARD_FLOOR = 5n * LAMPORTS_PER_SOL;
export const IDENTITY_EXECUTION_RESERVE = 5_001_000_000n;
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
  voteAction: "skip-below-threshold" | "withdraw-all";
  voteTransferLamports: string;
  voteTransferSol: string;
  identityBalanceLamports: string;
  identityBalanceSol: string;
  identityTransferLamports: string;
  identityTransferSol: string;
  identityAction: "skip-below-threshold" | "no-op-at-target" | "fund-bond";
  projectedIdentityAfterVoteLamports: string;
  projectedIdentityAfterVoteSol: string;
  bondFundLamports: string;
  bondFundSol: string;
  expectedFinalIdentityLamports: string;
  expectedFinalIdentitySol: string;
};

export type SweepActions = {
  voteAction: "skip-below-threshold" | "withdraw-all";
  voteTransfer: bigint;
  identityAction: "skip-below-threshold" | "no-op-at-target" | "fund-bond";
  identityTransfer: bigint;
  projectedIdentityAfterVote: bigint;
  bondFund: bigint;
  expectedFinalIdentity: bigint;
};

function usage(code = 2): never {
  console.error(
    "Usage: bun plan.ts --vote-account <PUBKEY> [--identity <EXPECTED_PUBKEY>] [--json] [--rpc URL] [--config PATH] [--profile NAME] [--field <PLAN_FIELD>]",
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

export function calculateActions(
  voteBalance: bigint,
  voteRent: bigint,
  identityBalance: bigint,
): SweepActions {
  if (voteBalance < 0n || voteRent < 0n || identityBalance < 0n) {
    throw new Error("balances and rent must be non-negative");
  }
  if (voteBalance < voteRent) {
    throw new Error(`vote balance ${voteBalance} is below its rent-exempt minimum ${voteRent}`);
  }

  const voteAction = voteBalance < VOTE_THRESHOLD ? "skip-below-threshold" : "withdraw-all";
  const voteTransfer = voteAction === "withdraw-all" ? voteBalance - voteRent : 0n;
  const identityAction =
    identityBalance < IDENTITY_HARD_FLOOR
      ? "skip-below-threshold"
      : identityBalance <= IDENTITY_EXECUTION_RESERVE
        ? "no-op-at-target"
        : "fund-bond";
  const identityTransfer =
    identityAction === "fund-bond" ? identityBalance - IDENTITY_EXECUTION_RESERVE : 0n;
  const projectedIdentityAfterVote = identityBalance + voteTransfer;
  const bondFund = voteTransfer + identityTransfer;
  const expectedFinalIdentity = projectedIdentityAfterVote - bondFund;
  assertFundingFloor(projectedIdentityAfterVote, bondFund);
  return {
    voteAction,
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

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage(0);

  const voteAccount = readArg("--vote-account");
  const expectedIdentity = readArg("--identity");
  const selectedField = readArg("--field");
  const asJson = process.argv.includes("--json");
  if (!voteAccount) usage();

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
    actions = calculateActions(voteBalance, voteRent, identityBalance);
  } catch (error) {
    // A rejected plan still reports the finalized balances it was decided on.
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (finalized vote balance ${formatSol(voteBalance)} SOL, vote rent reserve ${formatSol(voteRent)} SOL, identity balance ${formatSol(identityBalance)} SOL)`,
    );
  }
  const now = new Date();
  const localTimeZone = selectedTimeZone();

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
    voteAction: actions.voteAction,
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
  console.log(`Vote rent reserve: ${plan.voteRentExemptLamports} lamports (${plan.voteRentExemptSol} SOL)`);
  console.log(`Vote action: ${plan.voteAction}; transfer ${plan.voteTransferSol} SOL`);
  console.log(`Identity balance: ${plan.identityBalanceLamports} lamports (${plan.identityBalanceSol} SOL)`);
  console.log(`Identity action: ${plan.identityAction}; contribute ${plan.identityTransferSol} SOL`);
  console.log(`Projected identity after vote withdrawal: ${plan.projectedIdentityAfterVoteSol} SOL`);
  console.log(`Combined bond funding: ${plan.bondFundSol} SOL`);
  console.log(`Expected final identity: ${plan.expectedFinalIdentitySol} SOL`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
