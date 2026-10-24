import { test, expect } from "bun:test";
import { normalizePerformanceRow, renderCsv, renderMarkdown, windowNotes, scaleSegments } from "./performance";

const source = { epoch: 99, validatorId: "fixture-identity", voteId: "fixture-vote" };

test("missing upstream metrics stay unavailable rather than zero stake or 100 percent skipped", () => {
  const row = normalizePerformanceRow({ ...source, leaderSlotsTotal: 10 });
  expect(row).toMatchObject({
    stakeSol: null, voteCredits: null, tvcPctOfMax: null, tvcRank: null,
    leaderSlots: 10, blocksProduced: null, blockProductionPct: null, skipRatePct: null,
    commissionPct: null, mevCommissionPct: null,
  });
  const csvValues = renderCsv([row]).split("\n")[1].split(",");
  expect(csvValues).toEqual(["99", "", "", "", "", "", "10", "", "", "", "", "towerbft", "false"]);
  expect(JSON.parse(JSON.stringify(row)).blocksProduced).toBeNull();
});

test("known zero values remain zero and a verified zero block count can mean 100 percent skipped", () => {
  const row = normalizePerformanceRow({ ...source, tvCredits: 0, totalStake: "0", leaderSlotsTotal: 10, leaderSlotsDone: 0, fee: 0, mevCommission: 0 });
  expect(row).toMatchObject({ stakeSol: 0, voteCredits: 0, tvcPctOfMax: 0, blocksProduced: 0, blockProductionPct: 0, skipRatePct: 100, commissionPct: 0, mevCommissionPct: 0 });
});

test("invalid and null provider values do not become fabricated metrics", () => {
  const row = normalizePerformanceRow({ ...source, totalStake: "bad", tvCredits: Number.NaN, leaderSlotsTotal: 10, leaderSlotsDone: -1, fee: null as never, mevCommission: null as never, skippedSlots: "bad" });
  expect(row).toMatchObject({ stakeSol: null, voteCredits: null, blocksProduced: null, blockProductionPct: null, skipRatePct: null, commissionPct: null, mevCommissionPct: null });
  expect(normalizePerformanceRow({ ...source, totalStake: Number.MAX_SAFE_INTEGER + 1 }).stakeSol).toBeNull();
});

test("upstream skippedSlots is a vote-credit shortfall and never becomes a block skip rate", () => {
  expect(normalizePerformanceRow({ ...source, leaderSlotsTotal: 10, skippedSlots: "0.25" }).skipRatePct).toBeNull();
  // Observed SVT placeholder for an in-progress epoch: no leader slots yet and skippedSlots 1.
  expect(normalizePerformanceRow({ ...source, leaderSlotsTotal: 0, leaderSlotsDone: 0, skippedSlots: 1 }).skipRatePct).toBeNull();
  expect(normalizePerformanceRow({ ...source, leaderSlotsTotal: 0, leaderSlotsDone: 0 }).blockProductionPct).toBeNull();
  expect(normalizePerformanceRow({ ...source, leaderSlotsTotal: 10, leaderSlotsDone: 9, skippedSlots: 0.001 }).skipRatePct).toBe(10);
});

