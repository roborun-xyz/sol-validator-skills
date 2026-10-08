#!/usr/bin/env bun

import { fetchResponse } from "../../shared/http";

import { localIso, localTimeZone } from "../../shared/time";

import {
  rpcCall,
  resolveOperator,
  readConfig,
  selectInput,
  type Input,
  type RpcCaller,
  MAINNET_GENESIS,
  rpcOptions,
} from "../../shared/operator-config.ts";

import {
  verifyBamBoostClaimStatusAccount,
  BAM_BOOST_PROGRAM as BAM_PROGRAM,
  JITOSOL_MINT,
  TOKEN_PROGRAM,
  BAM_MERKLE_BASE as GCS_MERKLE_BASE,
  JITOSOL_RATIO_URL,
  deriveBamBoostAddresses as deriveAddresses,
  deriveAssociatedJitoSolAddress as deriveAssociatedTokenAddress,
} from "../../shared/bam-accounts";

import { PublicKey } from "@solana/web3.js";

const GCS_LIST_URL =
  "https://storage.googleapis.com/storage/v1/b/jito-bam-boost/o";
export type AllocationStatus = "claimable" | "claimed" | "unfunded";

export type BamAllocation = {
  claimEpoch: number;
  earningEpoch: number;
  amountLamports: string;
  amountJitoSol: number;
  solEquivalent: number | null;
  status: AllocationStatus;
  distributor: string;
  distributorTokenAccount: string;
  distributorBalanceLamports: string;
  claimStatus: string;
};

export type BamCheckResult = {
  identity: string;
  currentEpoch: number;
  checkedAtUtc: string;
  checkedAtLocal: string;
  commitment: "finalized";
  jitoSolToSolRate: number | null;
  rateTimestampUtc: string | null;
  rateTimestampLocal: string | null;
  identityAccountExists: boolean;
  identityBalanceLamports: string;
  identityBalanceSol: number;
  destinationJitoSolAccount: string;
  destinationJitoSolAccountExists: boolean;
  destinationJitoSolBalanceLamports: string;
  allocations: BamAllocation[];
  totals: {
    claimableLamports: string;
    claimableJitoSol: number;
    claimableSolEquivalent: number | null;
    claimedLamports: string;
    unfundedLamports: string;
  };
};

type CheckOptions = {
  identity?: string;
  profile?: string;
  config?: string;
  rpcUrl?: string;
  claimEpoch?: number;
  fromEpoch?: number;
  toEpoch?: number;
};

type RpcAccount = {
  data: [string, string];
  executable: boolean;
  lamports: number;
  owner: string;
};

type MerkleEntry = { pubkey?: unknown; amount?: unknown };

export async function resolveBamTarget(options: Pick<CheckOptions, 'identity' | 'profile' | 'config' | 'rpcUrl'>, call: RpcCaller = rpcCall) {
  if (options.identity) {
    // Explicit historical claimants need not remain an active validator today.
    const identity = new PublicKey(options.identity).toBase58();
    const selected = selectInput({validator: identity, profile: options.profile, config: options.config, rpcUrl: options.rpcUrl}, await readConfig(options.config));
    return { identity, rpcUrl: selected.rpcUrl };
  }
  return resolveOperator(options as Input, call);
}

