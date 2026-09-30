#!/usr/bin/env bun

import { fetchJson } from "../../shared/http";
import { rpcCall } from "../../shared/operator-config";

import { resolveOperator } from "../../shared/operator-config";

type Format = "markdown" | "csv" | "json";

type Options = {
  config?: string;
  profile?: string;
  validator?: string;
  voteAccount?: string;
  epochs: number;
  format: Format;
  includeCurrent: boolean;
  rpcUrl: string;
};

type RpcResponse<T> = {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

type EpochInfo = {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
};

type VoteAccountInfo = {
  votePubkey: string;
  nodePubkey: string;
  activatedStake: number;
  commission: number;
  epochVoteAccount: boolean;
  lastVote: number;
  rootSlot: number;
};

type VoteAccountsResponse = {
  current: VoteAccountInfo[];
  delinquent: VoteAccountInfo[];
};

type TrilliumRow = {
  identity_pubkey?: string;
  vote_account_pubkey: string;
  epoch: number;
};

type SvtHistoryResponse = {
  data: SvtHistoryRow[];
};

type SvtHistoryRow = {
  validatorId: string;
  voteId: string;
  epoch: number;
  tvCredits?: number;
  tvcRank?: number;
  leaderSlotsTotal?: number;
  leaderSlotsDone?: number;
  fee?: number;
  mevCommission?: number;
  totalStake?: string | number;
  skippedSlots?: string | number;
  slotsInEpoch?: number;
};

type PerfRow = {
  epoch: number;
  stakeSol: number | null;
  voteCredits: number | null;
  tvcPctOfMax: number | null;
  tvcRank: number | null;
  blocksProduced: number | null;
  leaderSlots: number | null;
  blockProductionPct: number | null;
  skipRatePct: number | null;
  commissionPct: number | null;
  mevCommissionPct: number | null;
};

type CurrentStatus = {
  isDelinquent: boolean | null;
  activatedStakeSol: number | null;
  liveCommissionPct: number | null;
  nodePubkey: string | null;
};

const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_TVC_PER_SLOT = 16;
const DEFAULT_SLOTS_PER_EPOCH = 432_000;
const TRILLIUM_BASE_URL = "https://api.trillium.so/validator_rewards";
const SVT_HISTORY_URL = "https://api.validators.svt.one/validators-history/history";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function usage(): never {
  console.log(`Usage:
  bun src/skills/validator-performance/scripts/performance.ts --vote-account <VOTE_ACCOUNT> [--epochs 30]
  bun src/skills/validator-performance/scripts/performance.ts --validator <VOTE_OR_IDENTITY> [--epochs 30]

Options:
  --vote-account <pubkey>       Mainnet vote account to query
  --validator <pubkey>          Vote account or identity pubkey
  --epochs <n>                  Number of completed epochs to fetch (default: 30)
  --include-current             Include current in-progress epoch instead of only completed epochs
  --format <markdown|csv|json>  Output format (default: markdown)
  --rpc <url>                   Helius mainnet RPC URL (default: SOLANA_RPC_URL or saved profile URL)
  --config <path>              Local operator configuration
  --profile <name>             Configured validator profile
  --help                        Show this help text
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    epochs: 30,
    format: "markdown",
    includeCurrent: false,
    rpcUrl: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--vote-account") opts.voteAccount = next();
    else if (arg === "--validator") opts.validator = next();
    else if (arg === "--epochs" || arg === "-n") opts.epochs = parsePositiveInt(next(), "--epochs");
    else if (arg === "--format") opts.format = parseFormat(next());
    else if (arg === "--include-current") opts.includeCurrent = true;
    else if (arg === "--rpc") opts.rpcUrl = next();
    else if (arg === "--config") opts.config = next();
    else if (arg === "--profile") opts.profile = next();
    else if (!arg.startsWith("-") && !opts.validator && !opts.voteAccount) opts.validator = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseFormat(value: string): Format {
  if (value === "markdown" || value === "csv" || value === "json") return value;
  throw new Error("--format must be markdown, csv, or json.");
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  return rpcCall(rpcUrl, method, params);
}


function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function toCount(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function toLamports(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

function lamportsToSol(value: bigint): number {
  return Number(value) / LAMPORTS_PER_SOL;
}

function stakeLamportsToSol(value: unknown): number | null {
  const lamports = toLamports(value);
  if (lamports === null) return null;
  const sol = lamportsToSol(lamports);
  return Number.isFinite(sol) ? sol : null;
}

async function fetchCurrentStatus(opts: Options, voteAccount: string): Promise<CurrentStatus> {
  try {
    const result = await rpc<VoteAccountsResponse>(opts.rpcUrl, "getVoteAccounts", [
      { votePubkey: voteAccount },
    ]);
    const live =
      result.current.find((v) => v.votePubkey === voteAccount) ||
      result.delinquent.find((v) => v.votePubkey === voteAccount);
    if (!live) {
      return { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null };
    }
    const isDelinquent = result.delinquent.some((v) => v.votePubkey === voteAccount);
    return {
      isDelinquent,
      activatedStakeSol: stakeLamportsToSol(live.activatedStake),
      liveCommissionPct: toNumber(live.commission),
      nodePubkey: live.nodePubkey ?? null,
    };
  } catch {
    return { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null };
  }
}

async function fetchSvtHistory(
  voteAccount: string,
  firstEpoch: number,
  lastEpoch: number,
  epochCount: number,
): Promise<SvtHistoryRow[]> {
  const params = new URLSearchParams({
    network: "mainnet",
    vote_id: voteAccount,
    epoch_count: String(epochCount),
    epoch_from: String(lastEpoch),
  });
  const payload = await fetchJson<SvtHistoryResponse>(`${SVT_HISTORY_URL}?${params}`);
  if (!Array.isArray(payload.data)) {
    throw new Error("JPool/SVT history response did not include a data array.");
  }

  const rows = payload.data
    .filter((row) => row.epoch >= firstEpoch && row.epoch <= lastEpoch)
    .sort((a, b) => a.epoch - b.epoch);
  const epochs = new Set(rows.map((row) => row.epoch));
  const missing = [];
  for (let epoch = firstEpoch; epoch <= lastEpoch; epoch++) {
    if (!epochs.has(epoch)) missing.push(epoch);
  }
  if (missing.length > 0) {
    throw new Error(`JPool/SVT history missing epoch(s): ${missing.join(", ")}.`);
  }
  return rows;
}

function parseSkipRatePct(row: SvtHistoryRow): number | null {
  const leaderSlots = toCount(row.leaderSlotsTotal);
  const blocksDone = toCount(row.leaderSlotsDone);
  if (leaderSlots !== null && blocksDone !== null && leaderSlots > 0 && blocksDone <= leaderSlots) {
    return ((leaderSlots - blocksDone) / leaderSlots) * 100;
  }
  if (row.skippedSlots !== undefined && row.skippedSlots !== null && row.skippedSlots !== "") {
    const skipped = toNumber(row.skippedSlots);
    if (skipped !== null && skipped >= 0 && skipped <= 1) return skipped * 100;
    if (skipped !== null && skipped > 1 && skipped <= 100) return skipped;
  }
  return null;
}

function tvcPctOfMax(row: SvtHistoryRow): number | null {
  const credits = toCount(row.tvCredits);
  if (credits === null) return null;
  const slots = row.slotsInEpoch === undefined ? DEFAULT_SLOTS_PER_EPOCH : toCount(row.slotsInEpoch);
  if (slots === null) return null;
  const max = slots * MAX_TVC_PER_SLOT;
  if (max <= 0) return null;
  return (credits / max) * 100;
}

export function normalizePerformanceRow(row: SvtHistoryRow): PerfRow {
  const leaderSlots = toCount(row.leaderSlotsTotal);
  const blocksProduced = toCount(row.leaderSlotsDone);
  const blockProductionPct =
    leaderSlots !== null && blocksProduced !== null && leaderSlots > 0 && blocksProduced <= leaderSlots
      ? (blocksProduced / leaderSlots) * 100 : null;
  const mevCommission = toNumber(row.mevCommission);
  return {
    epoch: row.epoch,
    stakeSol: stakeLamportsToSol(row.totalStake),
    voteCredits: toCount(row.tvCredits),
    tvcPctOfMax: tvcPctOfMax(row),
    tvcRank: toCount(row.tvcRank),
    blocksProduced,
    leaderSlots,
    blockProductionPct,
    skipRatePct: parseSkipRatePct(row),
    commissionPct: toNumber(row.fee),
    mevCommissionPct: mevCommission === null ? null : mevCommission / 100,
  };
}

async function collectRows(opts: Options, voteAccount: string): Promise<{
  currentEpoch: number;
  currentSlotIndex: number;
  slotsInEpoch: number;
  firstEpoch: number;
  lastEpoch: number;
  rows: PerfRow[];
  current: CurrentStatus;
}> {
  const epochInfo = await rpc<EpochInfo>(opts.rpcUrl, "getEpochInfo");
  const currentEpoch = epochInfo.epoch;
  const lastEpoch = opts.includeCurrent ? currentEpoch : currentEpoch - 1;
  const firstEpoch = lastEpoch - opts.epochs + 1;

  const [svtRows, current] = await Promise.all([
    fetchSvtHistory(voteAccount, firstEpoch, lastEpoch, opts.epochs),
    fetchCurrentStatus(opts, voteAccount),
  ]);

  const rows = svtRows.map(normalizePerformanceRow);

  return {
    currentEpoch,
    currentSlotIndex: epochInfo.slotIndex,
    slotsInEpoch: epochInfo.slotsInEpoch,
    firstEpoch,
    lastEpoch,
    rows,
    current,
  };
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

function sum(values: Array<number | null>): number | null {
  if (values.some((value) => value === null)) return null;
  return (values as number[]).reduce((a, b) => a + b, 0);
}

function fmtPct(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

function fmtSol(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function fmtRank(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `#${Math.round(value).toLocaleString("en-US")}`;
}

export function renderMarkdown(result: {
  voteAccount: string;
  currentEpoch: number;
  currentSlotIndex: number;
  slotsInEpoch: number;
  firstEpoch: number;
  lastEpoch: number;
  rows: PerfRow[];
  current: CurrentStatus;
}): string {
  const lines: string[] = [];
  const epochProgressPct = (result.currentSlotIndex / result.slotsInEpoch) * 100;
  lines.push(
    `Vote account: \`${result.voteAccount}\``,
    `Current epoch \`${result.currentEpoch}\` — slot ${result.currentSlotIndex.toLocaleString("en-US")} / ${result.slotsInEpoch.toLocaleString("en-US")} (${epochProgressPct.toFixed(2)}%).`,
    "",
    "## Current Status",
    "",
  );
  if (result.current.nodePubkey) {
    lines.push(`- Node identity: \`${result.current.nodePubkey}\``);
  }
  if (result.current.isDelinquent === null) {
    lines.push("- Delinquent: unknown (vote account not found in `getVoteAccounts`)");
  } else {
    lines.push(`- Delinquent: \`${result.current.isDelinquent ? "yes" : "no"}\``);
  }
  if (result.current.activatedStakeSol !== null) {
    lines.push(`- Activated stake: \`${fmtInt(result.current.activatedStakeSol)} SOL\``);
  }
  if (result.current.liveCommissionPct !== null) {
    lines.push(`- Live commission: \`${result.current.liveCommissionPct}%\``);
  }
  lines.push("");

  lines.push(
    `## Per-Epoch Performance (epochs \`${result.firstEpoch}-${result.lastEpoch}\`)`,
    "",
    "| Epoch | Stake SOL | Vote Credits | TVC % | TVC Rank | Blocks | Block Prod % | Skip Rate | Commission | MEV Comm |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );

  for (const row of result.rows) {
    lines.push(
      `| ${row.epoch} | ${fmtInt(row.stakeSol)} | ${fmtInt(row.voteCredits)} | ${fmtPct(row.tvcPctOfMax)} | ${fmtRank(row.tvcRank)} | ${fmtInt(row.blocksProduced)}/${fmtInt(row.leaderSlots)} | ${fmtPct(row.blockProductionPct)} | ${fmtPct(row.skipRatePct)} | ${fmtPct(row.commissionPct, 0)} | ${fmtPct(row.mevCommissionPct, 0)} |`,
    );
  }

  const avgTvcPct = average(result.rows.map((r) => r.tvcPctOfMax));
  const avgSkip = average(result.rows.map((r) => r.skipRatePct));
  const avgBlockProd = average(result.rows.map((r) => r.blockProductionPct));
  const avgCommission = average(result.rows.map((r) => r.commissionPct));
  const avgMevCommission = average(result.rows.map((r) => r.mevCommissionPct));
  const totalCredits = sum(result.rows.map((r) => r.voteCredits));
  const totalBlocks = sum(result.rows.map((r) => r.blocksProduced));
  const totalLeaderSlots = sum(result.rows.map((r) => r.leaderSlots));

  lines.push(
    "",
    "Unavailable values are shown as —. Averages use available epochs; totals require data for every epoch in the window.",
    "",
    `Window summary (epochs \`${result.firstEpoch}-${result.lastEpoch}\`):`,
    "",
    `- Total vote credits: \`${fmtInt(totalCredits)}\``,
    `- Avg TVC % of max: \`${fmtPct(avgTvcPct)}\``,
    `- Block production: \`${fmtInt(totalBlocks)} / ${fmtInt(totalLeaderSlots)}\` leader slots (\`${fmtPct(avgBlockProd)}\` average)`,
    `- Avg skip rate: \`${fmtPct(avgSkip)}\``,
    `- Avg commission: \`${fmtPct(avgCommission, 1)}\``,
    `- Avg MEV commission: \`${fmtPct(avgMevCommission, 1)}\``,
  );

  return lines.join("\n");
}

export function renderCsv(rows: PerfRow[]): string {
  const header = [
    "epoch",
    "stake_sol",
    "vote_credits",
    "tvc_pct_of_max",
    "tvc_rank",
    "blocks_produced",
    "leader_slots",
    "block_production_pct",
    "skip_rate_pct",
    "commission_pct",
    "mev_commission_pct",
  ];
  const body = rows.map((row) =>
    [
      row.epoch,
      row.stakeSol === null ? "" : row.stakeSol.toFixed(2),
      row.voteCredits,
      row.tvcPctOfMax === null ? "" : row.tvcPctOfMax.toFixed(4),
      row.tvcRank ?? "",
      row.blocksProduced,
      row.leaderSlots,
      row.blockProductionPct === null ? "" : row.blockProductionPct.toFixed(4),
      row.skipRatePct === null ? "" : row.skipRatePct.toFixed(4),
      row.commissionPct ?? "",
      row.mevCommissionPct ?? "",
    ].join(","),
  );
  return [header.join(","), ...body].join("\n");
}

async function main() {
  const opts = parseArgs(Bun.argv.slice(2));
  const operator = await resolveOperator(opts);
  opts.rpcUrl = operator.rpcUrl;
  opts.voteAccount = operator.voteAccount;
  const voteAccount = operator.voteAccount;
  const result = await collectRows(opts, voteAccount);
  const payload = { voteAccount, ...result };

  if (opts.format === "json") console.log(JSON.stringify(payload, null, 2));
  else if (opts.format === "csv") console.log(renderCsv(result.rows));
  else console.log(renderMarkdown({ voteAccount, ...result }));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