test("an in-progress epoch is marked and excluded from the window summary", () => {
  const completed = normalizePerformanceRow({ ...source, epoch: 98, tvCredits: 6_912_000, tvcRank: 5, leaderSlotsTotal: 10, leaderSlotsDone: 10, fee: 5, mevCommission: 1000 });
  const partial = normalizePerformanceRow({ ...source, tvCredits: 0, tvcRank: 0, leaderSlotsTotal: 0, leaderSlotsDone: 0, fee: 5, mevCommission: 0, skippedSlots: 1 }, true);
  // Upstream's zero credits and leader slots for the in-progress epoch are placeholders.
  expect(partial).toMatchObject({ inProgress: true, voteCredits: null, leaderSlots: null, blocksProduced: null, tvcPctOfMax: null, tvcRank: null, skipRatePct: null, mevCommissionPct: null, commissionPct: 5 });
  // A zero MEV commission in a completed epoch is a real value.
  expect(normalizePerformanceRow({ ...source, mevCommission: 0 }).mevCommissionPct).toBe(0);
  expect(normalizePerformanceRow({ ...source, tvCredits: 1_000, leaderSlotsTotal: 4, leaderSlotsDone: 4 }, true)).toMatchObject({ voteCredits: 1_000, leaderSlots: 4, blocksProduced: 4 });
  const csv = renderCsv([completed, partial]).split("\n").map((line) => line.split(","));
  expect(csv[0].at(-1)).toBe("in_progress");
  expect([csv[1].at(-1), csv[2].at(-1)]).toEqual(["false", "true"]);
  expect(csv[2].slice(2, 7)).toEqual(["", "", "", "", ""]);
  expect(csv[2].slice(9, 11)).toEqual(["5", ""]);
  const output = renderMarkdown({
    voteAccount: "fixture-vote", currentEpoch: 99, currentSlotIndex: 1, slotsInEpoch: 432_000,
    requestedFirstEpoch: 97, firstEpoch: 98, lastEpoch: 99, inProgressEpoch: 99, rows: [completed, partial],
    current: { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null },
  });
  expect(output).toContain("| 99 (in progress) |");
  expect(output).toContain("Window summary (epochs `98-98`)");
  expect(output).toContain("Avg TVC % of max: `100.00%`");
  expect(output).toContain("Avg skip rate: `0.00%`");
  expect(output).toContain("Avg MEV commission: `10.0%`");
  expect(output).toContain("Total vote credits: `6,912,000`");
  expect(output).toContain("returned no rows before epoch `98`, so epochs `97-97` are unavailable");
  expect(windowNotes({ firstEpoch: 98, lastEpoch: 99 })).toEqual([]);
  // A window with no completed epoch has no totals; it must not print totals of zero.
  const onlyPartial = renderMarkdown({
    voteAccount: "fixture-vote", currentEpoch: 99, currentSlotIndex: 1, slotsInEpoch: 432_000,
    firstEpoch: 99, lastEpoch: 99, inProgressEpoch: 99, rows: [partial],
    current: { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null },
  });
  expect(onlyPartial).toContain("Window summary (no completed epochs in the window):");
  expect(onlyPartial).toContain("Total vote credits: `—`");
  expect(onlyPartial).toContain("Block production: `— / —`");
});

test("markdown shows missing fields and does not present partial window sums as totals", () => {
  const missing = normalizePerformanceRow({ ...source, leaderSlotsTotal: 10 });
  const known = normalizePerformanceRow({ ...source, epoch: 98, tvCredits: 100, leaderSlotsTotal: 10, leaderSlotsDone: 9 });
  const output = renderMarkdown({
    voteAccount: "fixture-vote", currentEpoch: 100, currentSlotIndex: 1, slotsInEpoch: 432_000,
    firstEpoch: 98, lastEpoch: 99, rows: [known, missing],
    current: { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null },
  });
  expect(output).toContain("| 99 | TowerBFT | — | — | — | — | —/10 | — | — | — | — |");
  expect(output).toContain("Total vote credits: `—`");
  expect(output).toContain("Block production: `— / 20`");
  expect(output).toContain("Averages use available epochs");
  expect(output).not.toContain("100.00%");
});

const status = { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null };
const markdownFor = (rows: ReturnType<typeof normalizePerformanceRow>[], extra: Record<string, unknown> = {}) => renderMarkdown({
  voteAccount: "fixture-vote", currentEpoch: rows.at(-1)!.epoch + 1, currentSlotIndex: 1, slotsInEpoch: 432_000,
  firstEpoch: rows[0].epoch, lastEpoch: rows.at(-1)!.epoch, rows, current: status, ...extra,
});

test("TowerBFT epochs keep the 16-credits-per-slot maximum and the upstream rank", () => {
  const row = normalizePerformanceRow({ ...source, epoch: 1063, tvCredits: 6_904_768, tvcRank: 355, creditsRatio: 0.5 });
  expect(row.creditScale).toBe("towerbft");
  expect(row.tvcPctOfMax).toBeCloseTo((6_904_768 / (432_000 * 16)) * 100, 10);
  expect(row.tvcRank).toBe(355);
});

