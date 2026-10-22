#!/usr/bin/env bun

import { optionValue } from "../../shared/cli";

import { formatSol, LAMPORTS_PER_SOL } from "../../shared/amounts";
export { formatSol } from "../../shared/amounts";

import { localIso as formatLocalTime } from "../../shared/time";

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createRpcContext, redactRpc } from "../../shared/operator-config";
import { pollReadOnly } from "../../shared/poll";
import { PublicKey, SystemProgram, Transaction, VoteProgram } from "@solana/web3.js";
import {
  assertFundingFloor,
  assertVoteReserve,
  calculateTopUp,
  calculateVoteExcess,
  DEFAULT_VOTE_RESERVE,
  IDENTITY_HARD_FLOOR as IDENTITY_HARD_FLOOR_LAMPORTS,
  IDENTITY_EXECUTION_RESERVE as IDENTITY_EXECUTION_RESERVE_LAMPORTS,
  parseSolAmount,
  type Plan,
} from "./plan";

const DEFAULT_APPROVAL_DRIFT_LAMPORTS = 100_000_000n;
const MINIMUM_FEE_PAYER_LAMPORTS = 1_000_000n;
// Under Alpenglow the identity no longer pays vote fees, but other identity-signed
// operations may still debit it between reads. The allowance is far below the 0.1 SOL
// vote-withdrawal threshold, so it cannot hide a withdrawal that is not yet visible.
const IDENTITY_FEE_DRIFT_ALLOWANCE_LAMPORTS = 10_000_000n;
const EXPECTED_BONDS_PROGRAM = "vBoNdEvzMrSai7is21XgVYik65mqtaKXuSdMBJ1xkW4";

const repoRoot = resolve(import.meta.dir, "../../../..");
const plannerPath = resolve(import.meta.dir, "plan.ts");

type VoteAction = Plan["voteAction"];

const TOP_UP_ACTIONS: ReadonlySet<VoteAction> = new Set(["top-up", "top-up-partial"]);

type BondJson = {
  programId: string;
  publicKey: string;
  account: {
    voteAccount: string;
    authority: string;
    costPerMillePerEpoch: string;
    maxStakeWanted: string;
  };
  voteAccount?: {
    nodePubkey?: string;
    authorizedWithdrawer?: string;
  };
  amountOwned: string;
  amountActive: string;
  numberActiveStakeAccounts: number;
  amountAtSettlements: string;
  numberSettlementStakeAccounts: number;
  amountToWithdraw: string;
  withdrawRequest: string;
};

type CliArgs = {
  voteAccount: string;
  identity: string;
  identityKeypair: string;
  withdrawerKeypair: string;
  feePayerKeypair: string;
  execute: boolean;
  operatorApproved: boolean;
  approvalId?: string;
  approvedCeilingLamports?: bigint;
  approvedTopUpCeilingLamports?: bigint;
  acceptVoteShortfall: boolean;
  voteReserveLamports: bigint;
};

export type ApprovalFingerprintInput = {
  voteAccount: string;
  identity: string;
  bond: string;
  bondAuthority: string;
  identitySigner: string;
  withdrawerSigner: string;
  feePayerSigner: string;
  voteAction: VoteAction;
  voteReserveLamports: string;
  willTopUpVote: boolean;
  willFundBond: boolean;
  approvedTopUpCeilingLamports: string;
  approvedCeilingLamports: string;
};

type Preflight = {
  plan: Plan;
  bond: BondJson;
  identitySigner: string;
  withdrawerSigner: string;
  feePayerSigner: string;
  feePayerBalanceLamports: bigint;
  validatorBondsVersion: string;
  approvedCeilingLamports: bigint;
  approvedTopUpCeilingLamports: bigint;
  approvalId: string;
};

type SignatureRow = {
  signature: string;
  err: unknown;
  confirmationStatus?: string;
};

type ParsedTransaction = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    logMessages?: string[] | null;
    postBalances?: number[] | null;
  };
  transaction: {
    message: {
      accountKeys: Array<string | { pubkey: string }>;
      instructions: Array<{
        program?: string;
        parsed?: {
          type?: string;
          info?: Record<string, unknown>;
        };
      }>;
    };
  };
};

export type FundingTransactionMatch = {
  stakeAccount: string;
  blockTime: number | null;
  slot: number;
  feeLamports: number;
  identityPostBalanceLamports: number | null;
};

function usage(code = 2): never {
  console.error(
    [
      "Read-only preflight:",
      "  bun execute.ts --vote-account <PUBKEY> --identity <PUBKEY> --identity-keypair <PATH> --withdrawer-keypair <PATH> --fee-payer-keypair <PATH> [--vote-reserve-sol SOL (default 3)] [--rpc URL] [--config PATH] [--profile NAME]",
      "",
      "Execute only after explicit operator approval:",
      "  bun execute.ts ... --execute --operator-approved --approval-id <ID> --approved-ceiling-lamports <LAMPORTS> --approved-top-up-ceiling-lamports <LAMPORTS> [--accept-vote-shortfall]",
    ].join("\n"),
  );
  process.exit(code);
}

function readArg(name: string): string | undefined {
  try { return optionValue(process.argv.slice(2), name); } catch { return usage(); }
}

function requiredArg(name: string): string {
  return readArg(name) ?? usage();
}

