#!/usr/bin/env bun

import { createRpcContext } from "../../shared/operator-config.ts";
import {
  VOTEX_PROGRAM, VAULT_CONFIG, VAULT_GAUGEMEISTER, VAULT_ALLOWED_MINTS,
  decodeVaultEpochInfo, votexStatsUrl, type VaultEpochInfo as EpochInfo,
} from "../../shared/votex-accounts";

import { base58Encode, base58Decode } from "../../shared/base58";
import { fetchResponse, fetchJson } from "../../shared/http";

import { createHash } from "node:crypto";

const epochArg = process.argv[2];
const asJson = process.argv.includes("--json");
const skipNames = process.argv.includes("--no-names");
const epochOnly = process.argv.includes("--epoch-only");
const maxPagesArg = process.argv.find((arg) => arg.startsWith("--max-pages="));
const maxPages = maxPagesArg ? Number(maxPagesArg.split("=")[1]) : 20;
const localTimeZone = process.env.LOCAL_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const rpcContext = createRpcContext();

function isCurrentEpochArg(value: string | undefined): boolean {
  return value === "current" || value === "now";
}

function printUsage() {
  console.error("Usage: bun scripts/votex_status.ts <epochId|current> [--json] [--no-names] [--epoch-only] [--max-pages=N] [--rpc URL] [--config PATH] [--profile NAME]");
}

if (process.argv.includes("--help")) { printUsage(); process.exit(0); }

if (!epochArg || (!/^\d+$/.test(epochArg) && !isCurrentEpochArg(epochArg)) || !Number.isSafeInteger(maxPages) || maxPages <= 0) {
  printUsage();
  process.exit(2);
}

if (epochOnly && !isCurrentEpochArg(epochArg)) {
  console.error("--epoch-only requires the current epoch shortcut.");
  printUsage();
  process.exit(2);
}

let targetEpoch = 0;
let statsUrl = "";
let currentEpochInfo: EpochInfo | null = null;

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TX_BATCH_SIZE = 50;

type VoteBuy = {
  gauge: string;
  mint: string;
  amount: string;
  maxAmount: string | null;
  buyer: string;
  totalCommitted: string;
};

type NameResolution = {
  name: string;
  quarry?: string;
  tokenMint?: string;
};

type TransactionRow = {
  signature: string;
  slot: number;
  blockTime: number | null;
  buyer: string;
  buyerTokenAccount: string;
  tokenVault: string;
  voteBuy: string;
  gauge: string;
  epoch: number;
  amountRaw: bigint;
};

type ComputedRow = {
  gauge: string;
  validatorName: string;
  usdcRaw: bigint;
  usdc: number;
  bidSharePct: number;
  acquiredVevRaw: bigint | null;
  acquiredVev: number | null;
  txCount?: number;
  buyers?: string[];
  voteBuys?: string[];
  transactions?: TransactionRow[];
};

const increaseVoteBuyDiscriminator = createHash("sha256").update("global:increase_vote_buy").digest().subarray(0, 8);

const rpc = rpcContext.rpc;

async function rpcBatch<T>(calls: Array<{ method: string; params: unknown }>): Promise<T[]> {
  const json = await fetchJson<any[]>((await rpcContext.url()), {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(calls.map((call,id)=>({jsonrpc:"2.0",id,method:call.method,params:call.params}))),
  });
  if (!Array.isArray(json) || json.length !== calls.length) {
    throw new Error("Incomplete on-chain scan: invalid or missing RPC batch responses");
  }
  const byId = new Map(json.map((item: any) => [item.id, item]));
  if (byId.size !== calls.length) throw new Error("Incomplete on-chain scan: duplicate RPC batch response IDs");
  return calls.map((_, id) => {
    const item = byId.get(id) as any;
    if (!item || item.error || item.result === undefined || item.result === null) {
      throw new Error(`Incomplete on-chain scan: transaction lookup ${id} failed or is unavailable; provider message omitted`);
    }
    return item.result as T;
  });
}