test("Alpenglow epochs use creditsRatio, not 16 credits per slot", () => {
  // Observed R2D2 epoch 1065 values: lamport-scale credits that 16 credits per slot would put at ~232,000%.
  const row = normalizePerformanceRow({ ...source, epoch: 1065, tvCredits: "16032932459" as never, tvcRank: 506, creditsRatio: 0.9745399, leaderSlotsTotal: 108, leaderSlotsDone: 105 });
  expect(row).toMatchObject({ creditScale: "alpenglow", voteCredits: 16_032_932_459, tvcRank: 506 });
  expect(row.tvcPctOfMax).toBeCloseTo(97.45399, 6);
  // Without a published ratio there is neither a percentage nor a rank on that basis.
  expect(normalizePerformanceRow({ ...source, epoch: 1065, tvCredits: 1, tvcRank: 506, creditsRatio: null })).toMatchObject({ tvcPctOfMax: null, tvcRank: null });
  expect(normalizePerformanceRow({ ...source, epoch: 1065, tvCredits: 1, tvcRank: 506 })).toMatchObject({ tvcPctOfMax: null, tvcRank: null });
  expect(normalizePerformanceRow({ ...source, epoch: 1065, creditsRatio: -1 }).tvcPctOfMax).toBeNull();
  // An in-progress Alpenglow epoch has no ratio yet.
  expect(normalizePerformanceRow({ ...source, epoch: 1066, tvCredits: 0, tvcRank: 0, creditsRatio: null }, true)).toMatchObject({ creditScale: "alpenglow", voteCredits: null, tvcPctOfMax: null, tvcRank: null });
  const csv = renderCsv([row]).split("\n").map((line) => line.split(","));
  expect(csv[0].slice(-2)).toEqual(["credit_scale", "in_progress"]);
  expect(csv[1].slice(2, 5)).toEqual(["16032932459", "97.4540", "506"]);
  expect(csv[1].slice(-2)).toEqual(["alpenglow", "false"]);
  expect(JSON.parse(JSON.stringify(normalizePerformanceRow({ ...source, epoch: 1065 }))).tvcPctOfMax).toBeNull();
});

test("a window straddling Alpenglow never sums or averages credits across scales", () => {
  const rows = [
    normalizePerformanceRow({ ...source, epoch: 1062, tvCredits: 6_912_000, tvcRank: 1 }),
    normalizePerformanceRow({ ...source, epoch: 1063, tvCredits: 3_456_000, tvcRank: 2 }),
    normalizePerformanceRow({ ...source, epoch: 1064, tvCredits: 18_000_000_000, tvcRank: 3, creditsRatio: 0.99 }),
    normalizePerformanceRow({ ...source, epoch: 1065, tvCredits: 16_000_000_000, tvcRank: 4, creditsRatio: 0.97 }),
  ];
  expect(scaleSegments(rows).map((s) => [s.scale, s.firstEpoch, s.lastEpoch])).toEqual([["towerbft", 1062, 1063], ["alpenglow", 1064, 1065]]);
  const output = markdownFor(rows);
  expect(output).toContain("| 1064 | Alpenglow |");
  expect(output).toContain("| 1063 | TowerBFT |");
  expect(output).toContain("- Total vote credits (TowerBFT, epochs `1062-1063`): `10,368,000`");
  expect(output).toContain("- Avg TVC % of max (TowerBFT, epochs `1062-1063`): `75.00%`");
  expect(output).toContain("- Total vote credits (Alpenglow, epochs `1064-1065`): `34,000,000,000` lamports of nominal vote reward");
  expect(output).toContain("- Avg TVC % of max (Alpenglow, epochs `1064-1065`): `98.00%`");
  expect(output).not.toContain("- Total vote credits: ");
  expect(output).not.toContain("- Avg TVC % of max: ");
  expect(output).toContain("Epoch `1064` is the migration epoch");
  expect(output).toContain("JPool/SVT `creditsRatio`");
  // Scale-independent metrics still cover the whole window.
  expect(output).toContain("Window summary (epochs `1062-1065`)");
});

test("Alpenglow notes appear only when the window reaches Alpenglow", () => {
  expect(windowNotes({ firstEpoch: 1000, lastEpoch: 1063 })).toEqual([]);
  const after = windowNotes({ firstEpoch: 1065, lastEpoch: 1066 });
  expect(after).toHaveLength(1);
  expect(after[0]).toContain("not comparable with earlier TowerBFT credits");
  expect(windowNotes({ firstEpoch: 1060, lastEpoch: 1064 })).toHaveLength(2);
  const onlyAlpenglow = markdownFor([normalizePerformanceRow({ ...source, epoch: 1065, tvCredits: 5, creditsRatio: 0.5 })]);
  expect(onlyAlpenglow).toContain("- Avg TVC % of max (Alpenglow, epochs `1065-1065`): `50.00%`");
  expect(onlyAlpenglow).not.toContain("migration epoch");
});