function parseArgs(): CliArgs {
  const raw = process.argv.slice(2);
  if (raw.includes("--help")) usage(0);
  const values = new Set(["--vote-account", "--identity", "--identity-keypair", "--withdrawer-keypair", "--fee-payer-keypair", "--vote-reserve-sol", "--approval-id", "--approved-ceiling-lamports", "--approved-top-up-ceiling-lamports", "--rpc", "--config", "--profile"]);
  const flags = new Set(["--execute", "--operator-approved", "--accept-vote-shortfall"]);
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (seen.has(arg) || (!values.has(arg) && !flags.has(arg))) throw new Error("Unknown or duplicate CLI option; use --help");
    seen.add(arg);
    if (values.has(arg)) {
      if (!raw[i + 1] || raw[i + 1].startsWith("--")) usage();
      i++;
    }
  }
  const execute = process.argv.includes("--execute");
  const approvedCeiling = readArg("--approved-ceiling-lamports");
  if (approvedCeiling && !/^\d+$/.test(approvedCeiling)) usage();
  const approvedTopUpCeiling = readArg("--approved-top-up-ceiling-lamports");
  if (approvedTopUpCeiling && !/^\d+$/.test(approvedTopUpCeiling)) usage();
  const voteReserveSol = readArg("--vote-reserve-sol");
  const voteReserveLamports = voteReserveSol === undefined ? DEFAULT_VOTE_RESERVE : parseSolAmount(voteReserveSol, "--vote-reserve-sol");
  return {
    voteAccount: requiredArg("--vote-account"),
    identity: requiredArg("--identity"),
    identityKeypair: requiredArg("--identity-keypair"),
    withdrawerKeypair: requiredArg("--withdrawer-keypair"),
    feePayerKeypair: requiredArg("--fee-payer-keypair"),
    execute,
    operatorApproved: process.argv.includes("--operator-approved"),
    approvalId: readArg("--approval-id"),
    approvedCeilingLamports: approvedCeiling ? BigInt(approvedCeiling) : undefined,
    approvedTopUpCeilingLamports: approvedTopUpCeiling ? BigInt(approvedTopUpCeiling) : undefined,
    acceptVoteShortfall: process.argv.includes("--accept-vote-shortfall"),
    voteReserveLamports,
  };
}

const rpcContext = createRpcContext();
const requireRpcUrl = rpcContext.url;
export function redactSecrets(value: string, rpcUrl?: string): string {
  return rpcUrl === undefined ? rpcContext.redact(value) : redactRpc(value, rpcUrl);
}

