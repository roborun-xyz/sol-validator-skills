#!/usr/bin/env bun

import { rpcCall, resolveOperator, readConfig, selectInput, type Input } from "../../shared/operator-config.ts";

import { verifyBamBoostClaimStatusAccount } from "../../shared/bam-accounts";

import { PublicKey } from "@solana/web3.js";

const BAM_PROGRAM = new PublicKey(
  "BoostxbPp2ENYHGcTLYt1obpcY13HE4NojdqNWdzqSSb",
);
const JITOSOL_MINT = new PublicKey(
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
);
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const GCS_LIST_URL =
  "https://storage.googleapis.com/storage/v1/b/jito-bam-boost/o";
const GCS_MERKLE_BASE =
  "https://storage.googleapis.com/jito-bam-boost/mainnet";
const JITOSOL_RATIO_URL =
  "https://kobe.mainnet.jito.network/api/v1/jitosol_sol_ratio";
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

function localIso(date: Date): string {
  const text = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${text.replace(" ", "T")}+08:00`;
}

function u64Le(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function deriveAssociatedTokenAddress(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), JITOSOL_MINT.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

function deriveAddresses(identity: PublicKey, epoch: number) {
  const distributor = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_distributor"), JITOSOL_MINT.toBuffer(), u64Le(epoch)],
    BAM_PROGRAM,
  )[0];
  const claimStatus = PublicKey.findProgramAddressSync(
    [Buffer.from("claim_status"), identity.toBuffer(), distributor.toBuffer()],
    BAM_PROGRAM,
  )[0];
  return {
    distributor,
    claimStatus,
    distributorTokenAccount: deriveAssociatedTokenAddress(distributor),
  };
}

export async function resolveBamTarget(options: Pick<CheckOptions, 'identity' | 'profile' | 'config' | 'rpcUrl'>, call = rpcCall) {
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
    const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
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
    const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
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

async function latestJitoSolRatio() {
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const end = new Date(now.getTime() + 86_400_000).toISOString();
  const response = await fetch(JITOSOL_RATIO_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
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
  const target = await resolveBamTarget(options);
  const identity = new PublicKey(target.identity);
  const [genesisHash, epochInfo, publishedEpochs] = await Promise.all([
    rpcCall(target.rpcUrl, "getGenesisHash"),
    rpcCall(target.rpcUrl, "getEpochInfo", [{ commitment: "finalized" }]),
    listPublishedEpochs(),
  ]);
  if (genesisHash !== MAINNET_GENESIS_HASH) {
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
  --from-epoch <N>        Restrict the published claim epoch range
  --to-epoch <N>          Restrict the published claim epoch range
  --format markdown|json  Output format (default: markdown)`);
  process.exit(code);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let identity = "";
    let profile: string | undefined;
    let config: string | undefined;
    let claimEpoch: number | undefined;
    let fromEpoch: number | undefined;
    let toEpoch: number | undefined;
    let format = "markdown";
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const next = args[index + 1];
      if (arg === "--profile" && next) {
        profile = next; index++;
      } else if (arg === "--config" && next) {
        config = next; index++;
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
      profile,
      config,
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
