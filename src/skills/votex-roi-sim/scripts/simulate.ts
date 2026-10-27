#!/usr/bin/env bun

import { fetchResponse } from "../../shared/http";

import { parseSimulateArgs, UsageError, USAGE, type SimulateArgs } from "./args";
import { simulateBids, revenueScenarios, bestNetIndex, type Revenue } from "./model";

import { createRpcContext, fetchRpcResponse } from "../../shared/operator-config.ts";
import {
  GAUGE_PROGRAM as GAUGE_PROGRAM_ADDRESS, VAULT_GAUGEMEISTER as VAULT_GAUGEMEISTER_ADDRESS,
  decodeVaultEpochInfo, votexStatsUrl, assertUsdcVoteBuys, NonUsdcVoteBuyError,
} from "../../shared/votex-accounts";
import { findVaultGaugesByName, isActiveVaultGauge } from "../../shared/vault-gauges";

import { Connection, PublicKey } from "@solana/web3.js";

const rpcContext = createRpcContext();

const GAUGE_PROGRAM = new PublicKey(GAUGE_PROGRAM_ADDRESS);
const VAULT_GAUGEMEISTER = new PublicKey(VAULT_GAUGEMEISTER_ADDRESS);
const WSOL_MINT = "So11111111111111111111111111111111111111112";