async function resolveGaugeNames(gauges: string[]): Promise<Map<string, NameResolution>> {
  const names = new Map<string, NameResolution>();
  await Promise.all(
    gauges.map(async (gauge) => {
      try {
        const account = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
          gauge,
          { encoding: "base64", commitment: "confirmed" },
        ]);
        const encoded = account.value?.data?.[0];
        if (!encoded) return;
        const data = Uint8Array.from(Buffer.from(encoded, "base64"));
        if (data.length < 72) return;

        const quarry = base58Encode(data.subarray(40, 72));
        const quarryAccount = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
          quarry,
          { encoding: "base64", commitment: "confirmed" },
        ]);
        const quarryEncoded = quarryAccount.value?.data?.[0];
        if (!quarryEncoded) return;
        const quarryData = Uint8Array.from(Buffer.from(quarryEncoded, "base64"));
        if (quarryData.length < 72) return;

        const tokenMint = base58Encode(quarryData.subarray(40, 72));
        const asset = await rpc<any>("getAsset", { id: tokenMint });
        const name = asset?.content?.metadata?.name;
        names.set(gauge, { name: typeof name === "string" ? name.trim() : "", quarry, tokenMint });
      } catch {
        names.set(gauge, { name: "" });
      }
    }),
  );
  return names;
}

function bidSharePct(usdcRaw: bigint, totalUsdcRaw: bigint): number {
  if (totalUsdcRaw === 0n) return 0;
  return Number((usdcRaw * 1000000n) / totalUsdcRaw) / 10000;
}

