#!/usr/bin/env bun

import { fetchResponse } from "../../shared/http";

import { optionValue } from "../../shared/cli";

import { simulateBids } from "./model";

import { createRpcContext, fetchRpcResponse } from "../../shared/operator-config.ts";
import {
  GAUGE_PROGRAM as GAUGE_PROGRAM_ADDRESS, VAULT_GAUGEMEISTER as VAULT_GAUGEMEISTER_ADDRESS,
  decodeVaultEpochInfo, votexStatsUrl, assertUsdcVoteBuys,
} from "../../shared/votex-accounts";

import { Connection, PublicKey } from "@solana/web3.js";

const rpcContext = createRpcContext();

const GAUGE_PROGRAM = new PublicKey(GAUGE_PROGRAM_ADDRESS);
const VAULT_GAUGEMEISTER = new PublicKey(VAULT_GAUGEMEISTER_ADDRESS);
const WSOL_MINT = "So11111111111111111111111111111111111111112";

type Args = {
  epoch: string;
  gauge: string;
  bids: number[];
  currentBid?: number;
  otherBids?: number;
  totalVev?: number;
  totalGaugeVev?: number;
  matchMultiplier: number;
  lamportsPerStakedSol: number;
  solUsd?: number;
  format: "markdown" | "json";
};

const argValue = (name: string) => optionValue(process.argv.slice(2), name);

function usage(code = 2): never {
  console.error(`Usage: bun scripts/simulate.ts --epoch <current|N> --gauge <GAUGE> --bids 10,20,50 [options] [--rpc URL] [--config PATH] [--profile NAME]`);
  process.exit(code);
}

function num(name: string, fallback?: number): number | undefined {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value < 0) usage();
  return value;
}

function parseArgs(): Args {
  if (process.argv.includes("--help")) usage(0);
  const allowed=new Set(['--epoch','--gauge','--bids','--format','--current-bid','--other-bids','--total-vev','--total-gauge-vev','--match-multiplier','--lamports-per-staked-sol','--sol-usd','--rpc','--config','--profile']);
  const seen=new Set<string>();
  const raw=process.argv.slice(2);
  for(let i=0;i<raw.length;i++) {
    const key=raw[i].split('=')[0];
    if(!allowed.has(key)||seen.has(key)) throw new Error('Unknown or duplicate option; use --help');
    seen.add(key);
    if(!raw[i].includes('=')) {if(!raw[i+1]||raw[i+1].startsWith('--')) usage();i++;}
  }
  const epoch = argValue("--epoch") ?? "current";
  const gauge = argValue("--gauge");
  const bidsRaw = argValue("--bids") ?? "10,20,50,100,150,200,300";
  const bids = bidsRaw.split(",").map((part) => Number(part.trim()));
  const format = (argValue("--format") ?? "markdown") as "markdown" | "json";
  if (!gauge) usage();
  new PublicKey(gauge);
  if (epoch !== "current" && (!Number.isSafeInteger(Number(epoch)) || Number(epoch)>0xffffffff)) usage();
  if (bids.some(value=>!Number.isFinite(value)||value<=0)) usage();
  if (!bids.length || !/^(current|\d+)$/.test(epoch) || !["markdown", "json"].includes(format)) usage();
  return {
    epoch,
    gauge,
    bids,
    currentBid: num("--current-bid"),
    otherBids: num("--other-bids"),
    totalVev: num("--total-vev"),
    totalGaugeVev: num("--total-gauge-vev"),
    matchMultiplier: num("--match-multiplier", 1)!,
    lamportsPerStakedSol: num("--lamports-per-staked-sol", 105000)!,
    solUsd: num("--sol-usd"),
    format,
  };
}

function u32le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function readEpochGaugePower(data: Buffer | undefined): bigint {
  if (!data || data.length < 52) return 0n;
  return data.readBigUInt64LE(8 + 32 + 4);
}