async function listPublishedEpochs(): Promise<number[]> {
  const epochs = new Set<number>();
  let pageToken: string | undefined;
  do {
    const url = new URL(GCS_LIST_URL);
    url.searchParams.set("prefix", "mainnet/");
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("maxResults", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchResponse(url);
    if (!response.ok) {
      throw new Error(`Jito BAM epoch listing returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      prefixes?: string[];
      nextPageToken?: string;
    };
    for (const prefix of payload.prefixes ?? []) {
      const match = prefix.match(/^mainnet\/(\d+)\/$/);
      if (match) epochs.add(Number(match[1]));
    }
    pageToken = payload.nextPageToken;
  } while (pageToken);
  return [...epochs].sort((a, b) => a - b);
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return output;
}

async function findAllocations(identity: PublicKey, epochs: number[]) {
  const identityText = identity.toBase58();
  const values = await mapLimit(epochs, 12, async (claimEpoch) => {
    const url = `${GCS_MERKLE_BASE}/${claimEpoch}/merkle_tree.json`;
    const response = await fetchResponse(url);
    if (!response.ok) {
      throw new Error(
        `Jito BAM Merkle tree for claim epoch ${claimEpoch} returned HTTP ${response.status}`,
      );
    }
    const entries = (await response.json()) as MerkleEntry[];
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid Merkle tree shape for claim epoch ${claimEpoch}`);
    }
    const entry = entries.find((candidate) => candidate.pubkey === identityText);
    if (!entry) return null;
    if (
      typeof entry.amount === "number" &&
      !Number.isSafeInteger(entry.amount)
    ) {
      throw new Error(
        `Allocation amount for claim epoch ${claimEpoch} exceeds safe JSON integer precision`,
      );
    }
    const raw = String(entry.amount);
    if (!/^\d+$/.test(raw)) {
      throw new Error(`Invalid allocation amount for claim epoch ${claimEpoch}`);
    }
    const amount = BigInt(raw);
    return amount > 0n ? { claimEpoch, amount } : null;
  });
  return values.filter(
    (value): value is { claimEpoch: number; amount: bigint } => value !== null,
  );
}

async function getMultipleAccounts(addresses: PublicKey[], rpcUrl: string) {
  const results = new Map<string, RpcAccount | null>();
  for (let offset = 0; offset < addresses.length; offset += 100) {
    const batch = addresses.slice(offset, offset + 100);
    const response = await rpcCall(rpcUrl,
      "getMultipleAccounts",
      [
        batch.map((address) => address.toBase58()),
        { encoding: "base64", commitment: "finalized" },
      ],
    );
    if (!Array.isArray(response?.value) || response.value.length !== batch.length) throw new Error("Incomplete RPC account batch; claim state is unknown");
    batch.forEach((address, index) => {
      results.set(address.toBase58(), response.value[index] ?? null);
    });
  }
  return results;
}

function tokenAmount(account: RpcAccount | null): bigint {
  if (!account) return 0n;
  const data = Buffer.from(account.data[0], "base64");
  if (account.owner !== TOKEN_PROGRAM.toBase58() || account.data[1] !== "base64" || data.length !== 165 || !data.subarray(0,32).equals(JITOSOL_MINT.toBuffer())) throw new Error("Invalid JitoSOL token account data");
  return data.readBigUInt64LE(64);
}

/**
 * Narrow finalized read for post-claim verification: one RPC call for the only two accounts
 * a claim changes. Undefined until the Claim Status account is visible; a Claim Status or
 * token account that does not match is a definitive failure and throws.
 */
export async function readFinalizedClaim(
  rpcUrl: string,
  claim: { identity: string; claimStatus: string; destination: string; amountLamports: bigint },
): Promise<{ destinationJitoSolBalanceLamports: bigint } | undefined> {
  const accounts = await getMultipleAccounts([new PublicKey(claim.claimStatus), new PublicKey(claim.destination)], rpcUrl);
  const claimStatusAccount = accounts.get(claim.claimStatus);
  if (!claimStatusAccount) return undefined;
  verifyBamBoostClaimStatusAccount(claimStatusAccount, claim.identity, claim.amountLamports);
  return { destinationJitoSolBalanceLamports: tokenAmount(accounts.get(claim.destination) ?? null) };
}

async function latestJitoSolRatio() {
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const end = new Date(now.getTime() + 86_400_000).toISOString();
  const response = await fetchResponse(JITOSOL_RATIO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ range_filter: { start, end } }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    ratios?: Array<{ data: number; date: string }>;
  };
  const valid = (payload.ratios ?? [])
    .filter(
      (item) =>
        Number.isFinite(item.data) &&
        item.data > 0 &&
        Number.isFinite(Date.parse(item.date)),
    )
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return valid.at(-1) ?? null;
}

