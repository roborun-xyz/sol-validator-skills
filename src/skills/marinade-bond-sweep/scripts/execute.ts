#!/usr/bin/env bun

import { optionValue } from "../../shared/cli";

import { formatSol, LAMPORTS_PER_SOL } from "../../shared/amounts";
export { formatSol } from "../../shared/amounts";

import { localIso as formatLocalTime } from "../../shared/time";

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createRpcContext, redactRpc } from "../../shared/operator-config";
import {
  assertFundingFloor,
  IDENTITY_HARD_FLOOR as IDENTITY_HARD_FLOOR_LAMPORTS,
  IDENTITY_EXECUTION_RESERVE as IDENTITY_EXECUTION_RESERVE_LAMPORTS,
  type Plan,
} from "./plan";

const DEFAULT_APPROVAL_DRIFT_LAMPORTS = 100_000_000n;
const MINIMUM_FEE_PAYER_LAMPORTS = 1_000_000n;
const EXPECTED_BONDS_PROGRAM = "vBoNdEvzMrSai7is21XgVYik65mqtaKXuSdMBJ1xkW4";

const repoRoot = resolve(import.meta.dir, "../../../..");
const plannerPath = resolve(import.meta.dir, "plan.ts");

type VoteAction = Plan["voteAction"];

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
  willFundBond: boolean;
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
};

function usage(code = 2): never {
  console.error(
    [
      "Read-only preflight:",
      "  bun execute.ts --vote-account <PUBKEY> --identity <PUBKEY> --identity-keypair <PATH> --withdrawer-keypair <PATH> --fee-payer-keypair <PATH> [--rpc URL] [--config PATH] [--profile NAME]",
      "",
      "Execute only after explicit operator approval:",
      "  bun execute.ts ... --execute --operator-approved --approval-id <ID> --approved-ceiling-lamports <LAMPORTS>",
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
  const values = new Set(["--vote-account", "--identity", "--identity-keypair", "--withdrawer-keypair", "--fee-payer-keypair", "--approval-id", "--approved-ceiling-lamports", "--rpc", "--config", "--profile"]);
  const flags = new Set(["--execute", "--operator-approved"]);
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
    willFundBond: BigInt(preflight.plan.bondFundLamports) > 0n,
    approvedCeilingLamports: preflight.approvedCeilingLamports.toString(),
  };
}

async function runPreflight(args: CliArgs, ceilingOverride?: bigint): Promise<Preflight> {
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
  // Recheck even if a substituted or older planner returned an impossible sweep.
  assertFundingFloor(BigInt(plan.identityBalanceLamports) + BigInt(plan.voteTransferLamports), proposed);
  const approvedCeilingLamports = ceilingOverride ?? proposed + DEFAULT_APPROVAL_DRIFT_LAMPORTS;
  if (proposed > approvedCeilingLamports) {
    throw new Error(`proposed funding ${proposed} exceeds approved ceiling ${approvedCeilingLamports}`);
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
      identityLamports: preflight.plan.identityBalanceLamports,
      identitySol: preflight.plan.identityBalanceSol,
      feePayerLamports: preflight.feePayerBalanceLamports.toString(),
      feePayerSol: formatSol(preflight.feePayerBalanceLamports),
      bondOwned: preflight.bond.amountOwned,
    },
    action: {
      vote: preflight.plan.voteAction,
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
      required: BigInt(preflight.plan.bondFundLamports) > 0n,
      approvalId: preflight.approvalId,
      approvedCeilingLamports: preflight.approvedCeilingLamports.toString(),
      approvedCeilingSol: formatSol(preflight.approvedCeilingLamports),
      reserveLamports: IDENTITY_EXECUTION_RESERVE_LAMPORTS.toString(),
      reserveSol: formatSol(IDENTITY_EXECUTION_RESERVE_LAMPORTS),
      warning: "Vote withdrawal can finalize even if later bond funding fails.",
    },
  };
}

export function parseSolLamports(value: string): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,9}))?\s+SOLs?$/);
  if (!match) throw new Error(`cannot parse SOL amount: ${value}`);
  const fraction = (match[2] ?? "").padEnd(9, "0");
  return BigInt(match[1]) * LAMPORTS_PER_SOL + BigInt(fraction || "0");
}

export function calculateFundingAfterVote(
  initial: Pick<Plan, "identityAction" | "voteTransferLamports">,
  currentIdentityLamports: bigint,
): bigint {
  if (initial.identityAction === "fund-bond") {
    return currentIdentityLamports > IDENTITY_EXECUTION_RESERVE_LAMPORTS
      ? currentIdentityLamports - IDENTITY_EXECUTION_RESERVE_LAMPORTS
      : 0n;
  }
  return BigInt(initial.voteTransferLamports);
}

export function parseWithdrawalSignature(output: string): string | undefined {
  return output.match(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{80,90})/)?.[1];
}

async function confirmFinalized(signature: string): Promise<void> {
  const statuses = await rpc<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>(
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
  );
  const status = statuses.value[0];
  if (!status || status.err !== null || status.confirmationStatus !== "finalized") {
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
    };
  }
  return undefined;
}

async function findFundingTransaction(
  bond: string,
  beforeSignatures: Set<string>,
  expected: { vote: string; identity: string; bond: string; amountLamports: bigint },
): Promise<{ signature: string; match: FundingTransactionMatch }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rows = await getRecentSignatures(bond);
    const candidates = rows.filter((row) => row.err === null && !beforeSignatures.has(row.signature));
    const transactions = await Promise.all(candidates.map(async (row) => [row, await getTransaction(row.signature)] as const));
    for (const [row, transaction] of transactions) {
      if (!transaction) continue;
      const match = matchFundingTransaction(transaction, expected);
      if (match) return { signature: row.signature, match };
    }
    await Bun.sleep(750);
  }
  throw new Error("funding command succeeded but its finalized transaction signature could not be resolved");
}

