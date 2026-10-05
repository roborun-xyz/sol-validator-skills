#!/usr/bin/env bun

import { fetchSvtHistory, unavailableEpochsNote, toCount, leaderSkipRatePct } from "../../shared/epoch-history";
import { lamportsToSol } from "../../shared/amounts";

import { rpcCall as rpc, resolveOperator } from "../../shared/operator-config";

import { parseEpochQueryArgs, EPOCH_QUERY_HELP, type EpochQueryOptions as Options } from "../../shared/cli";

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
  inProgress: boolean;
};

type CurrentStatus = {
  isDelinquent: boolean | null;
  activatedStakeSol: number | null;
  liveCommissionPct: number | null;
  nodePubkey: string | null;
};

const MAX_TVC_PER_SLOT = 16;
const DEFAULT_SLOTS_PER_EPOCH = 432_000;

function usage(): never {
  console.log(`Usage:
  bun src/skills/validator-performance/scripts/performance.ts --vote-account <VOTE_ACCOUNT> [--epochs 30]
  bun src/skills/validator-performance/scripts/performance.ts --validator <VOTE_OR_IDENTITY> [--epochs 30]

${EPOCH_QUERY_HELP}
`);
  process.exit(0);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
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

function tvcPctOfMax(row: SvtHistoryRow): number | null {
  const credits = toCount(row.tvCredits);
  if (credits === null) return null;
  const slots = row.slotsInEpoch === undefined ? DEFAULT_SLOTS_PER_EPOCH : toCount(row.slotsInEpoch);
  if (slots === null) return null;
  const max = slots * MAX_TVC_PER_SLOT;
  if (max <= 0) return null;
  return (credits / max) * 100;
}

// An in-progress epoch cannot be compared with a full epoch's maximum credits, and upstream
// publishes zero credits and leader slots for it as placeholders, not measurements.
export function normalizePerformanceRow(row: SvtHistoryRow, inProgress = false): PerfRow {
  const placeholder = (count: number | null) => (inProgress && count === 0 ? null : count);
  const leaderSlots = placeholder(toCount(row.leaderSlotsTotal));
  const blocksProduced = leaderSlots === null && inProgress ? null : toCount(row.leaderSlotsDone);
  const blockProductionPct =
    leaderSlots !== null && blocksProduced !== null && leaderSlots > 0 && blocksProduced <= leaderSlots
      ? (blocksProduced / leaderSlots) * 100 : null;
  const mevCommission = toNumber(row.mevCommission);
  const tvcRank = toCount(row.tvcRank);
  return {
    epoch: row.epoch,
    stakeSol: stakeLamportsToSol(row.totalStake),
    voteCredits: placeholder(toCount(row.tvCredits)),
    tvcPctOfMax: inProgress ? null : tvcPctOfMax(row),
    // Ranks are 1-based; upstream publishes 0 as a placeholder.
    tvcRank: tvcRank === 0 ? null : tvcRank,
    blocksProduced,
    leaderSlots,
    blockProductionPct,
    skipRatePct: leaderSkipRatePct(row.leaderSlotsTotal, row.leaderSlotsDone),
    commissionPct: toNumber(row.fee),
    mevCommissionPct: mevCommission === null ? null : mevCommission / 100,
    inProgress,
  };
}

async function collectRows(opts: Options, voteAccount: string): Promise<{
  currentEpoch: number;
  currentSlotIndex: number;
  slotsInEpoch: number;
  requestedFirstEpoch: number;
  firstEpoch: number;
  lastEpoch: number;
  inProgressEpoch: number | null;
  rows: PerfRow[];
  current: CurrentStatus;
}> {
  const epochInfo = await rpc<EpochInfo>(opts.rpcUrl, "getEpochInfo");
  const currentEpoch = epochInfo.epoch;
  const lastEpoch = opts.includeCurrent ? currentEpoch : currentEpoch - 1;
  const requestedFirstEpoch = lastEpoch - opts.epochs + 1;

  const [svtRows, current] = await Promise.all([
    fetchSvtHistory<SvtHistoryRow>(voteAccount, requestedFirstEpoch, lastEpoch, opts.epochs),
    fetchCurrentStatus(opts, voteAccount),
  ]);

  const rows = svtRows.map((row) => normalizePerformanceRow(row, row.epoch === currentEpoch));

  return {
    currentEpoch,
    currentSlotIndex: epochInfo.slotIndex,
    slotsInEpoch: epochInfo.slotsInEpoch,
    requestedFirstEpoch,
    firstEpoch: svtRows[0].epoch,
    lastEpoch,
    inProgressEpoch: opts.includeCurrent ? currentEpoch : null,
    rows,
    current,
  };
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

// A total needs every epoch's value; an empty window has no total, not a total of zero.
function sum(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => value === null)) return null;
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

function fmtRank(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `#${Math.round(value).toLocaleString("en-US")}`;
}

type WindowScope = { requestedFirstEpoch?: number; firstEpoch: number; lastEpoch: number; inProgressEpoch?: number | null };

/** Disclosures for a window that is shorter than requested or includes a partial epoch. */
export function windowNotes(result: WindowScope): string[] {
  const notes = unavailableEpochsNote(result.requestedFirstEpoch ?? result.firstEpoch, result.firstEpoch, result.lastEpoch);
  if (result.inProgressEpoch != null) {
    notes.push(`Epoch \`${result.inProgressEpoch}\` is in progress: its upstream values are partial or placeholders, and it is excluded from the window summary.`);
  }
  return notes;
}

export function renderMarkdown(result: WindowScope & {
  voteAccount: string;
  currentEpoch: number;
  currentSlotIndex: number;
  slotsInEpoch: number;
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
      `| ${row.epoch}${row.epoch === result.inProgressEpoch ? " (in progress)" : ""} | ${fmtInt(row.stakeSol)} | ${fmtInt(row.voteCredits)} | ${fmtPct(row.tvcPctOfMax)} | ${fmtRank(row.tvcRank)} | ${fmtInt(row.blocksProduced)}/${fmtInt(row.leaderSlots)} | ${fmtPct(row.blockProductionPct)} | ${fmtPct(row.skipRatePct)} | ${fmtPct(row.commissionPct, 0)} | ${fmtPct(row.mevCommissionPct, 0)} |`,
    );
  }

  const completed = result.rows.filter((r) => r.epoch !== result.inProgressEpoch);
  const lastCompletedEpoch = result.inProgressEpoch != null ? result.lastEpoch - 1 : result.lastEpoch;
  const avgTvcPct = average(completed.map((r) => r.tvcPctOfMax));
  const avgSkip = average(completed.map((r) => r.skipRatePct));
  const avgBlockProd = average(completed.map((r) => r.blockProductionPct));
  const avgCommission = average(completed.map((r) => r.commissionPct));
  const avgMevCommission = average(completed.map((r) => r.mevCommissionPct));
  const totalCredits = sum(completed.map((r) => r.voteCredits));
  const totalBlocks = sum(completed.map((r) => r.blocksProduced));
  const totalLeaderSlots = sum(completed.map((r) => r.leaderSlots));

  lines.push(
    "",
    "Unavailable values are shown as —. Averages use available epochs; totals require data for every epoch in the window.",
    ...windowNotes(result).flatMap((note) => ["", note]),
    "",
    completed.length
      ? `Window summary (epochs \`${result.firstEpoch}-${lastCompletedEpoch}\`):`
      : "Window summary (no completed epochs in the window):",
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
    "in_progress",
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
      row.inProgress,
    ].join(","),
  );
  return [header.join(","), ...body].join("\n");
}

async function main() {
  const opts = parseEpochQueryArgs(Bun.argv.slice(2), usage);
  const operator = await resolveOperator(opts);
  opts.rpcUrl = operator.rpcUrl;
  opts.voteAccount = operator.voteAccount;
  const voteAccount = operator.voteAccount;
  const result = await collectRows(opts, voteAccount);
  const payload = { voteAccount, ...result };

  if (opts.format === "json") console.log(JSON.stringify(payload, null, 2));
  else if (opts.format === "csv") {
    // CSV has no place for scope notes; keep them off stdout.
    for (const note of windowNotes(result)) console.error(note);
    console.log(renderCsv(result.rows));
  } else console.log(renderMarkdown({ voteAccount, ...result }));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