export async function checkBamBoost(
  options: CheckOptions,
): Promise<BamCheckResult> {
  localTimeZone(); // Reject an invalid zone before any network call.
  const target = await resolveBamTarget(options);
  const identity = new PublicKey(target.identity);
  const [genesisHash, epochInfo, publishedEpochs] = await Promise.all([
    rpcCall(target.rpcUrl, "getGenesisHash"),
    rpcCall(target.rpcUrl, "getEpochInfo", [{ commitment: "finalized" }]),
    listPublishedEpochs(),
  ]);
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error(`RPC genesis hash ${genesisHash} is not Solana mainnet-beta`);
  }

  const epochs = publishedEpochs.filter((epoch) => {
    if (options.claimEpoch !== undefined) return epoch === options.claimEpoch;
    if (options.fromEpoch !== undefined && epoch < options.fromEpoch) return false;
    if (options.toEpoch !== undefined && epoch > options.toEpoch) return false;
    return true;
  });
  if (options.claimEpoch !== undefined && epochs.length === 0) {
    throw new Error(
      `Jito has not published a BAM Merkle tree for claim epoch ${options.claimEpoch}`,
    );
  }

  const found = await findAllocations(identity, epochs);
  const derived = found.map((allocation) => ({
    ...allocation,
    ...deriveAddresses(identity, allocation.claimEpoch),
  }));
  const destination = deriveAssociatedTokenAddress(identity);
  const accounts = await getMultipleAccounts([
    identity,
    destination,
    ...derived.flatMap((item) => [
      item.distributor,
      item.claimStatus,
      item.distributorTokenAccount,
    ]),
  ], target.rpcUrl);
  const ratio = await latestJitoSolRatio().catch(() => null);

  const allocations = derived.map((item): BamAllocation => {
    const distributorAccount =
      accounts.get(item.distributor.toBase58()) ?? null;
    const claimStatusAccount =
      accounts.get(item.claimStatus.toBase58()) ?? null;
    const distributorTokenAccount =
      accounts.get(item.distributorTokenAccount.toBase58()) ?? null;
    if (distributorAccount && distributorAccount.owner !== BAM_PROGRAM.toBase58()) throw new Error("Unexpected BAM distributor owner");
    if (claimStatusAccount) verifyBamBoostClaimStatusAccount(claimStatusAccount, identity.toBase58(), item.amount);
    const balance = tokenAmount(distributorTokenAccount);
    const status: AllocationStatus = claimStatusAccount
      ? "claimed"
      : distributorAccount &&
          distributorTokenAccount &&
          balance >= item.amount
        ? "claimable"
        : "unfunded";
    const amountJitoSol = Number(item.amount) / 1_000_000_000;
    return {
      claimEpoch: item.claimEpoch,
      earningEpoch: item.claimEpoch - 1,
      amountLamports: item.amount.toString(),
      amountJitoSol,
      solEquivalent: ratio ? amountJitoSol * ratio.data : null,
      status,
      distributor: item.distributor.toBase58(),
      distributorTokenAccount: item.distributorTokenAccount.toBase58(),
      distributorBalanceLamports: balance.toString(),
      claimStatus: item.claimStatus.toBase58(),
    };
  });

  const sum = (status: AllocationStatus) =>
    allocations
      .filter((allocation) => allocation.status === status)
      .reduce((total, allocation) => total + BigInt(allocation.amountLamports), 0n);
  const claimable = sum("claimable");
  const checkedAt = new Date();
  const identityAccount = accounts.get(identity.toBase58());
  const identityLamports = identityAccount?.lamports ?? 0;
  const destinationAccount = accounts.get(destination.toBase58()) ?? null;

  return {
    identity: identity.toBase58(),
    currentEpoch: epochInfo.epoch,
    checkedAtUtc: checkedAt.toISOString(),
    checkedAtLocal: localIso(checkedAt),
    commitment: "finalized",
    jitoSolToSolRate: ratio?.data ?? null,
    rateTimestampUtc: ratio?.date ?? null,
    rateTimestampLocal: ratio ? localIso(new Date(ratio.date)) : null,
    identityAccountExists: Boolean(identityAccount),
    identityBalanceLamports: String(identityLamports),
    identityBalanceSol: identityLamports / 1_000_000_000,
    destinationJitoSolAccount: destination.toBase58(),
    destinationJitoSolAccountExists: destinationAccount !== null,
    destinationJitoSolBalanceLamports: tokenAmount(destinationAccount).toString(),
    allocations,
    totals: {
      claimableLamports: claimable.toString(),
      claimableJitoSol: Number(claimable) / 1_000_000_000,
      claimableSolEquivalent: ratio
        ? (Number(claimable) / 1_000_000_000) * ratio.data
        : null,
      claimedLamports: sum("claimed").toString(),
      unfundedLamports: sum("unfunded").toString(),
    },
  };
}