function usage(code = 2, message?: string): never {
  if (message) console.error(message);
  console.error(USAGE);
  process.exit(code);
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

function usd(value: number): string {
  return `${value < 0 ? "-" : ""}$${fmt(Math.abs(value), 2)}`;
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

function revenueSummary(revenue: Revenue): string {
  return revenue.mode === "per-epoch"
    ? `per-epoch × hold: ${fmt(revenue.revenueLamportsPerSolEpoch, 0)} gross lamports/staked SOL/epoch × ${revenue.holdEpochs} Solana epochs = ${fmt(revenue.lamportsPerStakedSol, 0)} lamports/staked SOL`
    : `legacy total: ${fmt(revenue.lamportsPerStakedSol, 0)} lamports/staked SOL over the modeled period${revenue.legacyDefault ? " (built-in default; unmeasured assumption)" : " (--lamports-per-staked-sol)"}`;
}

async function findGauge(query: string, format: "markdown" | "json") {
  const result = await findVaultGaugesByName(rpcContext.rpc, query);
  const note = "Matched by staked-token metadata name only; no vote-account link is checked. Confirm the gauge with the operator before simulating.";
  if (format === "json") {
    console.log(JSON.stringify({ query, matchBasis: "token metadata name (case-insensitive substring, trimmed)", note, activeGauges: result.activeGauges, unresolvedGauges: result.unresolvedGauges, matches: result.matches }, null, 2));
    return;
  }
  console.log(`Active Vault gauges scanned: ${result.activeGauges}`);
  if (result.unresolvedGauges) console.log(`Warning: ${result.unresolvedGauges} gauges had no token metadata from this RPC; matches may be incomplete.`);
  console.log(`Matches for "${query}": ${result.matches.length}`);
  console.log(note);
  if (!result.matches.length) return;
  console.log("");
  console.log("| name | gauge | quarry | token mint |");
  console.log("|---|---|---|---|");
  for (const m of result.matches) console.log(`| ${m.name} | \`${m.gauge}\` | \`${m.quarry}\` | \`${m.tokenMint}\` |`);
}

async function simulate(args: SimulateArgs) {
const connection = new Connection(await rpcContext.url(), {
 commitment:'confirmed', disableRetryOnRateLimit:true,
 fetch:Object.assign(fetchRpcResponse, {preconnect:fetch.preconnect}),
});
const gaugeAccount = await connection.getAccountInfo(new PublicKey(args.gauge));
if(!gaugeAccount || !gaugeAccount.owner.equals(GAUGE_PROGRAM) || !isActiveVaultGauge(gaugeAccount.data)) throw new Error('Gauge is not an active Vault gauge');
const epoch = args.epoch === "current" ? await currentVaultTargetEpoch(connection) : Number(args.epoch);
let stats: Awaited<ReturnType<typeof fetchStats>>;
try {
  stats = await fetchStats(epoch);
} catch (error) {
  // VotaFi stats may be unpublished for the live epoch. If the caller supplied
  // both --total-vev and --other-bids, proceed against the live/partial pool.
  // Published stats that cannot be summed as USDC are not "unavailable"; never relabel them.
  if (error instanceof NonUsdcVoteBuyError || args.totalVev === undefined || args.otherBids === undefined) throw error;
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
const base = {
 totalVev, otherBids, totalGaugeDirectedSol:stakebot.totalGaugeDirectedSol,totalGaugeVev,
 matchMultiplier:args.matchMultiplier,solUsd:price.solUsd,
};
const revenue = args.revenue;
const rows = simulateBids(args.bids, {...base, lamportsPerStakedSol:revenue.lamportsPerStakedSol});
const best = bestNetIndex(rows);
const scenarios = revenueScenarios(revenue).map((scenario) => ({
  ...scenario,
  rows: simulateBids(args.bids, {...base, lamportsPerStakedSol:scenario.lamportsPerStakedSol})
    .map((row) => ({ bidUsdc: row.bidUsdc, revenueUsd: row.revenueUsd, netUsd: row.netUsd, roiPct: row.roiPct })),
}));

const output = {
  modelScope: "Selected epoch bidding with latest stakebot pool and current price unless overridden; constant match multiplier does not model SFDP caps",
  epoch,
  gauge: args.gauge,
  sources: { votexStats: stats.source, stakebot: stakebot.source, solUsd: price.source },
  revenue,
  assumptions: {
    totalVev,
    totalUsdc: stats.totalUsdc,
    currentBid,
    otherBids,
    totalGaugeDirectedSol: stakebot.totalGaugeDirectedSol,
    totalEpochGaugeVev: totalGaugeVev,
    matchMultiplier: args.matchMultiplier,
    lamportsPerStakedSol: revenue.lamportsPerStakedSol,
    solUsd: price.solUsd,
  },
  rows,
  bestNet: { bidUsdc: rows[best].bidUsdc, netUsd: rows[best].netUsd, roiPct: rows[best].roiPct, note: "Highest net USD among the listed bids only" },
  sensitivity: scenarios,
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
  console.log(`Revenue mode: ${revenueSummary(revenue)}`);
  console.log(`Assumptions: match ${args.matchMultiplier}x, $${fmt(price.solUsd, 2)}/SOL`);
  console.log("");
  console.log("| bid USDC | acquired veV | directed SOL | effective SOL | revenue SOL | revenue USD | net USD | ROI |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|---:|");
  rows.forEach((row, i) => {
    console.log(
      `| ${fmt(row.bidUsdc, 6)}${i === best ? " (best net)" : ""} | ${fmt(row.acquiredVev, 0)} | ${fmt(row.directedSol, 2)} | ${fmt(row.effectiveSol, 2)} | ${fmt(row.revenueSol, 6)} | ${usd(row.revenueUsd)} | ${usd(row.netUsd)} | ${pct(row.roiPct)}% |`,
    );
  });
  console.log("");
  console.log(`Best net USD among listed bids: ${fmt(rows[best].bidUsdc, 6)} USDC -> ${usd(rows[best].netUsd)} (ROI ${pct(rows[best].roiPct)}%)`);
  if (scenarios.length) {
    console.log("");
    console.log("Sensitivity (net USD / ROI); lag scenarios are unverified:");
    console.log("");
    console.log(`| bid USDC | main (${revenue.mode === "per-epoch" ? `${revenue.holdEpochs} ep` : "total"}) | ${scenarios.map((s) => s.label).join(" | ")} |`);
    console.log(`|---:|---:|${scenarios.map(() => "---:").join("|")}|`);
    rows.forEach((row, i) => {
      const cells = [row, ...scenarios.map((s) => s.rows[i])].map((r) => `${usd(r.netUsd)} / ${pct(r.roiPct)}%`);
      console.log(`| ${fmt(row.bidUsdc, 6)} | ${cells.join(" | ")} |`);
    });
  }
}
}

async function main() {
let args: ReturnType<typeof parseSimulateArgs>;
try { args = parseSimulateArgs(process.argv.slice(2)); }
catch (error) { if (error instanceof UsageError) usage(2, error.message); throw error; }
if (args === "help") usage(0);
if (args.mode === "find-gauge") await findGauge(args.query, args.format);
else await simulate(args);
}

if(import.meta.main) main().catch(error=>{
 let message=error instanceof Error?error.message:String(error);
 message=rpcContext.redact(message);
 console.error(message);process.exit(1);
});