async function runCommand(command: string[], label: string): Promise<{ stdout: string; stderr: string }> {
  const processHandle = Bun.spawn(command, {
    cwd: repoRoot,
    env: await rpcContext.environment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) {
    const detail = redactSecrets([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
    throw new Error(`${label} failed with exit code ${exitCode}${detail ? `: ${detail}` : ""}`);
  }
  return { stdout, stderr };
}

const rpc = rpcContext.rpc;

async function requireReadableFile(path: string): Promise<void> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`local signer is not a file: ${path}`);
}

async function getPlan(args: CliArgs): Promise<Plan> {
  const bunExecutable = Bun.which("bun") ?? process.execPath;
  const result = await runCommand(
    [
      bunExecutable,
      plannerPath,
      "--vote-account",
      args.voteAccount,
      "--identity",
      args.identity,
      "--vote-reserve-sol",
      formatSol(args.voteReserveLamports),
      "--json",
      "--rpc",
      await requireRpcUrl(),
    ],
    "planner",
  );
  return JSON.parse(result.stdout) as Plan;
}

async function getBond(voteAccount: string): Promise<BondJson> {
  const result = await runCommand(
    [
      "validator-bonds",
      "-u",
      await requireRpcUrl(),
      "show-bond",
      voteAccount,
      "--format",
      "json",
      "--no-advice",
    ],
    "validator-bonds show-bond",
  );
  return JSON.parse(result.stdout) as BondJson;
}

async function getSignerPubkey(path: string): Promise<string> {
  await requireReadableFile(path);
  const result = await runCommand(["solana-keygen", "pubkey", path], `solana-keygen pubkey ${path}`);
  return result.stdout.trim();
}

async function getBalance(pubkey: string): Promise<bigint> {
  const result = await rpc<{ context: { slot: number }; value: number }>("getBalance", [
    pubkey,
    { commitment: "finalized" },
  ]);
  if (!Number.isSafeInteger(result.value) || result.value < 0) {
    throw new Error(`invalid finalized balance for ${pubkey}`);
  }
  return BigInt(result.value);
}

async function getTooling(): Promise<{ version: string; help: string }> {
  const [version, help] = await Promise.all([
    runCommand(["validator-bonds", "--version"], "validator-bonds --version"),
    runCommand(["validator-bonds", "fund-bond-sol", "--help"], "validator-bonds fund-bond-sol --help"),
  ]);
  if (version.stdout.trim() !== "2.6.0") throw new Error("This executor requires validator-bonds CLI 2.6.0; install the documented pinned version before preflight");
  for (const requiredFlag of ["--simulate", "--confirmation-finality", "--amount", "--from"]) {
    if (!help.stdout.includes(requiredFlag)) {
      throw new Error(`validator-bonds fund-bond-sol help is missing ${requiredFlag}`);
    }
  }
  return { version: version.stdout.trim(), help: help.stdout };
}

function validateBond(bond: BondJson, args: CliArgs): void {
  if (bond.programId !== EXPECTED_BONDS_PROGRAM) throw new Error(`unexpected bond program: ${bond.programId}`);
  if (bond.account.voteAccount !== args.voteAccount) throw new Error("bond vote-account mismatch");
  if (bond.account.authority !== args.identity) throw new Error("bond authority mismatch");
  if (bond.voteAccount?.nodePubkey !== args.identity) throw new Error("bond live identity mismatch");
  if (bond.withdrawRequest !== "<NOT EXISTING>" || bond.amountToWithdraw !== "0 SOL") {
    throw new Error(`bond has an open withdrawal state: ${bond.withdrawRequest}; ${bond.amountToWithdraw}`);
  }
}

export function approvalFingerprint(input: ApprovalFingerprintInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function makeApprovalInput(
  args: CliArgs,
  preflight: Omit<Preflight, "approvalId">,
): ApprovalFingerprintInput {
  return {
    voteAccount: args.voteAccount,
    identity: args.identity,
    bond: preflight.bond.publicKey,
    bondAuthority: preflight.bond.account.authority,
    identitySigner: preflight.identitySigner,
    withdrawerSigner: preflight.withdrawerSigner,
    feePayerSigner: preflight.feePayerSigner,
    voteAction: preflight.plan.voteAction,
    voteReserveLamports: preflight.plan.voteReserveLamports,
    willTopUpVote: BigInt(preflight.plan.voteTopUpLamports) > 0n,
    willFundBond: BigInt(preflight.plan.bondFundLamports) > 0n,
    approvedTopUpCeilingLamports: preflight.approvedTopUpCeilingLamports.toString(),
    approvedCeilingLamports: preflight.approvedCeilingLamports.toString(),
  };
}

async function runPreflight(args: CliArgs, ceilingOverride?: bigint, topUpCeilingOverride?: bigint): Promise<Preflight> {
  await requireRpcUrl();
  const [plan, bond, identitySigner, withdrawerSigner, feePayerSigner, tooling] = await Promise.all([
    getPlan(args),
    getBond(args.voteAccount),
    getSignerPubkey(args.identityKeypair),
    getSignerPubkey(args.withdrawerKeypair),
    getSignerPubkey(args.feePayerKeypair),
    getTooling(),
  ]);
  validateBond(bond, args);
  if (plan.voteAccount !== args.voteAccount || plan.identityAccount !== args.identity) {
    throw new Error("planner account mismatch");
  }
  if (plan.voteReserveLamports !== args.voteReserveLamports.toString()) throw new Error("planner vote reserve mismatch");
  // Recheck even if a substituted or older planner accepted an unsafe reserve.
  assertVoteReserve(BigInt(plan.voteReserveLamports), BigInt(plan.voteRentExemptLamports));
  if (identitySigner !== args.identity) throw new Error("identity signer does not match the live identity");
  if (!bond.voteAccount?.authorizedWithdrawer) throw new Error("bond output omitted the vote authorized withdrawer");
  if (withdrawerSigner !== bond.voteAccount.authorizedWithdrawer) {
    throw new Error("withdrawer signer does not match the live vote authorized withdrawer");
  }
  if (feePayerSigner === args.identity) throw new Error("fee payer must differ from the validator identity");
  const feePayerBalanceLamports = await getBalance(feePayerSigner);
  if (feePayerBalanceLamports < MINIMUM_FEE_PAYER_LAMPORTS) {
    throw new Error(
      `fee payer balance ${feePayerBalanceLamports} is below the ${MINIMUM_FEE_PAYER_LAMPORTS} lamport minimum`,
    );
  }
  const proposed = BigInt(plan.bondFundLamports);
  const proposedTopUp = BigInt(plan.voteTopUpLamports);
  // Recheck even if a substituted or older planner returned an impossible sweep.
  if (TOP_UP_ACTIONS.has(plan.voteAction) && BigInt(plan.voteTransferLamports) !== 0n) {
    throw new Error("planner combined a vote top-up with a vote withdrawal");
  }
  if (proposedTopUp > 0n && BigInt(plan.identityBalanceLamports) - proposedTopUp < IDENTITY_EXECUTION_RESERVE_LAMPORTS) {
    throw new Error("proposed vote top-up would put the identity below its execution reserve");
  }
  assertFundingFloor(
    BigInt(plan.identityBalanceLamports) + BigInt(plan.voteTransferLamports) - proposedTopUp,
    proposed,
  );
  const approvedCeilingLamports = ceilingOverride ?? proposed + DEFAULT_APPROVAL_DRIFT_LAMPORTS;
  if (proposed > approvedCeilingLamports) {
    throw new Error(`proposed funding ${proposed} exceeds approved ceiling ${approvedCeilingLamports}`);
  }
  const approvedTopUpCeilingLamports =
    topUpCeilingOverride ?? (proposedTopUp > 0n ? proposedTopUp + DEFAULT_APPROVAL_DRIFT_LAMPORTS : 0n);
  if (proposedTopUp > approvedTopUpCeilingLamports) {
    throw new Error(`proposed vote top-up ${proposedTopUp} exceeds approved top-up ceiling ${approvedTopUpCeilingLamports}`);
  }
  const withoutId: Omit<Preflight, "approvalId"> = {
    plan,
    bond,
    identitySigner,
    withdrawerSigner,
    feePayerSigner,
    feePayerBalanceLamports,
    validatorBondsVersion: tooling.version,
    approvedCeilingLamports,
    approvedTopUpCeilingLamports,
  };
  return { ...withoutId, approvalId: approvalFingerprint(makeApprovalInput(args, withoutId)) };
}

function publicPreflight(preflight: Preflight, args: CliArgs) {
  return {
    mode: "preflight",
    mutationPerformed: false,
    checkedAtUtc: preflight.plan.checkedAtUtc,
    checkedAtLocal: preflight.plan.checkedAtLocal,
    validatorBondsVersion: preflight.validatorBondsVersion,
    accounts: {
      vote: args.voteAccount,
      identity: args.identity,
      bond: preflight.bond.publicKey,
      authorizedWithdrawer: preflight.withdrawerSigner,
      feePayer: preflight.feePayerSigner,
    },
    localSignerPaths: {
      identity: args.identityKeypair,
      authorizedWithdrawer: args.withdrawerKeypair,
      feePayer: args.feePayerKeypair,
    },
    balances: {
      voteLamports: preflight.plan.voteBalanceLamports,
      voteSol: preflight.plan.voteBalanceSol,
      voteRentLamports: preflight.plan.voteRentExemptLamports,
      voteRentSol: preflight.plan.voteRentExemptSol,
      voteReserveLamports: preflight.plan.voteReserveLamports,
      voteReserveSol: preflight.plan.voteReserveSol,
      minimumVoteReserveLamports: preflight.plan.minimumVoteReserveLamports,
      minimumVoteReserveSol: preflight.plan.minimumVoteReserveSol,
      identityLamports: preflight.plan.identityBalanceLamports,
      identitySol: preflight.plan.identityBalanceSol,
      feePayerLamports: preflight.feePayerBalanceLamports.toString(),
      feePayerSol: formatSol(preflight.feePayerBalanceLamports),
      bondOwned: preflight.bond.amountOwned,
    },
    action: {
      vote: preflight.plan.voteAction,
      voteTopUpLamports: preflight.plan.voteTopUpLamports,
      voteTopUpSol: preflight.plan.voteTopUpSol,
      voteShortfallLamports: preflight.plan.voteShortfallLamports,
      voteShortfallSol: preflight.plan.voteShortfallSol,
      voteTransferLamports: preflight.plan.voteTransferLamports,
      voteTransferSol: preflight.plan.voteTransferSol,
      identity: preflight.plan.identityAction,
      identityContributionLamports: preflight.plan.identityTransferLamports,
      identityContributionSol: preflight.plan.identityTransferSol,
      proposedBondFundLamports: preflight.plan.bondFundLamports,
      proposedBondFundSol: preflight.plan.bondFundSol,
      expectedFinalIdentityLamports: preflight.plan.expectedFinalIdentityLamports,
      expectedFinalIdentitySol: preflight.plan.expectedFinalIdentitySol,
    },
    bond: {
      withdrawRequest: preflight.bond.withdrawRequest,
      amountToWithdraw: preflight.bond.amountToWithdraw,
    },
    approval: {
      required: BigInt(preflight.plan.bondFundLamports) > 0n || BigInt(preflight.plan.voteTopUpLamports) > 0n,
      approvalId: preflight.approvalId,
      approvedCeilingLamports: preflight.approvedCeilingLamports.toString(),
      approvedCeilingSol: formatSol(preflight.approvedCeilingLamports),
      approvedTopUpCeilingLamports: preflight.approvedTopUpCeilingLamports.toString(),
      approvedTopUpCeilingSol: formatSol(preflight.approvedTopUpCeilingLamports),
      requiresShortfallAcceptance: preflight.plan.voteAction === "top-up-partial",
      reserveLamports: IDENTITY_EXECUTION_RESERVE_LAMPORTS.toString(),
      reserveSol: formatSol(IDENTITY_EXECUTION_RESERVE_LAMPORTS),
      warnings: [
        "Each step finalizes independently: a vote top-up or withdrawal can finalize even if later bond funding fails.",
        ...(BigInt(preflight.plan.voteShortfallLamports) > 0n
          ? [`Vote account stays ${preflight.plan.voteShortfallSol} SOL below its reserve; under Alpenglow it is not admitted for an epoch if it cannot pay rent exemption plus the 0.8 SOL VAT at that epoch start.`]
          : []),
      ],
    },
  };
}

export function parseSolLamports(value: string): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,9}))?\s+SOLs?$/);
  if (!match) throw new Error(`cannot parse SOL amount: ${value}`);
  const fraction = (match[2] ?? "").padEnd(9, "0");
  return BigInt(match[1]) * LAMPORTS_PER_SOL + BigInt(fraction || "0");
}