function formatNumber(value: number | null, digits = 9): string {
  return value === null ? "unavailable" : value.toFixed(digits);
}

function renderMarkdown(result: BamCheckResult): string {
  const lines = [
    "# Jito BAM Boost check",
    "",
    `- [On-chain observation] Identity: \`${result.identity}\``,
    `- [On-chain observation] Check time: \`${result.checkedAtUtc}\` / \`${result.checkedAtLocal}\``,
    `- [On-chain observation] Current epoch: \`${result.currentEpoch}\`; commitment: \`${result.commitment}\``,
    `- [On-chain observation] Claimable: \`${result.totals.claimableJitoSol.toFixed(9)} JitoSOL\` = \`${formatNumber(result.totals.claimableSolEquivalent)} SOL\``,
    `- [Official exchange rate] JitoSOL/SOL: \`${result.jitoSolToSolRate ?? "unavailable"}\` at \`${result.rateTimestampUtc ?? "unavailable"}\` / \`${result.rateTimestampLocal ?? "unavailable"}\``,
    `- [On-chain observation] Identity SOL balance: \`${result.identityBalanceSol.toFixed(9)} SOL\``,
    `- [On-chain observation] Destination JitoSOL account: \`${result.destinationJitoSolAccount}\` (${result.destinationJitoSolAccountExists ? "exists" : "will be created"})`,
    "",
    "| Claim epoch | Earning epoch | Status | JitoSOL | SOL equivalent | Allocation lamports | Distributor balance |",
    "|---:|---:|---|---:|---:|---:|---:|",
  ];
  for (const allocation of result.allocations) {
    lines.push(
      `| ${allocation.claimEpoch} | ${allocation.earningEpoch} | ${allocation.status} | ${allocation.amountJitoSol.toFixed(9)} | ${formatNumber(allocation.solEquivalent)} | ${allocation.amountLamports} | ${allocation.distributorBalanceLamports} |`,
    );
  }
  if (result.allocations.length === 0) {
    lines.push("| — | — | none | 0.000000000 | 0.000000000 | 0 | 0 |");
  }
  return `${lines.join("\n")}\n`;
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is out of range`);
  return parsed;
}

function usage(code = 2): never {
  console.error(`Usage:
  bun scripts/check.ts [--profile NAME | --identity PUBKEY] [--config PATH] [options]

Options:
  --claim-epoch <N>       Check one claim distributor epoch
  --rpc <URL>            Mainnet RPC override
  --from-epoch <N>        Restrict the published claim epoch range
  --to-epoch <N>          Restrict the published claim epoch range
  --format markdown|json  Output format (default: markdown)`);
  process.exit(code);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let identity = "";
    let claimEpoch: number | undefined;
    let fromEpoch: number | undefined;
    let toEpoch: number | undefined;
    let format = "markdown";
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const next = args[index + 1];
      if (['--rpc','--config','--profile'].includes(arg) && next && !next.startsWith('--')) {
        index++;
      } else if (arg === "--identity" && next) {
        identity = next;
        index++;
      } else if (arg === "--claim-epoch" && next) {
        claimEpoch = parseInteger(next, "--claim-epoch");
        index++;
      } else if (arg === "--from-epoch" && next) {
        fromEpoch = parseInteger(next, "--from-epoch");
        index++;
      } else if (arg === "--to-epoch" && next) {
        toEpoch = parseInteger(next, "--to-epoch");
        index++;
      } else if (arg === "--format" && next) {
        format = next;
        index++;
      } else if (arg === "--help") {
        usage(0);
      } else {
        usage();
      }
    }
    if (!["markdown", "json"].includes(format)) usage();
    const result = await checkBamBoost({
      identity: identity || undefined,
      ...rpcOptions(args),
      claimEpoch,
      fromEpoch,
      toEpoch,
    });
    process.stdout.write(
      format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderMarkdown(result),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