function fmt(value: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function pct(value: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

async function currentVaultTargetEpoch(connection: Connection): Promise<number> {
  const account = await connection.getAccountInfo(VAULT_GAUGEMEISTER, "confirmed");
  if (!account) throw new Error(`Vault gaugemeister not found: ${VAULT_GAUGEMEISTER.toString()}`);
  return decodeVaultEpochInfo(account.data).activeVoteBuyTargetEpoch;
}

async function fetchStats(epoch: number) {
  const source = votexStatsUrl(epoch);
  const response = await fetchResponse(source);
  if (!response.ok) throw new Error(`Failed to fetch Votex stats for epoch ${epoch}: HTTP ${response.status}`);
  const stats = await response.json() as { totalVev: string; voteBuys: Array<{ gauge: string; amount: string; mint?: string }> };
  assertUsdcVoteBuys(stats.voteBuys, epoch);
  const totalVev = Number(BigInt(stats.totalVev)) / 1e6;
  const totalUsdc = stats.voteBuys.reduce((sum, buy) => sum + Number(BigInt(buy.amount)) / 1e6, 0);
  return { source, totalVev, totalUsdc, voteBuys: stats.voteBuys };
}

async function fetchStakebotGaugeStake(): Promise<{ source: string; totalGaugeDirectedSol: number }> {
  const latest = (await (await fetchResponse("https://raw.githubusercontent.com/SolanaVault/stakebot-data/main/bot-stats-latest.txt")).text()).trim();
  if (!latest || latest.includes("..") || !/^[A-Za-z0-9_./-]+$/.test(latest)) throw new Error("Invalid stakebot snapshot path");
  const source = `https://raw.githubusercontent.com/SolanaVault/stakebot-data/main/${latest}`;
  const stats = await (await fetchResponse(source)).json() as {
    validatorTargets: Array<{ targetStake: { bucketGauges: string } }>;
  };
  const totalGaugeDirectedSol = stats.validatorTargets.reduce(
    (sum, validator) => sum + Number(validator.targetStake.bucketGauges) / 1e9,
    0,
  );
  return { source, totalGaugeDirectedSol };
}

async function fetchSolUsd(): Promise<{ source: string; solUsd: number }> {
  const source = `https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`;
  const response = await fetchResponse(source);
  if (!response.ok) throw new Error(`Failed to fetch SOL price: HTTP ${response.status}`);
  const prices = await response.json() as Record<string, { usdPrice?: number }>;
  const solUsd = prices[WSOL_MINT]?.usdPrice;
  if (!Number.isFinite(solUsd)) throw new Error("Failed to fetch SOL price: missing usdPrice");
  return { source, solUsd: solUsd! };
}

async function totalEpochGaugeVev(connection: Connection, epoch: number): Promise<number> {
  const gauges = await connection.getProgramAccounts(GAUGE_PROGRAM, {
    filters: [{ memcmp: { offset: 8, bytes: VAULT_GAUGEMEISTER.toString() } }],
  });
  const activeGaugeKeys = gauges.filter((gauge) => gauge.account.data[72] === 0).map((gauge) => gauge.pubkey);
  let total = 0n;
  for (let i = 0; i < activeGaugeKeys.length; i += 100) {
    const pdas = activeGaugeKeys.slice(i, i + 100).map((gauge) =>
      PublicKey.findProgramAddressSync([Buffer.from("EpochGauge"), gauge.toBuffer(), u32le(epoch)], GAUGE_PROGRAM)[0]
    );
    const accounts = await connection.getMultipleAccountsInfo(pdas, "confirmed");
    for (const account of accounts) total += readEpochGaugePower(account?.data);
  }
  return Number(total) / 1e6;
}

async function main() {
const args = parseArgs();
const connection = new Connection(await rpcContext.url(), {
 commitment:'confirmed', disableRetryOnRateLimit:true,
 fetch:Object.assign(fetchRpcResponse, {preconnect:fetch.preconnect}),
});
const gaugeAccount = await connection.getAccountInfo(new PublicKey(args.gauge));
if(!gaugeAccount || !gaugeAccount.owner.equals(GAUGE_PROGRAM) || gaugeAccount.data.length<73 || !gaugeAccount.data.subarray(8,40).equals(VAULT_GAUGEMEISTER.toBuffer()) || gaugeAccount.data[72]!==0) throw new Error('Gauge is not an active Vault gauge');
const epoch = args.epoch === "current" ? await currentVaultTargetEpoch(connection) : Number(args.epoch);
let stats: Awaited<ReturnType<typeof fetchStats>>;
try {
  stats = await fetchStats(epoch);
} catch (error) {
  // VotaFi stats may be unpublished for the live epoch. If the caller supplied
  // both --total-vev and --other-bids, proceed against the live/partial pool.
  if (args.totalVev === undefined || args.otherBids === undefined) throw error;
  const source = `${votexStatsUrl(epoch)} (stats unavailable; using explicit --total-vev and --other-bids overrides)`;
  stats = { source, totalVev: args.totalVev, totalUsdc: args.otherBids + (args.currentBid ?? 0), voteBuys: [] };
}
const stakebot = await fetchStakebotGaugeStake();
const totalGaugeVev = args.totalGaugeVev ?? await totalEpochGaugeVev(connection, epoch);
const price = args.solUsd === undefined
  ? await fetchSolUsd()
  : { source: "manual --sol-usd override", solUsd: args.solUsd };

const currentBid =
  args.currentBid ??
  stats.voteBuys
    .filter((buy) => buy.gauge === args.gauge)
    .reduce((sum, buy) => sum + Number(BigInt(buy.amount)) / 1e6, 0);
const otherBids = args.otherBids ?? Math.max(0, stats.totalUsdc - currentBid);
const totalVev = args.totalVev ?? stats.totalVev;
const rows = simulateBids(args.bids, {
 totalVev, otherBids, totalGaugeDirectedSol:stakebot.totalGaugeDirectedSol,totalGaugeVev,
 matchMultiplier:args.matchMultiplier,lamportsPerStakedSol:args.lamportsPerStakedSol,solUsd:price.solUsd,
});

const output = {
  modelScope: "Selected epoch bidding with latest stakebot pool and current price unless overridden; constant match multiplier does not model SFDP caps",
  epoch,
  gauge: args.gauge,
  sources: { votexStats: stats.source, stakebot: stakebot.source, solUsd: price.source },
  assumptions: {
    totalVev,
    totalUsdc: stats.totalUsdc,
    currentBid,
    otherBids,
    totalGaugeDirectedSol: stakebot.totalGaugeDirectedSol,
    totalEpochGaugeVev: totalGaugeVev,
    matchMultiplier: args.matchMultiplier,
    lamportsPerStakedSol: args.lamportsPerStakedSol,
    solUsd: price.solUsd,
  },
  rows,
};

if (args.format === "json") {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`Reference epoch: ${epoch}`);
  console.log(`Votex stats: ${stats.source}`);
  console.log(`Stakebot: ${stakebot.source}`);
  console.log(`SOL/USD price: $${fmt(price.solUsd, 6)} (${price.source})`);
  console.log(`Total veV: ${fmt(totalVev, 6)}`);
  console.log(`Total/other USDC bids: ${fmt(stats.totalUsdc, 6)} / ${fmt(otherBids, 6)}`);
  console.log(`Gauge-directed SOL pool: ${fmt(stakebot.totalGaugeDirectedSol, 6)}`);
  console.log(`Total epoch gauge veV: ${fmt(totalGaugeVev, 6)}`);
  console.log(`Assumptions: match ${args.matchMultiplier}x, ${fmt(args.lamportsPerStakedSol, 0)} lamports/staked SOL, $${fmt(price.solUsd, 2)}/SOL`);
  console.log("");
  console.log("| bid USDC | acquired veV | directed SOL | effective SOL | revenue SOL | revenue USD | net USD | ROI |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    console.log(
      `| ${fmt(row.bidUsdc, 6)} | ${fmt(row.acquiredVev, 0)} | ${fmt(row.directedSol, 2)} | ${fmt(row.effectiveSol, 2)} | ${fmt(row.revenueSol, 6)} | $${fmt(row.revenueUsd, 2)} | $${fmt(row.netUsd, 2)} | ${pct(row.roiPct)}% |`,
    );
  }
}

}
if(import.meta.main) main().catch(error=>{
 let message=error instanceof Error?error.message:String(error);
 message=rpcContext.redact(message);
 console.error(message);process.exit(1);
});
