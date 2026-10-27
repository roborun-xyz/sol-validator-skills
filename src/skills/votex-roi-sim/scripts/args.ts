import { optionValue } from "../../shared/cli";
import { isPublicKey } from "../../shared/operator-config";

import { resolveRevenue, type Revenue } from "./model";

export class UsageError extends Error {}

export const USAGE = `Usage:
  bun scripts/simulate.ts --gauge <GAUGE> [--epoch <current|N>] [--bids 10,20,50] [revenue] [options]
  bun scripts/simulate.ts --find-gauge <NAME_SUBSTRING> [--format markdown|json]

Revenue (choose one mode):
  --revenue-lamports-per-sol-epoch <N> --hold-epochs <N> [--revenue-low-lamports-per-sol-epoch <N>]
      Gross lamports per staked SOL per Solana epoch times Solana epochs the directed stake stays.
  --lamports-per-staked-sol <N>
      Legacy total over the modeled period (default 105000, an unmeasured assumption).

Options: --current-bid, --other-bids, --total-vev, --total-gauge-vev, --match-multiplier, --sol-usd,
  --format markdown|json, --rpc URL, --config PATH, --profile NAME`;

export type SimulateArgs = {
  mode: "simulate";
  epoch: string;
  gauge: string;
  bids: number[];
  currentBid?: number;
  otherBids?: number;
  totalVev?: number;
  totalGaugeVev?: number;
  matchMultiplier: number;
  revenue: Revenue;
  solUsd?: number;
  format: "markdown" | "json";
};
export type FindGaugeArgs = { mode: "find-gauge"; query: string; format: "markdown" | "json" };

const COMMON = ["--format", "--rpc", "--config", "--profile"];
const SIMULATE = [
  "--epoch", "--gauge", "--bids", "--current-bid", "--other-bids", "--total-vev", "--total-gauge-vev",
  "--match-multiplier", "--lamports-per-staked-sol", "--revenue-lamports-per-sol-epoch", "--hold-epochs",
  "--revenue-low-lamports-per-sol-epoch", "--sol-usd",
];

/** Throws UsageError for anything the caller should report with usage and exit 2. */
export function parseSimulateArgs(raw: string[]): SimulateArgs | FindGaugeArgs | "help" {
  if (raw.includes("--help")) return "help";
  const allowed = new Set([...COMMON, ...SIMULATE, "--find-gauge"]);
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const key = raw[i].split("=")[0];
    if (!allowed.has(key) || seen.has(key)) throw new UsageError(`Unknown or duplicate option: ${key}`);
    seen.add(key);
    if (!raw[i].includes("=")) {
      if (!raw[i + 1] || raw[i + 1].startsWith("--")) throw new UsageError(`Missing value for ${key}`);
      i++;
    }
  }
  const value = (name: string) => {
    try { return optionValue(raw, name); } catch (error) { throw new UsageError((error as Error).message); }
  };
  const format = (value("--format") ?? "markdown") as "markdown" | "json";
  if (!["markdown", "json"].includes(format)) throw new UsageError("--format must be markdown or json");

  if (seen.has("--find-gauge")) {
    const mixed = SIMULATE.filter((name) => seen.has(name));
    if (mixed.length) throw new UsageError(`--find-gauge only looks up gauges; remove ${mixed.join(", ")}`);
    const query = value("--find-gauge")!.trim();
    if (!query) throw new UsageError("--find-gauge needs a non-empty name substring");
    return { mode: "find-gauge", query, format };
  }

  const num = (name: string): number | undefined => {
    const text = value(name);
    if (text === undefined) return undefined;
    const parsed = Number(text);
    if (!text.trim() || !Number.isFinite(parsed) || parsed < 0) throw new UsageError(`${name} must be a finite nonnegative number`);
    return parsed;
  };
  const epoch = value("--epoch") ?? "current";
  const gauge = value("--gauge");
  if (!gauge) throw new UsageError("--gauge is required; use --find-gauge <NAME> to look one up");
  if (!isPublicKey(gauge)) throw new UsageError("--gauge must be a base58 public key");
  if (!/^(current|\d+)$/.test(epoch) || (epoch !== "current" && Number(epoch) > 0xffffffff)) throw new UsageError("--epoch must be current or an epoch number");
  const bids = (value("--bids") ?? "10,20,50,100,150,200,300").split(",").map((part) => part.trim() === "" ? NaN : Number(part.trim()));
  if (!bids.length || bids.some((bid) => !Number.isFinite(bid) || bid <= 0)) throw new UsageError("--bids must be finite positive numbers");
  let revenue: Revenue;
  try {
    revenue = resolveRevenue({
      lamportsPerStakedSol: num("--lamports-per-staked-sol"),
      revenueLamportsPerSolEpoch: num("--revenue-lamports-per-sol-epoch"),
      holdEpochs: num("--hold-epochs"),
      revenueLowLamportsPerSolEpoch: num("--revenue-low-lamports-per-sol-epoch"),
    });
  } catch (error) {
    throw error instanceof UsageError ? error : new UsageError((error as Error).message);
  }
  return {
    mode: "simulate",
    epoch,
    gauge,
    bids,
    currentBid: num("--current-bid"),
    otherBids: num("--other-bids"),
    totalVev: num("--total-vev"),
    totalGaugeVev: num("--total-gauge-vev"),
    matchMultiplier: num("--match-multiplier") ?? 1,
    revenue,
    solUsd: num("--sol-usd"),
    format,
  };
}