/**
 * Bond funding after the vote step: an identity that started above its execution reserve
 * contributes everything above that reserve (which already reflects any top-up and the
 * withdrawal); otherwise only the lamports actually withdrawn from the vote account.
 */
export function calculateFundingAfterVote(
  initial: Pick<Plan, "identityAction">,
  currentIdentityLamports: bigint,
  withdrawnLamports: bigint,
): bigint {
  if (initial.identityAction === "fund-bond") {
    return currentIdentityLamports > IDENTITY_EXECUTION_RESERVE_LAMPORTS
      ? currentIdentityLamports - IDENTITY_EXECUTION_RESERVE_LAMPORTS
      : 0n;
  }
  return withdrawnLamports;
}

/** Explicit withdrawal at execution time: the current excess, never above the approved plan amount. */
export function calculateExecutionWithdrawal(
  currentVoteLamports: bigint,
  voteReserveLamports: bigint,
  plannedLamports: bigint,
): bigint {
  const excess = calculateVoteExcess(currentVoteLamports, voteReserveLamports);
  return excess < plannedLamports ? excess : plannedLamports;
}

/** Post-withdrawal invariant: the vote account must keep at least its reserve. */
export function assertVoteAtOrAboveReserve(voteLamports: bigint, voteReserveLamports: bigint, when: string): void {
  if (voteLamports < voteReserveLamports) {
    throw new Error(`vote balance ${voteLamports} ${when} is below the vote reserve ${voteReserveLamports}`);
  }
}