function assertSameBond(before: BondJson, after: BondJson, args: CliArgs): void {
  validateBond(after, args);
  if (after.publicKey !== before.publicKey) throw new Error("bond account changed after approval");
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

async function executeApproved(args: CliArgs): Promise<Record<string, unknown>> {
  if (!args.operatorApproved || !args.approvalId || args.approvedCeilingLamports === undefined) {
    throw new Error(
      "execution requires --operator-approved, --approval-id, and --approved-ceiling-lamports after explicit operator confirmation",
    );
  }
  const preflight = await runPreflight(args, args.approvedCeilingLamports);
  if (preflight.approvalId !== args.approvalId) {
    throw new Error(
      `approval mismatch: expected ${args.approvalId}, current non-balance state produces ${preflight.approvalId}`,
    );
  }
  stage("approved-state-rechecked", {
    checkedAtUtc: preflight.plan.checkedAtUtc,
    proposedBondFundLamports: preflight.plan.bondFundLamports,
    approvedCeilingLamports: preflight.approvedCeilingLamports.toString(),
  });

  const initialPlan = preflight.plan;
  let currentPlan = initialPlan;
  let currentBond = preflight.bond;
  let voteWithdrawalSignature: string | undefined;

  if (initialPlan.voteAction === "withdraw-all") {
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
        "ALL",
      ],
      "vote-account withdrawal",
    );
    voteWithdrawalSignature = parseWithdrawalSignature(`${withdrawal.stdout}\n${withdrawal.stderr}`);
    if (!voteWithdrawalSignature) throw new Error("vote withdrawal succeeded but its signature was not printed");
    await confirmFinalized(voteWithdrawalSignature);
    stage("vote-withdrawal-finalized", { signature: voteWithdrawalSignature });

    [currentPlan, currentBond] = await Promise.all([getPlan(args), getBond(args.voteAccount)]);
    assertSameBond(preflight.bond, currentBond, args);
    if (currentPlan.voteBalanceLamports !== currentPlan.voteRentExemptLamports) {
      throw new Error(
        `vote balance ${currentPlan.voteBalanceLamports} does not equal rent reserve ${currentPlan.voteRentExemptLamports}`,
      );
    }
  }

  const currentIdentityLamports = BigInt(currentPlan.identityBalanceLamports);
  const fundingLamports = calculateFundingAfterVote(initialPlan, currentIdentityLamports);
  if (fundingLamports > preflight.approvedCeilingLamports) {
    throw new Error(
      `recalculated funding ${fundingLamports} exceeds approved ceiling ${preflight.approvedCeilingLamports}`,
    );
  }
  if (fundingLamports === 0n) {
    return {
      mode: "execute",
      completed: true,
      voteWithdrawalSignature,
      bondFundingSkipped: true,
      reason: "recalculated funding is zero",
    };
  }
  if (currentIdentityLamports < fundingLamports || currentIdentityLamports - fundingLamports < IDENTITY_HARD_FLOOR_LAMPORTS) {
    throw new Error("recalculated funding would put the identity below the 5 SOL hard floor");
  }

  const fundingSol = formatSol(fundingLamports);
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

  const [finalPlan, finalBond] = await Promise.all([getPlan(args), getBond(args.voteAccount)]);
  assertSameBond(currentBond, finalBond, args);
  if (initialPlan.voteAction === "withdraw-all" && finalPlan.voteBalanceLamports !== finalPlan.voteRentExemptLamports) {
    throw new Error("final vote balance no longer equals its rent reserve");
  }
  if (BigInt(finalPlan.identityBalanceLamports) < IDENTITY_HARD_FLOOR_LAMPORTS) {
    throw new Error(`final identity balance ${finalPlan.identityBalanceLamports} is below the 5 SOL hard floor`);
  }
  const finalBondOwnedLamports = parseSolLamports(finalBond.amountOwned);
  if (finalBondOwnedLamports - bondOwnedBeforeFundingLamports < fundingLamports) {
    throw new Error("final bond ownership did not increase by the funded amount");
  }

  const completedAt = new Date();
  return {
    mode: "execute",
    completed: true,
    completedAtUtc: completedAt.toISOString(),
    completedAtLocal: formatLocalTime(completedAt),
    approvalId: preflight.approvalId,
    approvedCeilingLamports: preflight.approvedCeilingLamports.toString(),
    before: {
      voteBalanceLamports: initialPlan.voteBalanceLamports,
      identityBalanceLamports: initialPlan.identityBalanceLamports,
      bondOwnedLamports: parseSolLamports(preflight.bond.amountOwned).toString(),
    },
    transactions: {
      voteWithdrawalSignature,
      bondFundingSignature: fundingTransaction.signature,
      bondFundingSlot: fundingTransaction.match.slot,
      bondFundingBlockTime: fundingTransaction.match.blockTime,
      bondFundingFeeLamports: fundingTransaction.match.feeLamports,
      fundedStakeAccount: fundingTransaction.match.stakeAccount,
      bondFundLamports: fundingLamports.toString(),
      bondFundSol: fundingSol,
    },
    after: {
      voteBalanceLamports: finalPlan.voteBalanceLamports,
      voteRentLamports: finalPlan.voteRentExemptLamports,
      identityBalanceLamports: finalPlan.identityBalanceLamports,
      identityBalanceSol: finalPlan.identityBalanceSol,
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