function fmtRaw(raw: bigint, decimals = 6): string {
  const whole = raw / 10n ** BigInt(decimals);
  const fraction = (raw % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function fmtTime(unixSeconds: number | null): string {
  if (!unixSeconds) return "";
  const date = new Date(unixSeconds * 1000);
  const utc = date.toISOString().replace(".000Z", "Z");
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: localTimeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return `${utc} UTC / ${local} local`;
}

function serializeEpochInfo(info: EpochInfo) {
  return {
    epochDurationSeconds: info.epochDurationSeconds,
    currentRewardsEpoch: info.currentRewardsEpoch,
    activeVoteBuyTargetEpoch: info.activeVoteBuyTargetEpoch,
    currentEpochStartUnix: info.currentEpochStart,
    currentEpochStart: fmtTime(info.currentEpochStart),
    nextEpochStartsAtUnix: info.nextEpochStartsAt,
    nextEpochStartsAt: fmtTime(info.nextEpochStartsAt),
  };
}

function printEpochOnly(info: EpochInfo) {
  console.log(`Current Vault rewards epoch: ${info.currentRewardsEpoch}`);
  console.log(`Active vote-buy target epoch: ${info.activeVoteBuyTargetEpoch}`);
  console.log(`Epoch duration: ${info.epochDurationSeconds} seconds`);
  console.log(`Current rewards epoch window: ${fmtTime(info.currentEpochStart)} -> ${fmtTime(info.nextEpochStartsAt)}`);
}

function serializeRow(row: ComputedRow) {
  return {
    gauge: row.gauge,
    validatorName: row.validatorName,
    usdc: row.usdc,
    usdcRaw: row.usdcRaw.toString(),
    bidSharePct: row.bidSharePct,
    acquiredVev: row.acquiredVev,
    acquiredVevRaw: row.acquiredVevRaw?.toString() ?? null,
    txCount: row.txCount,
    buyers: row.buyers,
    voteBuys: row.voteBuys,
    transactions: row.transactions?.map((tx) => ({
      ...tx,
      amountRaw: tx.amountRaw.toString(),
      amountUsdc: Number(tx.amountRaw) / 1e6,
      time: fmtTime(tx.blockTime),
    })),
  };
}

async function buildFromPublishedStats(response: Response) {
  const stats = (await response.json()) as {
    totalV?: string;
    totalVev: string;
    vPrice?: string;
    voteBuys: VoteBuy[];
  };

  const totalVevRaw = BigInt(stats.totalVev);
  const rows = stats.voteBuys.map((voteBuy) => ({
    gauge: voteBuy.gauge,
    usdcRaw: BigInt(voteBuy.amount),
  }));
  const totalUsdcRaw = rows.reduce((sum, row) => sum + row.usdcRaw, 0n);

  if (totalUsdcRaw === 0n) throw new Error(`The Vault epoch ${targetEpoch} has zero USDC bids.`);

  const names = skipNames ? new Map<string, NameResolution>() : await resolveGaugeNames(rows.map((row) => row.gauge));
  const computed = rows
    .map((row) => {
      const acquiredVevRaw = (row.usdcRaw * totalVevRaw) / totalUsdcRaw;
      return {
        gauge: row.gauge,
        validatorName: names.get(row.gauge)?.name ?? "",
        usdcRaw: row.usdcRaw,
        usdc: Number(row.usdcRaw) / 1e6,
        bidSharePct: bidSharePct(row.usdcRaw, totalUsdcRaw),
        acquiredVevRaw,
        acquiredVev: Number(acquiredVevRaw) / 1e6,
      };
    })
    .sort((a, b) => Number(b.usdcRaw - a.usdcRaw));

  return {
    source: statsUrl,
    sourceType: "votafi-stats",
    totalVevRaw,
    totalVev: Number(totalVevRaw) / 1e6,
    totalUsdcRaw,
    totalUsdc: Number(totalUsdcRaw) / 1e6,
    computed,
  };
}

async function getVaultEpochInfo(): Promise<EpochInfo> {
  const account = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
    VAULT_GAUGEMEISTER,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const encoded = account.value?.data?.[0];
  if (!encoded) throw new Error(`Vault gaugemeister not found: ${VAULT_GAUGEMEISTER}`);
  return decodeVaultEpochInfo(Buffer.from(encoded, "base64"));
}

async function getEpochBuyWindow(): Promise<{ start: number; end: number; currentRewardsEpoch: number }> {
  const info = currentEpochInfo ?? (await getVaultEpochInfo());
  return {
    // A VoteBuy for epoch N is placed during gauge epoch N - 1.
    start: info.currentEpochStart + (targetEpoch - 1 - info.currentRewardsEpoch) * info.epochDurationSeconds,
    end: info.currentEpochStart + (targetEpoch - info.currentRewardsEpoch) * info.epochDurationSeconds,
    currentRewardsEpoch: info.currentRewardsEpoch,
  };
}

async function fetchSignatureCandidates(start: number, end: number) {
  const signatures: any[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const pageSigs = await rpc<any[]>("getSignaturesForAddress", [
      VOTEX_PROGRAM,
      { limit: 1000, ...(before ? { before } : {}) },
    ]);
    if (!Array.isArray(pageSigs)) throw new Error("Incomplete on-chain scan: invalid signature response");
    if (pageSigs.length === 0) {
      complete = true;
      break;
    }
    for (const sig of pageSigs) {
      if (typeof sig?.signature !== "string" || seen.has(sig.signature)) {
        throw new Error("Incomplete on-chain scan: invalid or repeated signature while paging");
      }
      seen.add(sig.signature);
    }
    signatures.push(...pageSigs);
    before = pageSigs[pageSigs.length - 1].signature;

    const knownTimes = pageSigs.map((sig) => sig.blockTime).filter((time) => typeof time === "number");
    const oldest = knownTimes.length ? Math.min(...knownTimes) : undefined;
    if (oldest !== undefined && oldest < start) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    throw new Error(`Incomplete on-chain scan: --max-pages=${maxPages} reached before covering the epoch window; increase --max-pages and retry`);
  }
  return signatures.filter((sig) => !sig.err && (!sig.blockTime || (sig.blockTime >= start && sig.blockTime < end)));
}

function allAccountKeys(tx: any): string[] {
  const keys = tx.transaction.message.accountKeys.map((key: any) => (typeof key === "string" ? key : key.pubkey));
  const loaded = tx.meta?.loadedAddresses;
  if (loaded?.writable) keys.push(...loaded.writable);
  if (loaded?.readonly) keys.push(...loaded.readonly);
  return keys;
}

function parseIncreaseVoteBuyTransactions(tx: any, signature: string): TransactionRow[] {
  const keys = allAccountKeys(tx);
  const rows: TransactionRow[] = [];
  for (const ix of tx.transaction.message.instructions ?? []) {
    if (keys[ix.programIdIndex] !== VOTEX_PROGRAM) continue;
    const data = base58Decode(ix.data || "");
    if (data.length !== 20) continue;
    if (!Buffer.from(data.subarray(0, 8)).equals(increaseVoteBuyDiscriminator)) continue;
    const ixEpoch = Buffer.from(data).readUInt32LE(8);
    if (ixEpoch !== targetEpoch) continue;

    const accounts = (ix.accounts ?? []).map((idx: number) => keys[idx]);
    if (accounts[3] !== USDC_MINT) continue;
    if (accounts[4] !== VAULT_CONFIG) continue;
    if (accounts[5] !== VAULT_GAUGEMEISTER) continue;
    if (accounts[8] !== VAULT_ALLOWED_MINTS) continue;
    if (accounts[9] !== TOKEN_PROGRAM) continue;
    if (accounts[10] !== ASSOCIATED_TOKEN_PROGRAM) continue;
    if (accounts[11] !== SYSTEM_PROGRAM) continue;

    rows.push({
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      buyer: accounts[0],
      buyerTokenAccount: accounts[1],
      tokenVault: accounts[2],
      voteBuy: accounts[6],
      gauge: accounts[7],
      epoch: ixEpoch,
      amountRaw: Buffer.from(data).readBigUInt64LE(12),
    });
  }
  return rows;
}

async function fetchTransactions(signatures: any[]) {
  const rows: TransactionRow[] = [];
  for (let i = 0; i < signatures.length; i += TX_BATCH_SIZE) {
    const batch = signatures.slice(i, i + TX_BATCH_SIZE);
    const responses = await rpcBatch<any>(
      batch.map((sig) => ({
        method: "getTransaction",
        params: [sig.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      })),
    );
    for (let j = 0; j < responses.length; j++) {
      const tx = responses[j];
      if (!tx.meta || !Object.hasOwn(tx.meta, "err") || !Array.isArray(tx.transaction?.message?.accountKeys)) {
        throw new Error("Incomplete on-chain scan: transaction response omitted execution status or account keys");
      }
      if (tx.meta.err !== null) continue;
      rows.push(...parseIncreaseVoteBuyTransactions(tx, batch[j].signature));
    }
  }
  return rows;
}

async function buildFromOnChainTransactions() {
  const window = await getEpochBuyWindow();
  const signatures = await fetchSignatureCandidates(window.start, window.end);
  const transactions = (await fetchTransactions(signatures)).sort(
    (a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0) || a.signature.localeCompare(b.signature),
  );
  const totalUsdcRaw = transactions.reduce((sum, row) => sum + row.amountRaw, 0n);
  const gauges = [...new Set(transactions.map((row) => row.gauge))];
  const names = skipNames ? new Map<string, NameResolution>() : await resolveGaugeNames(gauges);
  const byGauge = new Map<string, ComputedRow>();
  for (const tx of transactions) {
    const existing =
      byGauge.get(tx.gauge) ??
      ({
        gauge: tx.gauge,
        validatorName: names.get(tx.gauge)?.name ?? "",
        usdcRaw: 0n,
        usdc: 0,
        bidSharePct: 0,
        acquiredVevRaw: null,
        acquiredVev: null,
        txCount: 0,
        buyers: [],
        voteBuys: [],
        transactions: [],
      } satisfies ComputedRow);
    existing.usdcRaw += tx.amountRaw;
    existing.transactions!.push(tx);
    if (!existing.buyers!.includes(tx.buyer)) existing.buyers!.push(tx.buyer);
    if (!existing.voteBuys!.includes(tx.voteBuy)) existing.voteBuys!.push(tx.voteBuy);
    existing.txCount = existing.transactions!.length;
    byGauge.set(tx.gauge, existing);
  }

  const computed = [...byGauge.values()]
    .map((row) => ({
      ...row,
      usdc: Number(row.usdcRaw) / 1e6,
      bidSharePct: bidSharePct(row.usdcRaw, totalUsdcRaw),
    }))
    .sort((a, b) => Number(b.usdcRaw - a.usdcRaw));

  return {
    source: statsUrl,
    sourceType: "on-chain-increase-vote-buy",
    fallbackReason: "VotaFi stats returned HTTP 404",
    noDataReason:
      totalUsdcRaw === 0n
        ? `Stats are unpublished and no matching on-chain IncreaseVoteBuy transactions were found for epoch ${targetEpoch}.`
        : undefined,
    scanWindow: {
      complete: true,
      startUnix: window.start,
      endUnix: window.end,
      start: fmtTime(window.start),
      end: fmtTime(window.end),
      currentRewardsEpoch: window.currentRewardsEpoch,
      signatureCandidates: signatures.length,
      transactionCount: transactions.length,
    },
    totalVevRaw: null,
    totalVev: null,
    totalUsdcRaw,
    totalUsdc: Number(totalUsdcRaw) / 1e6,
    computed,
  };
}

let result;
try {
  if (isCurrentEpochArg(epochArg)) {
    currentEpochInfo = await getVaultEpochInfo();
    targetEpoch = currentEpochInfo.activeVoteBuyTargetEpoch;
  } else {
    targetEpoch = Number(epochArg);
  }

  statsUrl = votexStatsUrl(targetEpoch);

  if (epochOnly) {
    if (asJson) {
      console.log(JSON.stringify({ requestedEpoch: epochArg, epoch: targetEpoch, epochContext: serializeEpochInfo(currentEpochInfo!) }, null, 2));
    } else {
      printEpochOnly(currentEpochInfo!);
    }
    process.exit(0);
  }

  const response = await fetchResponse(statsUrl);
  if (response.status === 404) result = await buildFromOnChainTransactions();
  else if (!response.ok) throw new Error(`Failed to fetch stats for The Vault epoch ${targetEpoch}: HTTP ${response.status}`);
  else result = await buildFromPublishedStats(response);
} catch (error) {
  console.error(rpcContext.redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

const output = {
  requestedEpoch: epochArg,
  epoch: targetEpoch,
  epochContext: currentEpochInfo ? serializeEpochInfo(currentEpochInfo) : undefined,
  source: result.source,
  sourceType: result.sourceType,
  fallbackReason: "fallbackReason" in result ? result.fallbackReason : undefined,
  noDataReason: "noDataReason" in result ? result.noDataReason : undefined,
  scanWindow: "scanWindow" in result ? result.scanWindow : undefined,
  totalVevRaw: result.totalVevRaw?.toString() ?? null,
  totalVev: result.totalVev,
  totalUsdcRaw: result.totalUsdcRaw.toString(),
  totalUsdc: result.totalUsdc,
  rows: result.computed.map(serializeRow),
};

if (asJson) {
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const pct = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log(`Source: ${output.source}`);
console.log(`Source type: ${output.sourceType}`);
if (output.fallbackReason) console.log(`Fallback: ${output.fallbackReason}`);
if (output.noDataReason) console.log(`Status: ${output.noDataReason}`);
if (output.epochContext) {
  console.log(`Current Vault rewards epoch: ${output.epochContext.currentRewardsEpoch}`);
  console.log(`Active vote-buy target epoch: ${output.epochContext.activeVoteBuyTargetEpoch}`);
  console.log(`Current rewards epoch window: ${output.epochContext.currentEpochStart} -> ${output.epochContext.nextEpochStartsAt}`);
}
console.log(`Epoch: ${targetEpoch}`);
console.log(`Total veV: ${output.totalVev === null ? "unavailable from on-chain vote-buy txs" : fmt.format(output.totalVev)}`);
console.log(`Total USDC bids: ${fmt.format(output.totalUsdc)}`);
if (output.scanWindow) {
  console.log(`Scan window: ${output.scanWindow.start} -> ${output.scanWindow.end}`);
  console.log(`Matched IncreaseVoteBuy transactions: ${output.scanWindow.transactionCount}`);
}
console.log("");
console.log("| validator | gauge | USDC bid | bid share | acquired veV |");
console.log("|---|---|---:|---:|---:|");
for (const row of result.computed) {
  const acquired = row.acquiredVev === null ? "n/a" : fmt.format(row.acquiredVev);
  console.log(
    `| ${row.validatorName || "unknown"} | \`${row.gauge}\` | ${fmt.format(row.usdc)} | ${pct.format(row.bidSharePct)}% | ${acquired} |`,
  );
}

if (result.sourceType === "on-chain-increase-vote-buy") {
  const txs = result.computed.flatMap((row: ComputedRow) => row.transactions ?? []).sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  console.log("");
  console.log("| time | validator | USDC | voteBuy | signature |");
  console.log("|---|---|---:|---|---|");
  for (const tx of txs) {
    const validator = result.computed.find((row) => row.gauge === tx.gauge)?.validatorName || "unknown";
    console.log(
      `| ${fmtTime(tx.blockTime)} | ${validator} | ${fmtRaw(tx.amountRaw)} | \`${tx.voteBuy}\` | \`${tx.signature}\` |`,
    );
  }
}