/** Solana CLI amount argument: always an explicit lamport-exact SOL decimal, never `ALL`. */
export function explicitSolAmount(lamports: bigint): string {
  if (lamports <= 0n) throw new Error(`refusing a non-positive transfer amount: ${lamports}`);
  return formatSol(lamports);
}

export function parseCliSignature(output: string): string | undefined {
  return output.match(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{80,90})/)?.[1];
}
export const parseWithdrawalSignature = parseCliSignature;

/** Unsigned System transfer identity -> vote account; depositing needs no vote authority. */
export function buildTopUpTransaction(feePayer: string, identity: string, vote: string, lamports: bigint): Transaction {
  const transaction = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: new PublicKey(identity), toPubkey: new PublicKey(vote), lamports }),
  );
  transaction.feePayer = new PublicKey(feePayer);
  return transaction;
}

/** Unsigned vote withdrawal of an explicit lamport amount to the identity. */
export function buildVoteWithdrawTransaction(
  feePayer: string,
  vote: string,
  withdrawer: string,
  identity: string,
  lamports: bigint,
): Transaction {
  if (lamports <= 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`invalid withdrawal amount ${lamports}`);
  const transaction = VoteProgram.withdraw({
    votePubkey: new PublicKey(vote),
    authorizedWithdrawerPubkey: new PublicKey(withdrawer),
    lamports: Number(lamports),
    toPubkey: new PublicKey(identity),
  });
  transaction.feePayer = new PublicKey(feePayer);
  return transaction;
}

/** Read-only RPC simulation of an unsigned transaction before the CLI signs and sends it. */
async function simulateUnsigned(transaction: Transaction, label: string): Promise<void> {
  transaction.recentBlockhash = PublicKey.default.toBase58(); // Replaced by the RPC node.
  const wire = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const result = await rpc<{ value: { err: unknown; logs?: string[] | null } }>("simulateTransaction", [
    wire,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized" },
  ]);
  if (result.value.err !== null) {
    throw new Error(`${label} simulation failed: ${JSON.stringify(result.value.err)}; nothing was submitted`);
  }
}

async function confirmFinalized(signature: string): Promise<void> {
  const status = await pollReadOnly(async () => {
    const statuses = await rpc<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>(
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
    );
    const row = statuses.value[0];
    // An on-chain error is final; absence or a lower commitment may only mean this node is behind.
    return row && (row.err !== null || row.confirmationStatus === "finalized") ? row : undefined;
  });
  if (!status || status.err !== null) {
    throw new Error(`transaction is not finalized and successful: ${signature}`);
  }
}

async function getRecentSignatures(address: string): Promise<SignatureRow[]> {
  return rpc<SignatureRow[]>("getSignaturesForAddress", [
    address,
    { commitment: "finalized", limit: 20 },
  ]);
}

async function getTransaction(signature: string): Promise<ParsedTransaction | null> {
  return rpc<ParsedTransaction | null>("getTransaction", [
    signature,
    { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
}

export function matchFundingTransaction(
  transaction: ParsedTransaction,
  expected: { vote: string; identity: string; bond: string; amountLamports: bigint },
): FundingTransactionMatch | undefined {
  if (transaction.meta.err !== null) return undefined;
  const logs = transaction.meta.logMessages ?? [];
  if (!logs.some((line) => line.includes("Instruction: FundBond"))) return undefined;
  const keys = transaction.transaction.message.accountKeys.map((key) =>
    typeof key === "string" ? key : key.pubkey,
  );
  if (![expected.vote, expected.identity, expected.bond].every((key) => keys.includes(key))) return undefined;
  for (const instruction of transaction.transaction.message.instructions) {
    const info = instruction.parsed?.info;
    if (instruction.program !== "system" || instruction.parsed?.type !== "createAccount" || !info) continue;
    if (info.source !== expected.identity || typeof info.newAccount !== "string") continue;
    const lamports = typeof info.lamports === "number" ? BigInt(info.lamports) : BigInt(String(info.lamports));
    if (lamports !== expected.amountLamports) continue;
    return {
      stakeAccount: info.newAccount,
      blockTime: transaction.blockTime,
      slot: transaction.slot,
      feeLamports: transaction.meta.fee,
      identityPostBalanceLamports: transaction.meta.postBalances?.[keys.indexOf(expected.identity)] ?? null,
    };
  }
  return undefined;
}

async function findFundingTransaction(
  bond: string,
  beforeSignatures: Set<string>,
  expected: { vote: string; identity: string; bond: string; amountLamports: bigint },
): Promise<{ signature: string; match: FundingTransactionMatch }> {
  const found = await pollReadOnly(async () => {
    const rows = await getRecentSignatures(bond);
    const candidates = rows.filter((row) => row.err === null && !beforeSignatures.has(row.signature));
    const transactions = await Promise.all(candidates.map(async (row) => [row, await getTransaction(row.signature)] as const));
    for (const [row, transaction] of transactions) {
      if (!transaction) continue;
      const match = matchFundingTransaction(transaction, expected);
      if (match) return { signature: row.signature, match };
    }
    return undefined;
  });
  if (!found) throw new Error("funding command succeeded but its finalized transaction signature could not be resolved");
  return found;
}

function assertSameBond(before: BondJson, after: BondJson, args: CliArgs): void {
  validateBond(after, args);
  if (after.publicKey !== before.publicKey) throw new Error("bond account changed after approval");
}

/**
 * `show-bond` is a read-only CLI whose failures cannot be told apart, so a poll around it
 * tolerates a few of them and then surfaces the error without spending the whole bound.
 */
function fewFailures(limit = 3): () => boolean {
  let failures = 0;
  return () => ++failures <= limit;
}

function stage(name: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ stage: name, ...details })}\n`);
}

async function runFundingCommand(args: CliArgs, amountSol: string, simulate: boolean) {
  return runCommand(
    [
      "validator-bonds",
      "-u",
      await requireRpcUrl(),
      "-k",
      args.feePayerKeypair,
      ...(simulate ? ["--simulate"] : []),
      "--confirmation-finality",
      "finalized",
      "fund-bond-sol",
      args.voteAccount,
      "--from",
      args.identityKeypair,
      "--amount",
      amountSol,
    ],
    simulate ? "bond funding simulation" : "bond funding submission",
  );
}

async function readVoteAndIdentity(args: CliArgs): Promise<[bigint, bigint]> {
  const [vote, identity] = await Promise.all([getBalance(args.voteAccount), getBalance(args.identity)]);
  return [vote, identity];
}

async function executeApproved(args: CliArgs): Promise<Record<string, unknown>> {
  if (
    !args.operatorApproved ||
    !args.approvalId ||
    args.approvedCeilingLamports === undefined ||
    args.approvedTopUpCeilingLamports === undefined
  ) {
    throw new Error(
      "execution requires --operator-approved, --approval-id, --approved-ceiling-lamports and --approved-top-up-ceiling-lamports after explicit operator confirmation",
    );
  }
  const preflight = await runPreflight(args, args.approvedCeilingLamports, args.approvedTopUpCeilingLamports);
  if (preflight.approvalId !== args.approvalId) {
    throw new Error(
      `approval mismatch: expected ${args.approvalId}, current non-balance state produces ${preflight.approvalId}`,
    );
  }
  if (preflight.plan.voteAction === "top-up-partial" && !args.acceptVoteShortfall) {
    throw new Error(
      `identity surplus covers only part of the vote reserve deficit (shortfall ${preflight.plan.voteShortfallSol} SOL); a partial top-up requires --accept-vote-shortfall after explicit operator approval`,
    );
  }
  stage("approved-state-rechecked", {
    checkedAtUtc: preflight.plan.checkedAtUtc,
    voteAction: preflight.plan.voteAction,
    proposedVoteTopUpLamports: preflight.plan.voteTopUpLamports,
    proposedBondFundLamports: preflight.plan.bondFundLamports,
    approvedTopUpCeilingLamports: preflight.approvedTopUpCeilingLamports.toString(),
    approvedCeilingLamports: preflight.approvedCeilingLamports.toString(),
  });

  const initialPlan = preflight.plan;
  const voteReserveLamports = BigInt(initialPlan.voteReserveLamports);
  const skipped: string[] = [];
  const warnings: string[] = [];
  let voteTopUpSignature: string | undefined;
  let voteWithdrawalSignature: string | undefined;
  let toppedUpLamports = 0n;
  let withdrawnLamports = 0n;

  // Step 1: restore the vote reserve from identity surplus before anything else.
  if (TOP_UP_ACTIONS.has(initialPlan.voteAction)) {
    const [voteBefore, identityBefore] = await readVoteAndIdentity(args);
    const { topUp, shortfall } = calculateTopUp(voteBefore, voteReserveLamports, identityBefore);
    if (topUp <= 0n) {
      skipped.push(
        voteBefore >= voteReserveLamports
          ? "vote top-up: vote balance already reached its reserve"
          : "vote top-up: no identity surplus above the execution reserve",
      );
      stage("vote-top-up-skipped", { voteLamports: voteBefore.toString(), identityLamports: identityBefore.toString() });
    } else {
      if (topUp > preflight.approvedTopUpCeilingLamports) {
        throw new Error(
          `recalculated vote top-up ${topUp} exceeds approved top-up ceiling ${preflight.approvedTopUpCeilingLamports}; nothing was submitted`,
        );
      }
      if (shortfall > 0n && !args.acceptVoteShortfall) {
        throw new Error(
          `recalculated vote top-up leaves a ${formatSol(shortfall)} SOL reserve shortfall; obtain approval with --accept-vote-shortfall; nothing was submitted`,
        );
      }
      if (identityBefore - topUp < IDENTITY_EXECUTION_RESERVE_LAMPORTS) {
        throw new Error("vote top-up would put the identity below its execution reserve; nothing was submitted");
      }
      const topUpSol = explicitSolAmount(topUp);
      stage("vote-top-up-simulation", { amountLamports: topUp.toString(), amountSol: topUpSol });
      await simulateUnsigned(
        buildTopUpTransaction(preflight.feePayerSigner, args.identity, args.voteAccount, topUp),
        "vote top-up",
      );
      stage("vote-top-up-submit", { amountLamports: topUp.toString() });
      const transfer = await runCommand(
        [
          "solana",
          "transfer",
          "-u",
          await requireRpcUrl(),
          "--commitment",
          "finalized",
          "--fee-payer",
          args.feePayerKeypair,
          "--from",
          args.identityKeypair,
          args.voteAccount,
          topUpSol,
        ],
        "vote top-up transfer",
      );
      voteTopUpSignature = parseCliSignature(`${transfer.stdout}\n${transfer.stderr}`);
      if (!voteTopUpSignature) throw new Error("vote top-up succeeded but its signature was not printed");
      await confirmFinalized(voteTopUpSignature);
      stage("vote-top-up-finalized", { signature: voteTopUpSignature });
      toppedUpLamports = topUp;

      let [voteAfter, identityAfter] = [voteBefore, identityBefore];
      const visible = await pollReadOnly(async () => {
        [voteAfter, identityAfter] = await readVoteAndIdentity(args);
        return voteAfter >= voteBefore + topUp ? true : undefined;
      });
      if (!visible) {
        throw new Error(
          `vote top-up ${voteTopUpSignature} finalized but the finalized vote balance ${voteAfter} does not include it; no bond funding was submitted`,
        );
      }
      if (identityAfter < IDENTITY_HARD_FLOOR_LAMPORTS) {
        throw new Error(`identity balance ${identityAfter} after the vote top-up is below the 5 SOL hard floor`);
      }
      if (voteAfter < voteReserveLamports) warnings.push(`vote balance ${voteAfter} remains below its reserve ${voteReserveLamports}`);
    }
  }

  // Step 2a: withdraw only the vote excess above the reserve, as an explicit amount.
  if (initialPlan.voteAction === "withdraw-excess") {
    const [voteBefore, identityBefore] = await readVoteAndIdentity(args);
    const amount = calculateExecutionWithdrawal(voteBefore, voteReserveLamports, BigInt(initialPlan.voteTransferLamports));
    if (amount <= 0n) {
      skipped.push("vote withdrawal: no excess above the vote reserve");
      stage("vote-withdrawal-skipped", { voteLamports: voteBefore.toString() });
    } else {
      const amountSol = explicitSolAmount(amount);
      stage("vote-withdrawal-simulation", { amountLamports: amount.toString(), amountSol });
      await simulateUnsigned(
        buildVoteWithdrawTransaction(preflight.feePayerSigner, args.voteAccount, preflight.withdrawerSigner, args.identity, amount),
        "vote withdrawal",
      );
      const withdrawal = await runCommand(
        [
          "solana",
          "withdraw-from-vote-account",
          "-u",
          await requireRpcUrl(),
          "--commitment",
          "finalized",
          "--fee-payer",
          args.feePayerKeypair,
          "--authorized-withdrawer",
          args.withdrawerKeypair,
          args.voteAccount,
          args.identity,
          amountSol,
        ],
        "vote-account withdrawal",
      );
      voteWithdrawalSignature = parseCliSignature(`${withdrawal.stdout}\n${withdrawal.stderr}`);
      if (!voteWithdrawalSignature) throw new Error("vote withdrawal succeeded but its signature was not printed");
      await confirmFinalized(voteWithdrawalSignature);
      stage("vote-withdrawal-finalized", { signature: voteWithdrawalSignature });
      withdrawnLamports = amount;

      // Wait within a fixed bound for the finalized withdrawal to be visible in the identity,
      // which sizes the bond funding. Vote growth (e.g. block revenue) is tolerated.
      const identityWithWithdrawal = identityBefore + amount - IDENTITY_FEE_DRIFT_ALLOWANCE_LAMPORTS;
      let [voteLamports, identityLamports] = [voteBefore, identityBefore];
      const visible = await pollReadOnly(async () => {
        [voteLamports, identityLamports] = await readVoteAndIdentity(args);
        return identityLamports >= identityWithWithdrawal ? true : undefined;
      });
      assertVoteAtOrAboveReserve(voteLamports, voteReserveLamports, "after withdrawal");
      if (!visible) {
        throw new Error(
          `identity balance ${identityLamports} does not yet include the withdrawn ${amount} lamports; no bond funding was submitted`,
        );
      }
    }
  }

  // Step 2b: fund the bond only from what remains after the vote step has finalized.
  const [voteBeforeFunding, currentIdentityLamports] = await readVoteAndIdentity(args);
  const fundingLamports = calculateFundingAfterVote(initialPlan, currentIdentityLamports, withdrawnLamports);
  const base = {
    mode: "execute",
    approvalId: preflight.approvalId,
    voteReserveLamports: voteReserveLamports.toString(),
    transactions: {
      voteTopUpSignature,
      voteTopUpLamports: toppedUpLamports.toString(),
      voteWithdrawalSignature,
      voteWithdrawalLamports: withdrawnLamports.toString(),
    },
  };
  if (fundingLamports <= 0n) {
    const completedAt = new Date();
    return {
      ...base,
      completed: true,
      completedAtUtc: completedAt.toISOString(),
      completedAtLocal: formatLocalTime(completedAt, initialPlan.localTimeZone),
      bondFundingSkipped: true,
      reason: "recalculated funding is zero",
      skipped,
      warnings,
      after: {
        voteBalanceLamports: voteBeforeFunding.toString(),
        identityBalanceLamports: currentIdentityLamports.toString(),
        identityBalanceSol: formatSol(currentIdentityLamports),
      },
    };
  }
  if (voteBeforeFunding < voteReserveLamports) {
    throw new Error(
      `vote balance ${voteBeforeFunding} is below its reserve ${voteReserveLamports}; the vote reserve has priority, so no bond funding was submitted. Run a fresh plan.`,
    );
  }
  if (fundingLamports > preflight.approvedCeilingLamports) {
    throw new Error(
      `recalculated funding ${fundingLamports} exceeds approved ceiling ${preflight.approvedCeilingLamports}`,
    );
  }
  if (currentIdentityLamports < fundingLamports || currentIdentityLamports - fundingLamports < IDENTITY_HARD_FLOOR_LAMPORTS) {
    throw new Error("recalculated funding would put the identity below the 5 SOL hard floor");
  }
  const currentBond = (await pollReadOnly(() => getBond(args.voteAccount), 20, 1_500, fewFailures()))!;
  assertSameBond(preflight.bond, currentBond, args);

  const fundingSol = explicitSolAmount(fundingLamports);
  stage("bond-funding-simulation", { amountLamports: fundingLamports.toString(), amountSol: fundingSol });
  await runFundingCommand(args, fundingSol, true);

  const identityAfterSimulation = await getBalance(args.identity);
  if (
    identityAfterSimulation < fundingLamports ||
    identityAfterSimulation - fundingLamports < IDENTITY_HARD_FLOOR_LAMPORTS
  ) {
    throw new Error(
      `after simulation, submitting ${fundingLamports} would leave ${identityAfterSimulation - fundingLamports} lamports`,
    );
  }

  const beforeFundingSignatures = new Set(
    (await getRecentSignatures(currentBond.publicKey)).map((row) => row.signature),
  );
  const bondOwnedBeforeFundingLamports = parseSolLamports(currentBond.amountOwned);
  stage("bond-funding-submit", {
    amountLamports: fundingLamports.toString(),
    projectedIdentityLamports: (identityAfterSimulation - fundingLamports).toString(),
  });
  await runFundingCommand(args, fundingSol, false);

  const fundingTransaction = await findFundingTransaction(currentBond.publicKey, beforeFundingSignatures, {
    vote: args.voteAccount,
    identity: args.identity,
    bond: currentBond.publicKey,
    amountLamports: fundingLamports,
  });
  await confirmFinalized(fundingTransaction.signature);
  stage("bond-funding-finalized", { signature: fundingTransaction.signature });

  // Same bound for the finalized funding to appear in the bond's owned amount.
  let finalBond = currentBond;
  await pollReadOnly(async () => {
    finalBond = await getBond(args.voteAccount);
    return parseSolLamports(finalBond.amountOwned) - bondOwnedBeforeFundingLamports >= fundingLamports ? true : undefined;
  }, 20, 1_500, fewFailures());
  assertSameBond(currentBond, finalBond, args);
  let [finalVoteLamports, finalIdentityLamports] = [voteBeforeFunding, currentIdentityLamports];
  const voteAtReserve = await pollReadOnly(async () => {
    [finalVoteLamports, finalIdentityLamports] = await readVoteAndIdentity(args);
    return finalVoteLamports >= voteReserveLamports ? true : undefined;
  });
  // Bond funding does not touch the vote account; only an epoch-start VAT debit can lower it here.
  if (!voteAtReserve) {
    warnings.push(`final vote balance ${finalVoteLamports} is below its reserve ${voteReserveLamports}; check for an epoch-start VAT debit and re-plan`);
  }
  // The hard floor is what the funding transaction left in the identity.
  const identityAfterFundingLamports =
    fundingTransaction.match.identityPostBalanceLamports === null
      ? finalIdentityLamports
      : BigInt(fundingTransaction.match.identityPostBalanceLamports);
  if (identityAfterFundingLamports < IDENTITY_HARD_FLOOR_LAMPORTS) {
    throw new Error(`identity balance ${identityAfterFundingLamports} after funding is below the 5 SOL hard floor`);
  }
  const finalBondOwnedLamports = parseSolLamports(finalBond.amountOwned);
  if (finalBondOwnedLamports - bondOwnedBeforeFundingLamports < fundingLamports) {
    throw new Error("final bond ownership did not increase by the funded amount");
  }

  const completedAt = new Date();
  return {
    ...base,
    completed: true,
    completedAtUtc: completedAt.toISOString(),
    completedAtLocal: formatLocalTime(completedAt, initialPlan.localTimeZone),
    approvedTopUpCeilingLamports: preflight.approvedTopUpCeilingLamports.toString(),
    approvedCeilingLamports: preflight.approvedCeilingLamports.toString(),
    skipped,
    warnings,
    before: {
      voteBalanceLamports: initialPlan.voteBalanceLamports,
      identityBalanceLamports: initialPlan.identityBalanceLamports,
      bondOwnedLamports: parseSolLamports(preflight.bond.amountOwned).toString(),
    },
    transactions: {
      ...base.transactions,
      bondFundingSignature: fundingTransaction.signature,
      bondFundingSlot: fundingTransaction.match.slot,
      bondFundingBlockTime: fundingTransaction.match.blockTime,
      bondFundingFeeLamports: fundingTransaction.match.feeLamports,
      fundedStakeAccount: fundingTransaction.match.stakeAccount,
      bondFundLamports: fundingLamports.toString(),
      bondFundSol: fundingSol,
      identityBalanceAfterFundingLamports: identityAfterFundingLamports.toString(),
    },
    after: {
      voteBalanceLamports: finalVoteLamports.toString(),
      voteReserveLamports: voteReserveLamports.toString(),
      voteRentLamports: initialPlan.voteRentExemptLamports,
      identityBalanceLamports: finalIdentityLamports.toString(),
      identityBalanceSol: formatSol(finalIdentityLamports),
      bondOwnedLamports: finalBondOwnedLamports.toString(),
      bondOwned: finalBond.amountOwned,
      withdrawRequest: finalBond.withdrawRequest,
    },
  };
}

async function main() {
  const args = parseArgs();
  if (!args.execute) {
    const preflight = await runPreflight(args);
    process.stdout.write(`${JSON.stringify(publicPreflight(preflight, args), null, 2)}\n`);
    return;
  }
  const result = await executeApproved(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
}
